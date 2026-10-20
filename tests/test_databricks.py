"""Databricks contracts use the real SDK API and simulated read-only sources."""
from datetime import date,datetime,timezone,timedelta
from decimal import Decimal
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import MagicMock,patch
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import select
from postgres_fixture import TemporaryPostgres
from dataqore_engine import models as m
from dataqore_engine.api import create_app
from dataqore_engine.connectors import SourceManager,PLUGINS,Plugin,driver_available,source_failure
from dataqore_engine.databricks import DatabricksAdapter,Connection,bound_sql,connect
from dataqore_engine.schemas import DatabricksCredentials,ConnectionTest
from dataqore_engine.jobs import Queue,run_job
from test_api import settings
from databricks_stub import NativeConnection

PAT={'hostname':'workspace.example.test','http_path':'/sql/1.0/warehouses/test','auth_type':'pat','access_token':'PRIVATE_PAT'}
OAUTH={**{k:v for k,v in PAT.items() if k!='access_token'},'auth_type':'oauth_m2m','client_id':'client-id','client_secret':'PRIVATE_SECRET'}


class DatabricksContractTests(unittest.TestCase):
    def test_credentials_encryption_modes_and_redaction(self):
        manager=SourceManager(settings())
        for payload in (PAT,OAUTH):
            creds=DatabricksCredentials(**payload)
            ciphertext=manager.encrypt('databricks',creds)
            self.assertNotIn('PRIVATE',ciphertext);self.assertNotIn('PRIVATE',repr(creds))
            row={'credentials_ciphertext':ciphertext,'encryption_key_version':'v1'}
            self.assertEqual(manager.decrypt(row),creds.model_dump(mode='json') | {k:v for k,v in payload.items() if k in ('access_token','client_secret')})
        for payload in ({**PAT,'hostname':'https://bad'},{**PAT,'http_path':'/cluster/test'},
                        {**PAT,'client_secret':'wrong'},{**OAUTH,'client_secret':''}):
            with self.assertRaises(ValueError):ConnectionTest(connector='databricks',credentials=payload)
        with patch('dataqore_engine.connectors.importlib.util.find_spec',side_effect=ModuleNotFoundError):
            self.assertFalse(driver_available('databricks.sql'))

    def test_official_driver_pat_oauth_provider_and_bounded_connection(self):
        import databricks.sql
        import databricks.sdk.core as core
        native=MagicMock()
        with patch.object(databricks.sql,'connect',return_value=native) as driver:
            connect(PAT).close()
            call=driver.call_args.kwargs
            self.assertEqual(call['access_token'],'PRIVATE_PAT')
            self.assertEqual(call['_socket_timeout'],10)
            self.assertEqual(call['_retry_stop_after_attempts_count'],1)
            self.assertEqual(call['session_configuration'],{'TIMEZONE':'UTC','STATEMENT_TIMEOUT':'30'})
            self.assertFalse(call['use_cloud_fetch']);native.close.assert_called_once()
        import requests
        from databricks.sdk import oauth
        response=MagicMock(status_code=200);response.json.side_effect=[{'access_token':'FIRST','expires_in':3600},{'access_token':'RENEWED','expires_in':3600}]
        with patch.object(requests,'post',return_value=response) as exchange,patch.object(databricks.sql,'connect') as driver:
            connect(OAUTH)
            headers=driver.call_args.kwargs['credentials_provider']()
            self.assertEqual(headers()['Authorization'],'Bearer FIRST')
            self.assertEqual(headers()['Authorization'],'Bearer FIRST');self.assertEqual(exchange.call_count,1)
            with patch.object(oauth.Refreshable,'_now',return_value=datetime.now()+timedelta(hours=2)):
                self.assertEqual(headers()['Authorization'],'Bearer RENEWED')
            self.assertEqual(exchange.call_count,2);self.assertEqual(exchange.call_args.kwargs['timeout'],10)
            self.assertFalse(exchange.call_args.kwargs['allow_redirects']);self.assertEqual(response.close.call_count,2)

    def test_native_parameters_preserve_precision_binary_and_timestamp_kind(self):
        sql,values=bound_sql("SELECT `weird?name` FROM `a` WHERE x=? AND y=? AND z=? AND n=? AND d=?",[
            Decimal('-0.000001234567890123456789'),b'\x00\xff',datetime(2026,10,1,tzinfo=timezone.utc),datetime(2026,10,1),date(2026,10,1)])
        self.assertIn('DECIMAL(24,24)',sql)
        self.assertEqual(values[0],'-0.000001234567890123456789')
        self.assertEqual(values[1],'00ff');self.assertIn('unhex(?)',sql)
        self.assertIn('CAST(? AS TIMESTAMP_NTZ)',sql);self.assertIn('CAST(? AS TIMESTAMP)',sql)
        with self.assertRaises(Exception):bound_sql('SELECT ?', [Decimal('1e50')])
        sql,values=bound_sql('SELECT ?', [Decimal('1e-20')]);self.assertEqual(values,['0.00000000000000000001'])

    def test_table_details_statistics_are_cached_allowlisted_and_zero_is_valid(self):
        body={'type':'MANAGED','provider':'delta','statistics':{'num_rows':40000,'size_in_bytes':313604},
              'created_time':'2026-09-27T01:48:51Z','partition_columns':[],
              'location':'PRIVATE_PATH','view_text':'PRIVATE_SQL','table_properties':{'password':'PRIVATE'}}
        adapter=DatabricksAdapter('c`at');conn=MagicMock()
        conn.cursor.return_value.fetchall.return_value=[(json.dumps(body),)]
        self.assertEqual(adapter.estimate_rows(conn,'s','t'),40000)
        details=adapter.table_details(conn,'s','t')
        self.assertEqual(details['size_in_bytes'],313604)
        self.assertEqual(details['partition_columns'],[])
        self.assertEqual(details['estimate_source'],'databricks_optimizer_statistics')
        self.assertNotIn('PRIVATE',json.dumps(details))
        conn.cursor.return_value.execute.assert_called_once_with('DESCRIBE TABLE EXTENDED `c``at`.`s`.`t` AS JSON')
        conn.cursor.return_value.close.assert_called_once()
        for value,expected,status in [(0,0,'available'),(None,None,'missing'),(-1,None,'invalid'),('40000',None,'invalid'),(True,None,'invalid'),(1.5,None,'invalid')]:
            adapter=DatabricksAdapter('main')
            with patch.object(adapter,'_query',return_value=[(json.dumps({'statistics':{'num_rows':value}}),)]):
                self.assertEqual(adapter.estimate_rows(conn,'s','t'),expected)
                self.assertEqual(adapter.table_details(conn,'s','t')['estimate_status'],status)

    def test_extended_details_missing_views_invalid_json_and_unsupported_commands(self):
        for payload,status in [(json.dumps({'type':'VIEW'}),'missing'),('not json','invalid'),('[]','invalid')]:
            adapter=DatabricksAdapter('main')
            with patch.object(adapter,'_query',return_value=[(payload,)]):
                self.assertIsNone(adapter.estimate_rows(MagicMock(),'s','v'))
                self.assertEqual(adapter.table_details(MagicMock(),'s','v')['estimate_status'],status)
        for code in ['42601','0A000']:
            error=RuntimeError('Unsupported AS JSON SQLSTATE: '+code)
            adapter=DatabricksAdapter('main')
            with patch.object(adapter,'_query',side_effect=error) as query:
                self.assertIsNone(adapter.estimate_rows(MagicMock(),'s','t'))
                self.assertEqual(adapter.table_details(MagicMock(),'s','t')['status'],'unsupported')
                self.assertEqual(query.call_count,1)
        for message in ['timeout','authentication failed','permission denied SQLSTATE: 42501','table missing SQLSTATE: 42P01']:
            adapter=DatabricksAdapter('main');conn=MagicMock()
            conn.cursor.return_value.execute.side_effect=RuntimeError(message)
            with self.assertRaises(RuntimeError):adapter.estimate_rows(conn,'s','t')
            conn.cursor.return_value.close.assert_called_once()

    def test_published_estimate_plans_within_sampling_limits(self):
        from dataqore_engine.core.profile_engine import execute_profile
        from dataqore_engine.core.sampling import SamplingOptions
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'source.sqlite'
            with sqlite3.connect(path) as conn:
                conn.execute('CREATE TABLE records(id integer,amount numeric,status text)')
                conn.executemany('INSERT INTO records VALUES(?,?,?)',[(n,n,'value') for n in range(1100)])
            native=NativeConnection(path);self.addCleanup(native.close)
            adapter=DatabricksAdapter('main')
            details={'collected_at':'2026-10-20T00:00:00+00:00','estimated_rows':40000,'estimate_source':'databricks_optimizer_statistics','estimate_status':'available','scope':'whole_table','status':'available'}
            adapter._details[('sales','records')]=details
            result=execute_profile({'conn':Connection(native),'connection':'test','creds':{'type':'databricks'},'schema':'sales','table':'records','catalog_name':'main','adapter':adapter})
            self.assertEqual(result['sources'][0]['estimated_rows'],40000)
            self.assertEqual(result['sources'][0]['sample_size'],1000)
            self.assertEqual(result['sources'][0]['table_details'],details)
            self.assertNotIn('sample_rows',json.dumps(result,default=str))
            self.assertFalse(any('COUNT(' in q['sql'].upper() or 'ANALYZE ' in q['sql'].upper() for q in result['query_log']))

    def test_timestamp_semantics_complex_types_and_resource_cleanup(self):
        from dataqore_engine.comparison_options import _temporal_kind
        adapter=DatabricksAdapter('main')
        rows=[('instant','TIMESTAMP','YES',None,None),('wall','TIMESTAMP_NTZ','YES',None,None),
              ('nested','STRUCT<a:INT>','YES',None,None),('label','STRING','YES',None,None)]
        with patch.object(adapter,'_query',side_effect=[rows,[]]) as query:
            columns=adapter.metadata(MagicMock(),'s','t')
            self.assertIn('table_catalog=?',query.call_args_list[0].args[1])
            self.assertEqual(query.call_args_list[0].args[2],['main','s','t'])
        self.assertEqual(_temporal_kind(columns['instant']),'aware')
        self.assertEqual(_temporal_kind(columns['wall']),'naive')
        self.assertIn('unsupported_reason',columns['nested'])
        projection,_,unavailable=adapter._projection(columns,columns)
        self.assertIn("'+00:00'",projection);self.assertIn('NULL AS `nested`',projection)
        self.assertIn(2,unavailable)
        manager=SourceManager(settings());native=MagicMock();native.cursor.return_value.execute.side_effect=RuntimeError('PRIVATE_PAT driver failure')
        row={'connector':'databricks','name':'safe','is_active':True,'encryption_key_version':'v1',
             'credentials_ciphertext':manager.encrypt('databricks',DatabricksCredentials(**PAT))}
        with patch.dict(PLUGINS,databricks=Plugin('sqlite3',lambda creds:Connection(native))):
            with self.assertRaises(Exception) as error:manager.test(row)
        native.close.assert_called_once();self.assertNotIn('PRIVATE',str(error.exception))

    def test_catalog_identifiers_filters_sampling_and_failure_sanitization(self):
        from dataqore_engine.core.db_adapters import TextCriterion
        adapter=DatabricksAdapter('cat`alog')
        self.assertEqual(adapter.qualified_name('a.b','t`able'),'`cat``alog`.`a.b`.`t``able`')
        sql,params=adapter._scope_sql([('status','eq',[TextCriterion('SecretValue')])])
        self.assertIn('encode(',sql);self.assertNotIn('SecretValue',sql);self.assertEqual(params,['SecretValue'])
        conn=MagicMock();cursor=conn.cursor.return_value;cursor.fetchmany.return_value=[]
        adapter.fetch_keys(conn,'s','t',['id','status'],['id'],[(1,),(2,)],scope=[('status','eq',[TextCriterion('A')])])
        sql=cursor.execute.call_args.args[0]
        self.assertIn(' AND ((',sql);self.assertIn(' OR ',sql)
        for error in (RuntimeError('PRIVATE_PAT timeout'),RuntimeError('PRIVATE_SECRET unauthorized')):
            failure=source_failure('databricks',error)
            self.assertNotIn('PRIVATE',str(failure)+failure.message)
            self.assertTrue(failure.code.startswith('source_databricks_'))

    def test_catalog_and_schema_access_errors_explain_missing_privilege(self):
        for privilege,reason in [('USE CATALOG','catalog_access_denied'),('USE SCHEMA','schema_access_denied')]:
            error=RuntimeError(f'[INSUFFICIENT_PERMISSIONS] User does not have {privilege} on PRIVATE_OBJECT. SQLSTATE: 42501; PRIVATE_PAT')
            failure=source_failure('databricks',error)
            self.assertEqual(failure.code,'source_databricks_'+reason)
            self.assertIn(privilege,failure.message)
            self.assertNotIn('PRIVATE',failure.message)
        failure=source_failure('databricks',RuntimeError('[INSUFFICIENT_PERMISSIONS] Insufficient privileges: SELECT SQLSTATE: 42501'))
        self.assertEqual(failure.code,'source_databricks_permission_denied')


