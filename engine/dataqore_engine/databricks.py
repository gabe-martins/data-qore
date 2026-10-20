"""Optional Unity Catalog SQL Warehouse adapter. No SDK imports at module load."""
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal
import importlib
import json
import logging
import re

from .core.db_adapters import DatabaseAdapter, _column
from .core.quality import type_family
from .storage import DomainError


def bound_sql(sql, parameters):
    """Keep native binding; use explicit casts for precision and timestamp semantics."""
    output,values=[],[]
    quoted=None;i=0;position=0
    while i<len(sql):
        c=sql[i]
        if quoted:
            output.append(c)
            if c==quoted:
                if i+1<len(sql) and sql[i+1]==quoted:output.append(sql[i+1]);i+=1
                else:quoted=None
        elif c in "'`\"":quoted=c;output.append(c)
        elif c=='?':
            value=parameters[position];position+=1;marker='?'
            if isinstance(value,Decimal):
                if not value.is_finite():raise ValueError('Nonfinite parameter')
                digits=value.as_tuple();scale=max(0,-digits.exponent)
                precision=max(1,len(digits.digits)+max(0,digits.exponent),scale)
                if precision>38:raise DomainError(422,'source_numeric_precision_unsupported','Databricks decimal parameters support at most 38 digits.')
                marker=f'CAST(? AS DECIMAL({precision},{scale}))';value=format(value,'f')
            elif isinstance(value,(bytes,bytearray,memoryview)):
                marker='unhex(?)';value=bytes(value).hex()
            elif isinstance(value,datetime):
                if value.tzinfo is not None:
                    marker='CAST(? AS TIMESTAMP)';value=value.astimezone(timezone.utc).isoformat()
                else:marker='CAST(? AS TIMESTAMP_NTZ)';value=value.isoformat()
            elif isinstance(value,date):marker='CAST(? AS DATE)';value=value.isoformat()
            output.append(marker);values.append(value)
        else:output.append(c)
        i+=1
    if position!=len(parameters):raise ValueError('Parameter count mismatch')
    return ''.join(output),values


class Cursor:
    def __init__(self,cursor):self.native=cursor
    def execute(self,sql,parameters=None):
        if parameters is None:return self.native.execute(sql)
        sql,parameters=bound_sql(sql,parameters)
        return self.native.execute(sql,parameters=parameters)
    def __getattr__(self,name):return getattr(self.native,name)


class Connection:
    def __init__(self,native):self.native=native
    def cursor(self):return Cursor(self.native.cursor())
    def close(self):return self.native.close()


def oauth_credentials(credentials):
    # The SDK's refresh/cache is reused, while the token exchange has an explicit
    # timeout. SDK 0.154's default OAuth POST does not set a network timeout.
    try:oauth=importlib.import_module('databricks.sdk.oauth')
    except ImportError:raise DomainError(503,'driver_unavailable','Install the Databricks SDK to use OAuth M2M.') from None
    requests=importlib.import_module('requests')
    class BoundedTokenSource(oauth.Refreshable):
        def refresh(self):
            response=requests.post('https://'+credentials['hostname']+'/oidc/v1/token',
                data={'grant_type':'client_credentials','scope':'all-apis'},
                auth=(credentials['client_id'],credentials['client_secret']),timeout=10,allow_redirects=False)
            try:
                if response.status_code>=300:
                    code='authentication_failed' if response.status_code in (400,401) else 'permission_denied' if response.status_code==403 else 'unavailable'
                    raise DomainError(503,'source_databricks_'+code,'Databricks OAuth authentication failed. Check the service principal and workspace.')
                body=response.json()
                return oauth.Token(access_token=body['access_token'],token_type='Bearer',
                    expiry=datetime.now()+timedelta(seconds=int(body['expires_in'])))
            finally:response.close()
    source=BoundedTokenSource(disable_async=True)
    def provider():
        def headers():
            token=source.token()
            return {'Authorization':f'{token.token_type} {token.access_token}'}
        return headers
    return provider


def connect(credentials):
    logger=logging.getLogger('databricks')
    if not logger.handlers:logger.addHandler(logging.NullHandler())
    logger.propagate=False
    driver=importlib.import_module('databricks.sql')
    options=dict(server_hostname=credentials['hostname'],http_path=credentials['http_path'],
        _socket_timeout=10,_retry_stop_after_attempts_count=1,use_cloud_fetch=False,
        session_configuration={'TIMEZONE':'UTC','STATEMENT_TIMEOUT':'30'},user_agent_entry='DataQore')
    if credentials['auth_type']=='pat':options['access_token']=credentials['access_token']
    else:options['credentials_provider']=oauth_credentials(credentials)
    return Connection(driver.connect(**options))


