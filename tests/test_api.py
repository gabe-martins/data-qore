"""API, fontes e worker com Postgres descartável e SQLite controlado."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime,timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import MagicMock,patch
from uuid import UUID

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
import psycopg
from sqlalchemy import event,func,select
from sqlalchemy.exc import IntegrityError

from postgres_fixture import TemporaryPostgres
from dataqore_engine.api import create_app
from dataqore_engine import models as m
from dataqore_engine.connectors import SourceManager,prepare_read_session,odbc_value,source_failure
from dataqore_engine.jobs import Queue,run_job
from dataqore_engine.settings import Settings
from dataqore_engine.storage import DomainError,database_engine,json_safe
from dataqore_engine.worker import Worker


def sleeping_job(settings,identifier):
    time.sleep(30)


def crashed_job(settings,identifier):
    os._exit(2)


def settings(url='postgresql+psycopg://srv_dataqore_engine@localhost/dataqore_engine',root=Path('/tmp')):
    return Settings(url,'test-internal-api-key-123456789',Fernet.generate_key().decode(),sqlite_allowed_root=root,
        heartbeat_seconds=0.05,job_timeout_seconds=10,poll_seconds=0.01)


class SecurityTests(unittest.TestCase):
    def test_sqlite_uses_snapshot_only_with_existing_wal_without_blocking_writes(self):
        from dataqore_engine.schemas import Credentials
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'journal.sqlite'
            with sqlite3.connect(path) as writer:
                writer.execute('CREATE TABLE records(id integer)');writer.execute('INSERT INTO records VALUES(1)')
            manager=SourceManager(settings(root=root))
            row={'name':'test','connector':'sqlite','is_active':True,'encryption_key_version':'v1',
                'credentials_ciphertext':manager.encrypt('sqlite',Credentials(database=str(path)))}
            with manager.session(row,comparison=True) as source:
                self.assertEqual(source['read_consistency'],'best_effort')
                self.assertFalse(source['conn'].in_transaction)
                source['conn'].execute('SELECT count(*) FROM records').fetchone()
                with sqlite3.connect(path,timeout=0.1) as writer:writer.execute('INSERT INTO records VALUES(2)')
            with sqlite3.connect(path) as writer:writer.execute('PRAGMA journal_mode=WAL')
            with manager.session(row,comparison=True) as source:
                self.assertEqual(source['read_consistency'],'stable_snapshot')
                before=source['conn'].execute('SELECT count(*) FROM records').fetchone()[0]
                with sqlite3.connect(path,timeout=0.1) as writer:writer.execute('INSERT INTO records VALUES(3)')
                self.assertEqual(source['conn'].execute('SELECT count(*) FROM records').fetchone()[0],before)

    def test_mssql_certificate_error_is_actionable_without_exposing_driver_details(self):
        for text in ('self-signed certificate','certificate verify failed',
            'certificate chain was issued by an authority that is not trusted','hostname mismatch'):
            failure=source_failure('mssql',RuntimeError(text+' PRIVATE_PASSWORD'))
            self.assertEqual(failure.code,'source_mssql_certificate_invalid')
            self.assertIn('Trust server certificate',failure.message)
            self.assertNotIn('PRIVATE_PASSWORD',failure.message)

    def test_mssql_connection_string_matches_installed_driver(self):
        try:
            import mssql_python
            from mssql_python.connection_string_parser import _ConnectionStringParser
        except ImportError:self.skipTest('Optional SQL Server driver is not installed')
        from dataqore_engine.connectors import mssql
        creds={'hostname':'localhost','database':'example','username':'reader',
            'password':'special};PWD=injection;{value','port':1433}
        with patch.object(mssql_python,'connect') as connect:
            mssql(creds)
            args,kwargs=connect.call_args
            # Use the real driver's validator: unsupported keywords must fail here.
            parsed=_ConnectionStringParser(validate_keywords=True)._parse(args[0])
            self.assertEqual(parsed['server'],'localhost,1433')
            self.assertEqual(parsed['pwd'],creds['password'])
            self.assertEqual(parsed['encrypt'],'yes')
            self.assertEqual(parsed['trustservercertificate'],'no')
            self.assertEqual(kwargs,{'timeout':10})
            mssql({**creds,'trust_server_certificate':True})
            parsed=_ConnectionStringParser(validate_keywords=True)._parse(connect.call_args.args[0])
            self.assertEqual(parsed['encrypt'],'yes')
            self.assertEqual(parsed['trustservercertificate'],'yes')

    def test_postgres_failures_provide_safe_actionable_codes(self):
        cases=[
            ('28P01','PRIVATE_PASSWORD','authentication_failed'),
            ('28000','PRIVATE_PASSWORD','access_denied'),
            ('3D000','PRIVATE_PASSWORD','database_not_found'),
            ('42501','PRIVATE_PASSWORD','permission_denied'),
            ('57P03','PRIVATE_PASSWORD','server_unavailable'),
            ('57014','PRIVATE_PASSWORD','query_timeout'),
            (None,'password authentication failed for user PRIVATE_PASSWORD','authentication_failed'),
            (None,'no pg_hba.conf entry for PRIVATE_PASSWORD','access_denied'),
            (None,'database PRIVATE_PASSWORD does not exist','database_not_found'),
            (None,'could not translate host name PRIVATE_PASSWORD','host_unresolved'),
            (None,'connection refused PRIVATE_PASSWORD','connection_refused'),
            (None,'timeout expired PRIVATE_PASSWORD','connection_timeout'),
            (None,'no route to host PRIVATE_PASSWORD','network_unreachable'),
            (None,'SSL error: certificate verify failed PRIVATE_PASSWORD','tls_error'),
            (None,'database system is starting up PRIVATE_PASSWORD','server_unavailable'),
            (None,'PRIVATE_PASSWORD','unavailable'),
        ]
        for state,message,reason in cases:
            with self.subTest(reason=reason,state=state):
                error=RuntimeError(message);error.sqlstate=state
                failure=source_failure('postgresql',error)
                self.assertEqual(failure.code,'source_'+reason)
                self.assertEqual(failure.status,503)
                self.assertNotIn('PRIVATE_PASSWORD',failure.message)
        self.assertEqual(source_failure('mysql',RuntimeError('connection refused')).code,'source_unavailable')

    def test_postgres_session_preserves_safe_failure_and_closes_connection(self):
        from dataqore_engine.schemas import Credentials
        from dataqore_engine.connectors import Plugin
        manager=SourceManager(settings())
        row={'name':'test','connector':'postgresql','is_active':True,'encryption_key_version':'v1',
            'credentials_ciphertext':manager.encrypt('postgresql',Credentials(database='db',hostname='host',username='reader',password='PRIVATE_PASSWORD'))}
        conn=MagicMock();error=psycopg.errors.InsufficientPrivilege('PRIVATE_PASSWORD')
        conn.cursor.return_value.execute.side_effect=error
        with patch.dict('dataqore_engine.connectors.PLUGINS',{'postgresql':Plugin('psycopg',lambda _:conn)}):
            with self.assertRaises(DomainError) as raised:manager.test(row)
        self.assertEqual(raised.exception.code,'source_permission_denied')
        self.assertNotIn('PRIVATE_PASSWORD',raised.exception.message)
        conn.close.assert_called_once()

    def test_configuration_rejects_owner_credentials_and_invalid_encryption_key(self):
        with self.assertRaises(ValueError):
            settings('postgresql+psycopg://dataqore_engine_owner@localhost/dataqore_engine')
        with self.assertRaisesRegex(ValueError,'Fernet'):
            replace(settings(),encryption_key='not-a-key')

    def test_sqlite_paths_and_sessions_are_read_only(self):
        with tempfile.TemporaryDirectory() as directory,tempfile.TemporaryDirectory() as outside:
            root=Path(directory)
            path=root/'sample.sqlite'
            sqlite3.connect(path).close()
            other=Path(outside)/'outside.sqlite'
            sqlite3.connect(other).close()
            (root/'escape.sqlite').symlink_to(other)
            manager=SourceManager(settings(root=root))
            for candidate in (str(other),'missing.sqlite','escape.sqlite','../outside.sqlite'):
                with self.assertRaises(DomainError):
                    manager.sqlite_path(candidate)
            from dataqore_engine.schemas import Credentials
            row={'name':'test','connector':'sqlite','is_active':True,'encryption_key_version':'v1',
                'credentials_ciphertext':manager.encrypt('sqlite',Credentials(database=str(path)))}
            with manager.session(row) as source:
                with self.assertRaises(sqlite3.OperationalError):
                    source['conn'].execute('CREATE TABLE forbidden(id int)')

    def test_read_session_contracts_for_five_sources(self):
        for kind,statement in [('postgresql','SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'),
            ('mysql','START TRANSACTION READ ONLY'),('oracle','SET TRANSACTION READ ONLY'),
            ('mssql','SET LOCK_TIMEOUT 15000'),('sqlite','PRAGMA query_only = ON')]:
            conn=MagicMock()
            prepare_read_session(conn,kind)
            conn.cursor.return_value.execute.assert_any_call(statement)
            conn.cursor.return_value.close.assert_called_once()
        self.assertEqual(odbc_value('x};PWD=bad'),'{x}};PWD=bad}')

    def test_serialization_never_rounds_decimal(self):
        number=Decimal('12345678901234567890.12345678901234567890')
        self.assertEqual(json_safe({'mean':number}),{'mean':str(number)})

    def test_driver_errors_are_sanitized_and_connections_are_closed(self):
        from dataqore_engine.schemas import Credentials
        manager=SourceManager(settings())
        row={'name':'test','connector':'postgresql','is_active':True,'encryption_key_version':'v1',
            'credentials_ciphertext':manager.encrypt('postgresql',Credentials(database='db',hostname='host',username='reader',password='PRIVATE_PASSWORD'))}
        conn=MagicMock()
        with patch('dataqore_engine.connectors.postgres',return_value=conn):
            # O plugin armazena a função original; substitui o registro por um plugin de teste.
            from dataqore_engine.connectors import Plugin
            with patch.dict('dataqore_engine.connectors.PLUGINS',{'postgresql':Plugin('psycopg',lambda _:conn)}):
                conn.cursor.return_value.execute.side_effect=RuntimeError('PRIVATE_PASSWORD')
                with self.assertRaises(DomainError) as error:
                    manager.test(row)
                self.assertNotIn('PRIVATE_PASSWORD',error.exception.message)
                conn.close.assert_called_once()
        with patch('dataqore_engine.connectors.importlib.util.find_spec',return_value=None):
            with self.assertRaises(DomainError) as error:
                manager.test(row)
            self.assertEqual(error.exception.code,'driver_unavailable')


@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN'),'Disposable PostgreSQL required')
class APITests(TemporaryPostgres):
    def setUp(self):
        super().setUp()
        self.command('engine','baseline');self.command('engine','apply')
        root=self.directory/'sources';root.mkdir(exist_ok=True)
        for side in ('left','right'):
            path=root/(side+'.sqlite')
            path.unlink(missing_ok=True)
            with sqlite3.connect(path) as c:
                c.execute('CREATE TABLE records(id integer PRIMARY KEY,value text,day date)')
                c.executemany('INSERT INTO records VALUES(?,?,?)',[(1,'PRIVATE_VALUE','2026-10-01'),(2,'same' if side=='left' else 'changed','2026-10-02')])
        self.settings=settings(f'postgresql+psycopg://srv_dataqore_engine@127.0.0.1:{self.port}/dataqore_engine',root)
        self.app=create_app(self.settings);self.client=TestClient(self.app);self.client.__enter__()
        self.addCleanup(self.client.__exit__,None,None,None)
        self.headers={'X-API-Key':self.settings.api_key};self.engine=self.app.state.engine;self.queue=Queue(self.engine)

    def request(self,method,path,expected=200,**kw):
        response=self.client.request(method,'/v1'+path,headers=self.headers,**kw)
        self.assertEqual(response.status_code,expected,response.text)
        return response.json()

    def definition(self,**extra):
        datasets=[]
        for side in ('left','right'):
            c=self.request('POST','/connections',201,json={'name':side,'connector':'sqlite','credentials':{'database':side+'.sqlite'}})
            datasets.append(self.request('POST','/datasets',201,json={'connection_id':c['id'],'table_name':'records'}))
        payload={'name':'Critical','left_dataset_id':datasets[0]['id'],'right_dataset_id':datasets[1]['id'],**extra}
        return self.request('POST','/comparisons',201,json=payload)

    def finish(self,comparison):
        run=self.request('POST',f"/comparisons/{comparison['id']}/runs",202)
        identifier=self.queue.claim();self.assertEqual(str(identifier),run['id'])
        run_job(self.settings,identifier)
        return run,self.request('GET',f"/runs/{run['id']}/result")

    def test_authenticated_contract_removes_obsolete_features(self):
        self.assertEqual(self.client.get('/v1/connections').status_code,401)
        spec=self.app.openapi()
        for path in spec['paths']:
            self.assertFalse(any(v in path for v in ('profile','quality-rules','/metrics','quality-trend')))
        self.assertNotIn('quality_rules',spec['components']['schemas']['DatasetOut']['properties'])
        c=self.definition()
        self.request('PATCH',f"/comparisons/{c['id']}",422,json={'sampling_options':{'rows':10001}})
        self.request('PATCH',f"/comparisons/{c['id']}",422,json={'mode':'independent_random'})

    def test_preview_counts_percentage_and_atomic_persisted_results(self):
        c=self.definition(sampling_options={'method':'percentage','percentage':'50','seed':'18446744073709551615'})
        payload={k:c[k] for k in ('name','left_dataset_id','right_dataset_id','sampling_options','comparison_options','absolute_tolerance','relative_tolerance')}
        preview=self.request('POST','/comparisons/preview',json=payload)
        self.assertEqual((preview['scope_counts'],preview['sample_target']),([2,2],1))
        run,result=self.finish(c)
        self.assertEqual(result['format_version'],6)
        self.assertEqual(len(result['result']['metrics']),5)
        self.assertNotIn('PRIVATE_VALUE',json.dumps(result))
        self.assertEqual(result['result']['sampling_plan']['seed'],'18446744073709551615')
        with self.engine.connect() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(m.run_results)),1)
            self.assertEqual(db.scalar(select(m.runs.c.status)),'succeeded')

    def test_seed_scope_and_definition_are_frozen_idempotently(self):
        c=self.definition(comparison_options={'scope':{'period':{'kind':'relative','left':'day','right':'day','quantity':2,'unit':'months'}}})
        key={'Idempotency-Key':'original'}
        run=self.client.post(f"/v1/comparisons/{c['id']}/runs",headers={**self.headers,**key}).json()
        self.request('PATCH',f"/comparisons/{c['id']}",json={'sampling_options':{'rows':1,'seed':'1'}})
        again=self.client.post(f"/v1/comparisons/{c['id']}/runs",headers={**self.headers,**key}).json()
        self.assertEqual(run,again)
        self.assertEqual(run['parameters']['resolved_scope']['period']['unit'],'months')
        self.assertIsInstance(run['parameters']['sampling_options']['seed'],str)

    def test_failed_latest_run_does_not_reuse_prior_rates(self):
        c=self.definition();self.finish(c)
        overview=self.request('GET','/overview');self.assertEqual(overview['row_match_rate']['evaluated'],2)
        run=self.request('POST',f"/comparisons/{c['id']}/runs",202)
        identifier=self.queue.claim();self.queue.fail(identifier,'test_failure')
        overview=self.request('GET','/overview')
        self.assertIsNone(overview['row_match_rate']['percentage'])
        self.assertEqual(overview['latest_conclusions']['failed'],1)
        trend=self.request('GET','/overview/row-match-trend?days=7')
        self.assertIsNone(trend['series'][0]['points'][-1]['percentage'])
        summaries=self.request('GET','/comparison-summaries')
        self.assertIsNone(summaries['items'][0]['latest_result']['row_match_rate'])

    def test_deletion_protects_frozen_sources_and_active_runs(self):
        c=self.definition();run=self.request('POST',f"/comparisons/{c['id']}/runs",202)
        self.request('DELETE',f"/comparisons/{c['id']}",409)
        self.request('DELETE',f"/datasets/{c['left_dataset_id']}",409)
        identifier=self.queue.claim();run_job(self.settings,identifier)
        self.request('DELETE',f"/comparisons/{c['id']}")
        self.request('DELETE',f"/datasets/{c['left_dataset_id']}")
        self.assertEqual(self.request('GET','/runs')['total'],0)

    def test_publish_rollback_and_worker_recovery(self):
        c=self.definition();run=self.request('POST',f"/comparisons/{c['id']}/runs",202)
        identifier=self.queue.claim()
        def reject_update(conn,cursor,statement,parameters,context,executemany):
            if statement.startswith('UPDATE engine.runs'):raise RuntimeError('simulate publication failure')
        event.listen(self.engine,'before_cursor_execute',reject_update)
        try:
            with patch('dataqore_engine.jobs.database_engine',return_value=self.engine):run_job(self.settings,identifier)
        finally:event.remove(self.engine,'before_cursor_execute',reject_update)
        with self.engine.connect() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(m.run_results)),0)
            self.assertEqual(db.scalar(select(m.runs.c.status)),'running')
        self.assertEqual(self.queue.recover_interrupted(),1)
        self.assertEqual(self.request('GET',f"/runs/{run['id']}")['error_code'],'worker_interrupted')

    def test_postgres_sqlite_cross_source_precision_and_read_only_permissions(self):
        with self.connect() as db:
            if not db.execute("SELECT 1 FROM pg_roles WHERE rolname='critical_source_reader'").fetchone():db.execute('CREATE ROLE critical_source_reader LOGIN')
            if not db.execute("SELECT 1 FROM pg_database WHERE datname='dataqore_source'").fetchone():db.execute('CREATE DATABASE dataqore_source')
        with self.connect('source') as db:
            db.execute('DROP TABLE IF EXISTS records');db.execute('CREATE TABLE records(id integer PRIMARY KEY, value text,day date)')
            db.execute("INSERT INTO records VALUES(1,'PRIVATE_VALUE','2026-10-01'),(2,'same','2026-10-02')")
            db.execute('GRANT USAGE ON SCHEMA public TO critical_source_reader');db.execute('GRANT SELECT ON records TO critical_source_reader')
        c=self.definition()
        connection=self.request('POST','/connections',201,json={'name':'Postgres','connector':'postgresql','credentials':{'hostname':'127.0.0.1','port':self.port,'database':'dataqore_source','username':'critical_source_reader','password':''}})
        dataset=self.request('POST','/datasets',201,json={'connection_id':connection['id'],'schema_name':'public','table_name':'records'})
        c=self.request('PATCH',f"/comparisons/{c['id']}",json={'right_dataset_id':dataset['id']})
        _,r=self.finish(c);self.assertEqual(r['result']['metrics']['row_match_rate']['percentage'],'100.0000')
        with self.connect('source','critical_source_reader') as db:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):db.execute("DELETE FROM records")