@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN'),'Disposable PostgreSQL required')
class DatabricksAPITests(TemporaryPostgres):
    def setUp(self):
        super().setUp();self.command('engine','baseline');self.command('engine','apply')
        self.files=tempfile.TemporaryDirectory();self.addCleanup(self.files.cleanup)
        self.root=Path(self.files.name)
        with sqlite3.connect(self.root/'source.sqlite') as c:
            c.execute('CREATE TABLE records(id integer PRIMARY KEY,amount numeric,status text)')
            c.executemany('INSERT INTO records VALUES(?,?,?)',[(1,10,'paid'),(2,20,'pending')])
            c.execute('CREATE VIEW records_view AS SELECT * FROM records')
        self.settings=settings(f'postgresql+psycopg://srv_dataqore_engine@127.0.0.1:{self.port}/dataqore_engine',self.root)
        self.app=create_app(self.settings);self.client=TestClient(self.app)
        self.client.__enter__();self.addCleanup(self.client.__exit__,None,None,None)
        mock=patch.dict(PLUGINS,databricks=Plugin('sqlite3',lambda creds:Connection(NativeConnection(self.root/'source.sqlite'))));mock.start();self.addCleanup(mock.stop)
        self.queue=Queue(self.app.state.engine)
    def request(self,method,path,status=200,**kw):
        r=self.client.request(method,'/v1'+path,headers={'X-API-Key':self.settings.api_key},**kw)
        self.assertEqual(r.status_code,status,r.text);return r.json()
    def finish(self,run):
        self.assertEqual(str(self.queue.claim()),run['id']);run_job(self.settings,UUID(run['id']))
        return self.request('GET',f"/runs/{run['id']}/result")
    def test_catalog_profile_comparison_and_identity(self):
        row=self.request('POST','/connections',201,json={'name':'Unity','connector':'databricks','credentials':PAT})
        self.assertNotIn('PRIVATE',json.dumps(row));cid=row['id']
        self.request('POST',f'/connections/{cid}/test')
        self.assertEqual(self.request('GET',f'/connections/{cid}/catalogs',params={'limit':1})['items'],['main'])
        self.request('GET',f'/connections/{cid}/schemas',422)
        self.assertEqual(self.request('GET',f'/connections/{cid}/schemas',params={'catalog':'main'})['items'],['sales'])
        objects=self.request('GET',f'/connections/{cid}/tables',params={'catalog':'main','schema':'sales'})['items']
        self.assertEqual(objects[1]['table_type'],'VIEW')
        datasets=[]
        for catalog in ('main','other'):
            datasets.append(self.request('POST','/datasets',201,json={'connection_id':cid,'catalog_name':catalog,'schema_name':'sales','table_name':'records'}))
        self.assertEqual(datasets[0]['metadata']['estimated_rows'],2)
        self.assertEqual(datasets[0]['metadata']['table_details']['provider'],'delta')
        self.assertNotEqual(datasets[0]['id'],datasets[1]['id'])
        self.request('POST','/datasets',409,json={'connection_id':cid,'catalog_name':'main','schema_name':'sales','table_name':'records'})
        self.request('POST','/datasets',422,json={'connection_id':cid,'schema_name':'sales','table_name':'records'})
        run=self.request('POST',f"/datasets/{datasets[0]['id']}/profile-runs",202,json={})
        result=self.finish(run);self.assertEqual(result['result']['sources'][0]['catalog_name'],'main')
        self.assertEqual(result['result']['sources'][0]['table_details']['estimated_rows'],2)
        stored=self.request('GET',f"/datasets/{datasets[0]['id']}")
        self.assertEqual(stored['metadata']['table_details'],result['result']['sources'][0]['table_details'])
        definition=self.request('POST','/comparisons',201,json={'name':'Unity compare','left_dataset_id':datasets[0]['id'],'right_dataset_id':datasets[1]['id']})
        run=self.request('POST',f"/comparisons/{definition['id']}/runs",202,json={})
        result=self.finish(run)['result'];self.assertEqual(result['format_version'],5)
        self.assertTrue(all(k['valid'] for k in result['key_validation']))
        self.assertEqual(result['sources'][1]['table'],'other.sales.records')
        self.assertEqual(result['summary']['status'],'compatible_in_sample')
        self.assertTrue(any('snapshot' in x.lower() for x in result['warnings']))
        self.request('PATCH',f"/comparisons/{definition['id']}",json={'comparison_options':{
            'business_key':[{'left':'id','right':'id'}],
            'scope':{'filters':[{'left':'id','right':'id','operator':'gte','value':'1'}]}}})
        # Declared PK is informational: duplicate outside the pilot must stop alignment.
        with sqlite3.connect(self.root/'source.sqlite') as c:
            c.execute('DROP VIEW records_view');c.execute('ALTER TABLE records RENAME TO old')
            c.execute('CREATE TABLE records(id integer,amount numeric,status text)')
            c.executemany('INSERT INTO records VALUES(?,?,?)',[(1,10,'paid'),(2,20,'pending'),(2,999,'hidden')])
        result=self.finish(self.request('POST',f"/comparisons/{definition['id']}/runs",202,json={}))['result']
        self.assertEqual(result['summary']['status'],'inconclusive');self.assertEqual(result['row_comparisons'],[])
        self.assertFalse(result['key_validation'][0]['valid'])

    def test_migration_preserves_legacy_catalog_identity_and_grants(self):
        self.command('engine','verify');self.command('engine','apply');self.command('engine','verify')
        with self.connect('engine','srv_dataqore_engine') as c:
            with self.assertRaises(Exception):c.execute('ALTER TABLE engine.datasets ADD COLUMN forbidden text')
        with self.connect('engine') as c:
            self.assertEqual(c.execute("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='engine.datasets'::regclass").fetchone()[0],'dataqore_engine_owner')

    def test_failed_profile_does_not_publish_metadata_or_partial_evidence(self):
        row=self.request('POST','/connections',201,json={'name':'Unity','connector':'databricks','credentials':PAT})
        dataset=self.request('POST','/datasets',201,json={'connection_id':row['id'],'catalog_name':'main','schema_name':'sales','table_name':'records'})
        run=self.request('POST',f"/datasets/{dataset['id']}/profile-runs",202,json={})
        partition=datetime.now(timezone.utc).strftime('metrics_%Y_%m')
        with self.connect('engine') as conn:conn.execute(f'ALTER TABLE engine.metrics DETACH PARTITION engine.{partition}')
        self.queue.claim();run_job(self.settings,UUID(run['id']))
        self.assertEqual(self.request('GET',f"/runs/{run['id']}")['status'],'failed')
        self.assertEqual(self.request('GET',f"/datasets/{dataset['id']}")['metadata'],dataset['metadata'])
        from sqlalchemy import func
        with self.app.state.engine.connect() as conn:
            for table in (m.run_results,m.column_profiles,m.metrics):
                self.assertEqual(conn.scalar(select(func.count()).select_from(table).where(table.c.run_id==UUID(run['id']))),0)