class DatabricksAdapter(DatabaseAdapter):
    def __init__(self,catalog=''):
        super().__init__('databricks');self.catalog=catalog
        # An adapter belongs to one source operation/session, never a global cache.
        self._details={}
    def quote_identifier(self,value):
        value=str(value)
        if not value or '\x00' in value:raise ValueError('Invalid identifier')
        return '`'+value.replace('`','``')+'`'
    def qualified_name(self,schema,table):
        if not self.catalog or not schema:raise DomainError(422,'catalog_required','Select a catalog and schema.')
        return '.'.join(self.quote_identifier(v) for v in (self.catalog,schema,table))
    def _bound_table(self,schema,table):return self.qualified_name(schema,table)
    def _query(self,conn,sql,parameters=None):
        cursor=conn.cursor()
        try:
            cursor.execute(sql,parameters) if parameters is not None else cursor.execute(sql)
            return cursor.fetchall()
        finally:cursor.close()
    def catalogs(self,conn):
        return sorted(str(r[0]) for r in self._query(conn,'SHOW CATALOGS') if r[0] != 'hive_metastore')
    def schemas(self,conn):
        if not self.catalog:raise DomainError(422,'catalog_required','Select a catalog.')
        return [r[0] for r in self._query(conn,f'SELECT schema_name FROM {self.quote_identifier(self.catalog)}.information_schema.schemata WHERE catalog_name = ? AND schema_name <> ? ORDER BY schema_name',[self.catalog,'information_schema'])]
    def objects(self,conn,schema):
        if not self.catalog or not schema:raise DomainError(422,'catalog_required','Select a catalog and schema.')
        return [(r[0],r[1],r[2]) for r in self._query(conn,f'''SELECT table_schema,table_name,table_type
            FROM {self.quote_identifier(self.catalog)}.information_schema.tables
            WHERE table_catalog = ? AND table_schema = ? AND table_type IN ('MANAGED','EXTERNAL','MANAGED_SHALLOW_CLONE','EXTERNAL_SHALLOW_CLONE','VIEW')
            ORDER BY table_name''',[self.catalog,schema])]
    def list_tables(self,conn,schema=None):
        schemas=[schema] if schema else self.schemas(conn)
        return [(sch,name) for s in schemas for sch,name,_ in self.objects(conn,s)]
    def metadata(self,conn,schema,table):
        rows=self._query(conn,f'''SELECT column_name,full_data_type,is_nullable,numeric_precision,numeric_scale
            FROM {self.quote_identifier(self.catalog)}.information_schema.columns
            WHERE table_catalog=? AND table_schema=? AND table_name=? ORDER BY ordinal_position''',[self.catalog,schema,table])
        columns={}
        for name,kind,nullable,precision,scale in rows:
            kind=kind.lower();family='text' if kind=='string' else type_family(kind)
            unsupported=kind.startswith(('array','map','struct','variant','interval')) or family not in {'text','binary','integer','decimal','float','boolean','date','datetime'}
            columns[name]=_column(kind,nullable=='YES',family=family,precision=precision,scale=scale,
                datetime_precision=6 if family=='datetime' else None,
                timestamp_kind='aware' if kind in {'timestamp','timestamp_ltz'} else 'naive' if kind=='timestamp_ntz' else None,
                **({'comparison_timezone':'UTC'} if kind in {'timestamp','timestamp_ltz'} else {}),
                **({'unsupported_reason':f'Databricks {kind} is unavailable for bounded comparison'} if unsupported else {}))
        constraints=self._query(conn,f'''SELECT tc.constraint_name,tc.constraint_type,ku.column_name,ku.ordinal_position
            FROM {self.quote_identifier(self.catalog)}.information_schema.table_constraints tc
            JOIN {self.quote_identifier(self.catalog)}.information_schema.key_column_usage ku
              ON tc.constraint_catalog=ku.constraint_catalog AND tc.constraint_schema=ku.constraint_schema AND tc.constraint_name=ku.constraint_name
            WHERE tc.table_catalog=? AND tc.table_schema=? AND tc.table_name=? AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
            ORDER BY tc.constraint_name,ku.ordinal_position''',[self.catalog,schema,table])
        self._apply_constraints(columns,constraints)
        for info in columns.values():info['constraints_enforced']=False
        return columns
    def table_details(self,conn,schema,table):
        key=(schema,table)
        if key in self._details:return self._details[key]
        details={'collected_at':datetime.now(timezone.utc).isoformat(),
            'estimated_rows':None,'estimate_source':None,'estimate_status':'missing',
            'scope':'whole_table','status':'available'}
        try:
            rows=self._query(conn,f'DESCRIBE TABLE EXTENDED {self.qualified_name(schema,table)} AS JSON')
        except Exception as error:
            code=getattr(error,'sqlstate',None) or getattr(error,'sql_state',None)
            if code not in {'42601','0A000'} and not re.search(r'SQLSTATE:\s*(42601|0A000)\b',str(error)):
                raise
            details.update(status='unsupported',estimate_status='unsupported')
        else:
            try:
                body=json.loads(rows[0][0])
                if not isinstance(body,dict):raise ValueError
            except (ValueError,TypeError,IndexError):
                details.update(status='invalid',estimate_status='invalid')
            else:
                stats=body.get('statistics')
                stats=stats if isinstance(stats,dict) else {}
                count=stats.get('num_rows')
                if type(count) is int and count>=0:
                    details.update(estimated_rows=count,estimate_source='databricks_optimizer_statistics',estimate_status='available')
                elif count is not None:details['estimate_status']='invalid'
                size=stats.get('size_in_bytes')
                if type(size) is int and size>=0:details['size_in_bytes']=size
                for name in ('type','provider'):
                    if isinstance(body.get(name),str):details[name]=body[name]
                created=body.get('created_time')
                if isinstance(created,str):
                    try:details['created_time']=datetime.fromisoformat(created.replace('Z','+00:00')).isoformat()
                    except ValueError:pass
                partitions=body.get('partition_columns')
                if isinstance(partitions,list) and all(isinstance(v,str) for v in partitions):
                    details['partition_columns']=partitions
        self._details[key]=details
        return details
    def estimate_rows(self,conn,schema,table):
        return self.table_details(conn,schema,table)['estimated_rows']
    def _size_expression(self,quoted,kind,info):
        return f'octet_length({quoted})' if info.get('family') in {'text','binary'} else None
