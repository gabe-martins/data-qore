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


@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN'),'Defina DATAQORE_PG_BIN para integração PostgreSQL')
class APITests(TemporaryPostgres):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with cls.connect() as conn:
            conn.execute('CREATE ROLE source_reader LOGIN')
            conn.execute('CREATE DATABASE dataqore_source')
        with cls.connect('source') as conn:
            conn.execute('CREATE TABLE public.records(id integer PRIMARY KEY, amount numeric NOT NULL)')
            conn.execute("INSERT INTO public.records VALUES (1,12345678901234567890.12345678901234567890)")
            conn.execute('GRANT USAGE ON SCHEMA public TO source_reader')
            conn.execute('GRANT SELECT ON public.records TO source_reader')

    def setUp(self):
        super().setUp()
        self.command('engine','baseline')
        self.command('engine','apply')
        self.files=tempfile.TemporaryDirectory(prefix='dataqore-sources-')
        self.addCleanup(self.files.cleanup)
        root=Path(self.files.name)
        for name,values in [('left',[(1,'PRIVATE_VALUE',10),(2,None,20)]),
            ('right',[(1,'CHANGED_PRIVATE_VALUE',10),(3,None,30)])]:
            with sqlite3.connect(root/f'{name}.sqlite') as conn:
                conn.execute('CREATE TABLE records(id integer PRIMARY KEY,value text,amount numeric)')
                conn.executemany('INSERT INTO records VALUES (?,?,?)',values)
        self.settings=settings(f'postgresql+psycopg://srv_dataqore_engine@127.0.0.1:{self.port}/dataqore_engine',root)
        self.app=create_app(self.settings)
        self.client=TestClient(self.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__,None,None,None)
        self.headers={'X-API-Key':self.settings.api_key}
        self.engine=self.app.state.engine
        self.queue=Queue(self.engine)

    def request(self,method,path,expected=200,**kwargs):
        headers=self.headers | kwargs.pop('headers',{})
        response=self.client.request(method,'/v1'+path,headers=headers,**kwargs)
        self.assertEqual(response.status_code,expected,response.text)
        return response.json()

    def fixture(self):
        dataset_ids=[]
        connection_ids=[]
        for name in ('left','right'):
            row=self.request('POST','/connections',201,json={'name':name,'connector':'sqlite',
                'credentials':{'database':f'{name}.sqlite'}})
            connection_ids.append(row['id'])
            dataset=self.request('POST','/datasets',201,json={'connection_id':row['id'],'table_name':'records'})
            dataset_ids.append(dataset['id'])
        definition=self.request('POST','/comparisons',201,json={'name':'compare','left_dataset_id':dataset_ids[0],
            'right_dataset_id':dataset_ids[1],'sample_size':10})
        return connection_ids,dataset_ids,definition['id']

    def finish(self,identifier):
        self.assertEqual(self.queue.claim(),UUID(identifier))
        run_job(self.settings,UUID(identifier))
        return self.request('GET',f'/runs/{identifier}')

    def unused_dataset(self,name='unused-dataset'):
        connection=self.request('POST','/connections',201,json={'name':name,'connector':'sqlite',
            'credentials':{'database':'left.sqlite'}})
        dataset=self.request('POST','/datasets',201,json={'connection_id':connection['id'],'table_name':'records'})
        return connection,dataset

    def test_comparison_delete_auth_missing_and_terminal_history_without_source_access(self):
        from uuid import uuid4
        connections,datasets,comparison=self.fixture()
        job=self.request('POST',f'/comparisons/{comparison}/runs',202)
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        failed=self.request('POST',f'/comparisons/{comparison}/runs',202)
        self.assertEqual(self.queue.claim(),UUID(failed['id']));self.queue.fail(UUID(failed['id']),'test_failure')
        profile=self.request('POST',f'/datasets/{datasets[0]}/profile-runs',202)
        self.assertEqual(self.finish(profile['id'])['status'],'succeeded')
        other=self.request('POST','/comparisons',201,json={'name':'retained-comparison','left_dataset_id':datasets[0],'right_dataset_id':datasets[1]})
        other_run=self.request('POST',f'/comparisons/{other["id"]}/runs',202)
        self.assertEqual(self.finish(other_run['id'])['status'],'succeeded')
        path=f'/comparisons/{comparison}'
        for method,suffix in [('GET','/dependencies'),('DELETE','')]:
            self.assertEqual(self.client.request(method,'/v1'+path+suffix).status_code,401)
            self.request(method,f'/comparisons/{uuid4()}{suffix}',404)
        self.request('PATCH',path,json={'is_active':False})
        with patch.object(SourceManager,'session',side_effect=AssertionError('Deletion cannot access sources')):
            deps=self.request('GET',path+'/dependencies')
            self.assertEqual(deps['history']['runs'],2)
            self.assertEqual(deps['history']['results'],1)
            self.assertEqual(deps['history']['column_profiles'],6)
            self.assertGreater(deps['history']['metrics'],0)
            self.assertTrue(deps['can_delete'])
            self.assertEqual(self.request('DELETE',path),{'id':comparison,'status':'deleted'})
        self.request('GET',path,404);self.request('DELETE',path,404)
        for removed in (job['id'],failed['id']):
            self.request('GET',f'/runs/{removed}',404)
            with self.engine.connect() as conn:
                for table in (m.metrics,m.column_profiles,m.run_results):
                    self.assertEqual(conn.scalar(select(func.count()).select_from(table).where(table.c.run_id==UUID(removed))),0)
        for retained in (profile['id'],other_run['id']):self.request('GET',f'/runs/{retained}/result')
        for dataset in datasets:self.request('GET',f'/datasets/{dataset}')
        for connection in connections:self.request('GET',f'/connections/{connection}')

    def test_comparison_delete_empty_and_busy_runs(self):
        _,datasets,comparison=self.fixture()
        path=f'/comparisons/{comparison}'
        job=self.request('POST',path+'/runs',202)
        self.assertEqual(self.request('GET',path+'/dependencies')['active_runs'],1)
        self.assertEqual(self.request('DELETE',path,409)['code'],'comparison_busy')
        self.assertEqual(self.queue.claim(),UUID(job['id']))
        self.assertEqual(self.request('DELETE',path,409)['code'],'comparison_busy')
        self.queue.fail(UUID(job['id']),'test_failure')
        self.request('DELETE',path)
        empty=self.request('POST','/comparisons',201,json={'name':'empty','left_dataset_id':datasets[0],'right_dataset_id':datasets[1]})
        self.assertEqual(self.request('GET',f'/comparisons/{empty["id"]}/dependencies')['history']['runs'],0)
        self.request('DELETE',f'/comparisons/{empty["id"]}')

    def test_comparison_delete_rolls_back_all_history_on_failure(self):
        _,_,comparison=self.fixture()
        path=f'/comparisons/{comparison}'
        job=self.request('POST',path+'/runs',202)
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        before=self.request('GET',path+'/dependencies')['history']
        def controlled_failure(conn,cursor,statement,parameters,context,executemany):
            if statement.startswith('DELETE FROM engine.column_profiles'):
                raise DomainError(503,'test_rollback','Controlled failure')
        event.listen(self.engine,'before_cursor_execute',controlled_failure)
        try:self.request('DELETE',path,503)
        finally:event.remove(self.engine,'before_cursor_execute',controlled_failure)
        self.assertEqual(self.request('GET',path+'/dependencies')['history'],before)
        self.request('GET',f'/runs/{job["id"]}/result')

    def test_comparison_delete_serializes_concurrent_enqueue_in_both_orders(self):
        from threading import Event
        _,datasets,comparison=self.fixture()
        paused,release=Event(),Event()
        def pause_before_insert(conn,cursor,statement,parameters,context,executemany):
            if statement.startswith('INSERT INTO engine.runs'):
                paused.set()
                if not release.wait(10):raise RuntimeError('Enqueue not released')
        with ThreadPoolExecutor(max_workers=2) as pool:
            event.listen(self.engine,'before_cursor_execute',pause_before_insert)
            enqueued=pool.submit(self.queue.enqueue,'comparison',UUID(comparison))
            try:
                self.assertTrue(paused.wait(5))
                deleting=pool.submit(self.client.delete,f'/v1/comparisons/{comparison}',headers=self.headers)
                deadline=time.monotonic()+5
                with self.connect('engine') as observer:
                    while time.monotonic()<deadline:
                        if observer.execute("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='dataqore_engine' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%')").fetchone()[0]:break
                        time.sleep(.01)
                    else:self.fail('Deletion did not wait for enqueue')
            finally:release.set()
            try:enqueued.result(timeout=10)
            finally:event.remove(self.engine,'before_cursor_execute',pause_before_insert)
            self.assertEqual(deleting.result(timeout=10).status_code,409)
            # Reverse order: the new enqueue waits, then observes the deleted definition.
            empty=self.request('POST','/comparisons',201,json={'name':'delete-first','left_dataset_id':datasets[0],'right_dataset_id':datasets[1]})
            paused.clear();release.clear()
            def pause_delete(conn,cursor,statement,parameters,context,executemany):
                if statement.startswith('SELECT engine.comparison_definitions.id') and 'FOR UPDATE' in statement:
                    paused.set()
                    if not release.wait(10):raise RuntimeError('Deletion not released')
            event.listen(self.engine,'after_cursor_execute',pause_delete)
            deleting=pool.submit(self.client.delete,f'/v1/comparisons/{empty["id"]}',headers=self.headers)
            try:
                self.assertTrue(paused.wait(5))
                enqueued=pool.submit(self.queue.enqueue,'comparison',UUID(empty['id']))
                deadline=time.monotonic()+5
                with self.connect('engine') as observer:
                    while time.monotonic()<deadline:
                        if observer.execute("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='dataqore_engine' AND wait_event_type='Lock' AND query LIKE '%FOR KEY SHARE%')").fetchone()[0]:break
                        time.sleep(.01)
                    else:self.fail('Enqueue did not wait for deletion')
            finally:release.set()
            try:self.assertEqual(deleting.result(timeout=10).status_code,200)
            finally:event.remove(self.engine,'after_cursor_execute',pause_delete)
            with self.assertRaises(DomainError) as missing:enqueued.result(timeout=10)
            self.assertEqual(missing.exception.code,'not_found')

    def test_dataset_delete_auth_missing_no_source_queries_and_source_preserved(self):
        from uuid import uuid4
        connection,dataset=self.unused_dataset()
        path=f'/datasets/{dataset["id"]}'
        for method,suffix in [('GET','/dependencies'),('DELETE','')]:
            self.assertEqual(self.client.request(method,'/v1'+path+suffix).status_code,401)
            self.request(method,f'/datasets/{uuid4()}{suffix}',404)
        with patch.object(SourceManager,'session',side_effect=AssertionError('No source access allowed')):
            deps=self.request('GET',path+'/dependencies')
            self.assertTrue(deps['can_delete'])
            self.assertEqual(deps['dataset']['connection_name'],connection['name'])
            self.assertEqual(deps['profile_history'],{'runs':0,'results':0,'column_profiles':0,'metrics':0})
            self.assertEqual(self.request('DELETE',path),{'id':dataset['id'],'status':'deleted'})
        self.request('DELETE',path,404)
        self.request('GET',path+'/dependencies',404)
        self.assertTrue(self.request('GET',f'/connections/{connection["id"]}/dependencies')['can_delete'])
        with sqlite3.connect(Path(self.files.name)/'left.sqlite') as source:
            self.assertEqual(source.execute('SELECT count(*) FROM records').fetchone()[0],2)

    def test_dataset_delete_removes_only_individual_history_and_preserves_other_datasets(self):
        connection,dataset=self.unused_dataset()
        other_connection,other=self.unused_dataset('other-dataset')
        job=self.request('POST',f'/datasets/{dataset["id"]}/profile-runs',202)
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        failed=self.request('POST',f'/datasets/{dataset["id"]}/profile-runs',202)
        self.assertEqual(self.queue.claim(),UUID(failed['id']));self.queue.fail(UUID(failed['id']),'test_failure')
        retained=self.request('POST',f'/datasets/{other["id"]}/profile-runs',202)
        self.assertEqual(self.finish(retained['id'])['status'],'succeeded')
        deps=self.request('GET',f'/datasets/{dataset["id"]}/dependencies')
        self.assertEqual(deps['profile_history']['runs'],2)
        self.assertEqual(deps['profile_history']['results'],1)
        self.assertEqual(deps['profile_history']['column_profiles'],3)
        self.assertGreater(deps['profile_history']['metrics'],0)
        self.assertTrue(deps['can_delete'])
        with patch.object(SourceManager,'session',side_effect=AssertionError('No source access allowed')):
            self.request('DELETE',f'/datasets/{dataset["id"]}')
        for identifier in (job['id'],failed['id']):
            self.request('GET',f'/runs/{identifier}',404)
            with self.engine.connect() as conn:
                for table in (m.metrics,m.column_profiles,m.run_results):
                    self.assertEqual(conn.scalar(select(func.count()).select_from(table).where(table.c.run_id==UUID(identifier))),0)
        self.request('GET',f'/runs/{retained["id"]}/result')
        self.assertEqual(self.request('GET',f'/datasets/{other["id"]}/dependencies')['profile_history']['runs'],1)
        self.request('GET',f'/connections/{connection["id"]}')
        self.request('GET',f'/connections/{other_connection["id"]}')

    def test_dataset_dependencies_current_inactive_pagination_and_historical_snapshots(self):
        connections,datasets,comparison=self.fixture()
        with self.engine.begin() as conn:
            for index in range(21):
                conn.execute(m.comparison_definitions.insert().values(name=f'linked_{index:02}',
                    left_dataset_id=UUID(datasets[0]),right_dataset_id=UUID(datasets[1]),is_active=False))
        path=f'/datasets/{datasets[0]}'
        page=self.request('GET',path+'/dependencies?comparison_limit=20')
        self.assertEqual(page['comparisons']['total'],22)
        self.assertEqual(len(page['comparisons']['items']),20)
        self.assertTrue(all(c['current'] and not c['historical'] for c in page['comparisons']['items']))
        next_page=self.request('GET',path+'/dependencies?comparison_offset=20')
        self.assertEqual(len(next_page['comparisons']['items']),2)
        self.assertTrue(set(c['id'] for c in page['comparisons']['items']).isdisjoint(c['id'] for c in next_page['comparisons']['items']))
        self.assertEqual(self.request('DELETE',path,409)['code'],'dataset_in_use')
        for query in ('comparison_limit=0','comparison_limit=201','comparison_offset=-1'):
            self.request('GET',path+'/dependencies?'+query,422)
        with self.engine.begin() as conn:
            conn.execute(m.comparison_definitions.delete().where(m.comparison_definitions.c.name.like('linked_%')))
        job=self.request('POST',f'/comparisons/{comparison}/runs',202)
        _,replacement=self.unused_dataset('replacement')
        self.request('PATCH',f'/comparisons/{comparison}',json={'left_dataset_id':replacement['id']})
        historical=self.request('GET',path+'/dependencies')
        self.assertEqual(historical['comparisons']['total'],1)
        self.assertFalse(historical['comparisons']['items'][0]['current'])
        self.assertTrue(historical['comparisons']['items'][0]['historical'])
        self.assertEqual(self.request('DELETE',path,409)['code'],'dataset_in_use')
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        # Relational evidence protects histories without frozen source identifiers too.
        with self.engine.begin() as conn:
            parameters=conn.scalar(select(m.runs.c.parameters).where(m.runs.c.id==UUID(job['id'])))
            parameters.pop('sources')
            conn.execute(m.runs.update().where(m.runs.c.id==UUID(job['id'])).values(parameters=parameters))
        self.assertTrue(self.request('GET',path+'/dependencies')['comparisons']['items'][0]['historical'])
        self.request('DELETE',path,409)
        self.request('GET',f'/runs/{job["id"]}/result')

    def test_dataset_delete_blocks_queued_running_and_concurrent_profile_completion(self):
        from threading import Event
        from dataqore_engine.jobs import execute_profile
        _,dataset=self.unused_dataset()
        path=f'/datasets/{dataset["id"]}'
        job=self.request('POST',path+'/profile-runs',202)
        self.assertEqual(self.request('GET',path+'/dependencies')['active_profile_runs'],1)
        self.assertEqual(self.request('DELETE',path,409)['code'],'dataset_busy')
        self.assertEqual(self.queue.claim(),UUID(job['id']))
        entered,release=Event(),Event()
        def delayed(*args,**kwargs):
            entered.set()
            if not release.wait(10):raise RuntimeError('Test calculation not released')
            return execute_profile(*args,**kwargs)
        with ThreadPoolExecutor(max_workers=1) as pool,patch('dataqore_engine.jobs.execute_profile',side_effect=delayed):
            future=pool.submit(run_job,self.settings,UUID(job['id']))
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.request('DELETE',path,409)['code'],'dataset_busy')
            finally:release.set()
            future.result(timeout=15)
        self.assertTrue(self.request('GET',path+'/dependencies')['can_delete'])
        self.request('DELETE',path)

    def test_dataset_delete_history_rolls_back_on_failure(self):
        _,dataset=self.unused_dataset()
        path=f'/datasets/{dataset["id"]}'
        job=self.request('POST',path+'/profile-runs',202)
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        before=self.request('GET',path+'/dependencies')['profile_history']
        def fail_mid_delete(conn,cursor,statement,parameters,context,executemany):
            if statement.startswith('DELETE FROM engine.column_profiles'):
                raise DomainError(503,'test_rollback','Controlled failure')
        event.listen(self.engine,'before_cursor_execute',fail_mid_delete)
        try:self.request('DELETE',path,503)
        finally:event.remove(self.engine,'before_cursor_execute',fail_mid_delete)
        self.assertEqual(self.request('GET',path+'/dependencies')['profile_history'],before)
        self.request('GET',f'/runs/{job["id"]}/result')

    def test_dataset_delete_serializes_frozen_comparison_enqueue_in_both_orders(self):
        from threading import Event
        connections,datasets,comparison=self.fixture()
        _,replacement=self.unused_dataset('replacement-race')
        paused,release=Event(),Event()
        def pause_before_insert(conn,cursor,statement,parameters,context,executemany):
            if statement.startswith('INSERT INTO engine.runs'):
                paused.set()
                if not release.wait(10):raise RuntimeError('Enqueue not released')
        event.listen(self.engine,'before_cursor_execute',pause_before_insert)
        with ThreadPoolExecutor(max_workers=2) as pool:
            enqueued=pool.submit(self.queue.enqueue,'comparison',UUID(comparison))
            try:
                self.assertTrue(paused.wait(5))
                self.request('PATCH',f'/comparisons/{comparison}',json={'left_dataset_id':replacement['id']})
                deleting=pool.submit(self.client.delete,f'/v1/datasets/{datasets[0]}',headers=self.headers)
                deadline=time.monotonic()+5
                with self.connect('engine') as observer:
                    while time.monotonic()<deadline:
                        if observer.execute("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='dataqore_engine' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%')").fetchone()[0]:break
                        time.sleep(.01)
                    else:self.fail('Deletion did not wait for enqueue dataset locks')
            finally:
                release.set()
            try:enqueued.result(timeout=10)
            finally:event.remove(self.engine,'before_cursor_execute',pause_before_insert)
            self.assertEqual(deleting.result(timeout=10).status_code,409)
            self.assertTrue(self.request('GET',f'/datasets/{datasets[0]}/dependencies')['comparisons']['items'][0]['historical'])
            # Reverse order: enqueue captured the definition but has not locked its sources.
            _,third=self.unused_dataset('delete-before-enqueue')
            self.request('PATCH',f'/comparisons/{comparison}',json={'left_dataset_id':third['id']})
            paused.clear();release.clear()
            def pause_after_definition(conn,cursor,statement,parameters,context,executemany):
                if statement.startswith('SELECT engine.comparison_definitions.') and not paused.is_set():
                    paused.set()
                    if not release.wait(10):raise RuntimeError('Definition read not released')
            event.listen(self.engine,'after_cursor_execute',pause_after_definition)
            enqueued=pool.submit(self.queue.enqueue,'comparison',UUID(comparison))
            try:
                self.assertTrue(paused.wait(5))
                self.request('PATCH',f'/comparisons/{comparison}',json={'left_dataset_id':replacement['id']})
                self.request('DELETE',f'/datasets/{third["id"]}')
            finally:
                release.set()
            try:
                with self.assertRaises(DomainError) as failure:enqueued.result(timeout=10)
            finally:event.remove(self.engine,'after_cursor_execute',pause_after_definition)
            self.assertEqual(failure.exception.code,'not_found')

    def test_dataset_delete_foreign_keys_protect_concurrent_comparison_creation_and_edit(self):
        from threading import Event
        _,datasets,comparison=self.fixture()
        with ThreadPoolExecutor(max_workers=1) as pool:
            for operation in ('insert','update'):
                _,target=self.unused_dataset('fk-race-'+operation)
                started=Event();futures=[]
                def mutate_comparison():
                    with self.engine.begin() as conn:
                        started.set()
                        if operation=='insert':
                            conn.execute(m.comparison_definitions.insert().values(name='racing-definition',
                                left_dataset_id=UUID(target['id']),right_dataset_id=UUID(datasets[1])))
                        else:
                            conn.execute(m.comparison_definitions.update().where(m.comparison_definitions.c.id==UUID(comparison))
                                .values(left_dataset_id=UUID(target['id'])))
                def while_dataset_locked(conn,cursor,statement,parameters,context,executemany):
                    if statement.startswith('SELECT engine.datasets.id') and 'FOR UPDATE' in statement:
                        futures.append(pool.submit(mutate_comparison))
                        self.assertTrue(started.wait(5))
                        deadline=time.monotonic()+5
                        with self.connect('engine') as observer:
                            while time.monotonic()<deadline:
                                if observer.execute("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='dataqore_engine' AND wait_event_type='Lock' AND query LIKE %s)",
                                    ('%'+operation.upper()+'%engine.comparison_definitions%',)).fetchone()[0]:break
                                time.sleep(.01)
                            else:self.fail('Comparison mutation did not wait for dataset lock')
                event.listen(self.engine,'after_cursor_execute',while_dataset_locked)
                try:self.request('DELETE',f'/datasets/{target["id"]}')
                finally:event.remove(self.engine,'after_cursor_execute',while_dataset_locked)
                self.assertEqual(len(futures),1)
                with self.assertRaises(IntegrityError):futures[0].result(timeout=10)
        self.assertEqual(self.request('GET',f'/comparisons/{comparison}')['left_dataset_id'],datasets[0])

    def test_connection_delete_requires_auth_and_only_removes_unused_connections(self):
        from uuid import uuid4
        row=self.request('POST','/connections',201,json={'name':'unused','connector':'sqlite',
            'credentials':{'database':'left.sqlite'}})
        identifier=row['id']
        (Path(self.files.name)/'left.sqlite').unlink()
        self.request('PATCH',f'/connections/{identifier}',json={'is_active':False})
        for method,suffix in [('GET','/dependencies'),('DELETE','')]:
            self.assertEqual(self.client.request(method,f'/v1/connections/{identifier}{suffix}').status_code,401)
            self.request(method,f'/connections/{uuid4()}{suffix}',404)
        with patch.object(SourceManager,'session',side_effect=AssertionError('Must not open a source')):
            preview=self.request('GET',f'/connections/{identifier}/dependencies')
            self.assertTrue(preview['can_delete'])
            self.assertEqual(preview['datasets']['total'],0)
            self.assertEqual(preview['comparisons']['total'],0)
            self.assertNotIn('credentials',json.dumps(preview))
            self.assertEqual(self.request('DELETE',f'/connections/{identifier}'),{'id':identifier,'status':'deleted'})
        self.request('GET',f'/connections/{identifier}',404)
        self.request('DELETE',f'/connections/{identifier}',404)

    def test_connection_dependencies_pagination_deduplication_and_history_preservation(self):
        connections,datasets,comparison=self.fixture()
        job=self.request('POST',f'/comparisons/{comparison}/runs',202)
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        identifier=UUID(connections[0])
        with self.engine.begin() as conn:
            for index in range(21):
                dataset=conn.execute(m.datasets.insert().values(connection_id=identifier,catalog_name='catalog',
                    schema_name='schema',table_name=f'view_{index:02}',metadata={'table_type':'VIEW'}).returning(m.datasets.c.id)).scalar_one()
                conn.execute(m.comparison_definitions.insert().values(name=f'linked_{index:02}',
                    left_dataset_id=UUID(datasets[0]),right_dataset_id=dataset,is_active=index%2==0))
        with patch.object(SourceManager,'session',side_effect=AssertionError('Must not open a source')):
            initial=self.request('GET',f'/connections/{identifier}/dependencies?dataset_limit=1&comparison_limit=2')
            self.assertFalse(initial['can_delete'])
            self.assertEqual(initial['datasets']['total'],22)
            self.assertEqual(initial['comparisons']['total'],22)
            self.assertEqual(len(initial['comparisons']['items']),2)
            next_page=self.request('GET',f'/connections/{identifier}/dependencies?dataset_limit=1&dataset_offset=1&comparison_limit=2&comparison_offset=2')
            self.assertNotEqual(initial['datasets']['items'],next_page['datasets']['items'])
            self.assertTrue(set(x['id'] for x in initial['comparisons']['items']).isdisjoint(x['id'] for x in next_page['comparisons']['items']))
            all_refs=self.request('GET',f'/connections/{identifier}/dependencies?dataset_limit=200&comparison_limit=200')
            self.assertEqual(sum(not c['is_active'] for c in all_refs['comparisons']['items']),10)
            self.assertEqual(len({c['id'] for c in all_refs['comparisons']['items']}),22)
            self.assertTrue(any(d['catalog_name']=='catalog' and d['table_type']=='VIEW' for d in all_refs['datasets']['items']))
            failure=self.request('DELETE',f'/connections/{identifier}',409)
            self.assertEqual(failure['code'],'connection_in_use')
            for query in ('dataset_limit=0','comparison_limit=201','dataset_offset=-1','comparison_offset=-1'):
                self.request('GET',f'/connections/{identifier}/dependencies?{query}',422)
        self.assertEqual(self.request('GET',f'/runs/{job["id"]}')['status'],'succeeded')
        self.request('GET',f'/runs/{job["id"]}/result')
        self.assertEqual(self.request('GET',f'/connections/{identifier}')['id'],str(identifier))

    def test_connection_delete_serializes_concurrent_dependencies_with_foreign_keys(self):
        from threading import Event
        def wait_for_lock(fragment):
            deadline=time.monotonic()+5
            with self.connect('engine') as observer:
                while time.monotonic()<deadline:
                    if observer.execute("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname='dataqore_engine' AND wait_event_type='Lock' AND query LIKE %s)",
                                        ('%'+fragment+'%',)).fetchone()[0]:return
                    time.sleep(.01)
            self.fail('Expected concurrent operation to wait for the connection row lock')
        def unused(name):
            return UUID(self.request('POST','/connections',201,json={'name':name,'connector':'sqlite',
                'credentials':{'database':'left.sqlite'}})['id'])
        first=unused('insert-first')
        self.assertTrue(self.request('GET',f'/connections/{first}/dependencies')['can_delete'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            with self.engine.begin() as conn:
                conn.execute(m.datasets.insert().values(connection_id=first,schema_name='main',table_name='records'))
                deleting=pool.submit(self.client.delete,f'/v1/connections/{first}',headers=self.headers)
                wait_for_lock('FOR UPDATE')
                # A dependency committed after preview must be rechecked by DELETE.
            self.assertEqual(deleting.result(timeout=10).status_code,409)
            second=unused('delete-first')
            started=Event();futures=[]
            def insert_dependency():
                with self.engine.begin() as conn:
                    started.set()
                    conn.execute(m.datasets.insert().values(connection_id=second,schema_name='main',table_name='records'))
            def while_locked(conn,cursor,statement,parameters,context,executemany):
                if 'FOR UPDATE' in statement:
                    futures.append(pool.submit(insert_dependency))
                    self.assertTrue(started.wait(timeout=5))
                    wait_for_lock('INSERT INTO engine.datasets')
            event.listen(self.engine,'after_cursor_execute',while_locked)
            try:self.request('DELETE',f'/connections/{second}')
            finally:event.remove(self.engine,'after_cursor_execute',while_locked)
            self.assertEqual(len(futures),1)
            with self.assertRaises(IntegrityError):futures[0].result(timeout=10)
        self.assertFalse(self.request('GET',f'/connections/{first}/dependencies')['can_delete'])
        self.request('GET',f'/connections/{second}',404)

    def test_scoped_preview_business_key_and_schema_change_without_partial_results(self):
        connections,datasets,identifier=self.fixture()
        options={'mapping':[{'left':'value','right':'value'}],
            'business_key':[{'left':'value','right':'value'}],
            'scope':{'filters':[{'left':'amount','right':'amount','operator':'gte','value':'10'}]}}
        payload={'name':'preview','left_dataset_id':datasets[0],'right_dataset_id':datasets[1],
            'comparison_options':options,'sample_size':1}
        with patch('dataqore_engine.core.db_adapters.DatabaseAdapter.validate_key',side_effect=AssertionError('Preview must not scan keys')):
            preview=self.request('POST','/comparisons/preview',json=payload)
        self.assertEqual(preview['business_key'],options['business_key'])
        self.assertNotIn('predicates',preview)
        self.request('PATCH',f'/comparisons/{identifier}',json={'comparison_options':options,'sample_size':1})
        job=self.request('POST',f'/comparisons/{identifier}/runs',202)
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        result=self.request('GET',f"/runs/{job['id']}/result")
        self.assertEqual(result['format_version'],5)
        self.assertEqual(result['conclusion'],'inconclusive')
        self.assertEqual(result['result']['key_validation'][0]['null_key_rows'],1)
        self.assertEqual(result['result']['row_comparisons'],[])
        next_job=self.request('POST',f'/comparisons/{identifier}/runs',202)
        with sqlite3.connect(Path(self.files.name)/'left.sqlite') as source:
            source.execute('ALTER TABLE records RENAME COLUMN value TO renamed')
        failed=self.finish(next_job['id'])
        self.assertEqual(failed['status'],'failed')
        self.assertEqual(failed['error_code'],'source_schema_changed')
        with self.engine.connect() as conn:
            for table in (m.run_results,m.column_profiles,m.metrics):
                self.assertEqual(conn.scalar(select(func.count()).select_from(table).where(table.c.run_id==UUID(next_job['id']))),0)

    def test_relative_scope_freezes_once_before_wait_and_idempotent_retry(self):
        _,datasets,identifier=self.fixture()
        for side in ('left','right'):
            with sqlite3.connect(Path(self.files.name)/(side+'.sqlite')) as source:
                source.execute('ALTER TABLE records ADD COLUMN day date')
            self.request('POST',f'/datasets/{datasets[0 if side=="left" else 1]}/refresh')
        options={'scope':{'period':{'kind':'relative','left':'day','right':'day','days':2,
            'timezone':'America/Sao_Paulo','safety_delay_minutes':30}}}
        self.request('PATCH',f'/comparisons/{identifier}',json={'comparison_options':options})
        at=datetime(2026,10,19,3,15,tzinfo=timezone.utc)
        with patch('dataqore_engine.jobs.datetime') as clock:
            clock.now.return_value=at
            job=self.request('POST',f'/comparisons/{identifier}/runs',202,headers={'Idempotency-Key':'frozen-period'})
        period=job['parameters']['resolved_scope']['period']
        self.assertEqual((period['start_day'],period['end_day']),('2026-10-16','2026-10-18'))
        # Even an updated definition and much later retry must return the old run.
        options['scope']['period']['days']=5
        self.request('PATCH',f'/comparisons/{identifier}',json={'comparison_options':options})
        with patch('dataqore_engine.jobs.resolve_scope',side_effect=AssertionError('Must return original before resolving')):
            retry=self.request('POST',f'/comparisons/{identifier}/runs',202,headers={'Idempotency-Key':'frozen-period'})
        self.assertEqual(job,retry)
        for side in ('left','right'):
            with sqlite3.connect(Path(self.files.name)/(side+'.sqlite')) as source:
                source.execute("UPDATE records SET day='2026-10-17'")
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        result=self.request('GET',f"/runs/{job['id']}/result")['result']
        self.assertEqual(result['resolved_scope']['period'],period)
        self.assertEqual([s['sample_size'] for s in result['sources']],[2,2])

    def test_read_models_search_quality_coverage_and_no_source_access(self):
        overview=self.request('GET','/overview')
        self.assertIsNone(overview['sample_quality']['percentage'])
        self.assertEqual(len(overview['trend']),7)
        connections,datasets,definition=self.fixture()
        listed=self.request('GET','/connections',params={'search':'left'})
        self.assertEqual(listed['total'],1)
        self.assertEqual(listed['items'][0]['dataset_count'],1)
        self.assertEqual(self.request('GET','/connections',params={'search':'%'})['total'],0)
        run=self.request('POST',f'/comparisons/{definition}/runs',202)
        self.finish(run['id'])
        # Catalog/source files may disappear; all summaries must still be readable.
        for path in Path(self.files.name).glob('*.sqlite'):
            path.unlink()
        overview=self.request('GET','/overview')
        self.assertEqual(overview['active_comparisons'],1)
        self.assertEqual(overview['latest_conclusions']['difference_observed'],1)
        self.assertEqual(overview['sample_quality']['percentage'],'100.0000')
        self.assertLess(Decimal(overview['comparison_agreement']['percentage']),100)
        self.assertEqual(overview['evaluated_comparisons'],1)
        self.assertEqual(overview['recent_runs'][0]['id'],run['id'])
        summary=self.request('GET','/comparison-summaries',params={'search':'compare'})
        self.assertEqual(summary['items'][0]['latest_result']['run_id'],run['id'])
        self.assertEqual(summary['items'][0]['absolute_tolerance'],'0')
        self.assertEqual(self.request('GET','/comparison-summaries',params={'search':'%'})['total'],0)
        self.assertNotIn('PRIVATE_VALUE',json.dumps(overview))
        self.request('GET','/comparison-summaries',422,params={'limit':201})

    def test_daily_quality_trend_latest_finished_run_and_gaps(self):
        from datetime import timedelta
        from dataqore_engine import read_api
        _,datasets,identifier=self.fixture()
        now=datetime(2026,10,19,12,tzinfo=timezone.utc)
        class Clock(datetime):
            @classmethod
            def now(cls,tz=None): return now.astimezone(tz) if tz else now.replace(tzinfo=None)
        with self.engine.begin() as c:
            empty=c.execute(m.comparison_definitions.insert().values(name='No runs',left_dataset_id=datasets[0],right_dataset_id=datasets[1]).returning(m.comparison_definitions.c.id)).scalar_one()
            inactive=c.execute(m.comparison_definitions.insert().values(name='Inactive',left_dataset_id=datasets[0],right_dataset_id=datasets[1],is_active=False).returning(m.comparison_definitions.c.id)).scalar_one()
            def add(at,passed=1,evaluated=1,total=1,status='succeeded',comparison=identifier,kind='comparison',key=None):
                values=dict(kind=kind,parameters={},status=status,requested_at=at-timedelta(minutes=2),
                    started_at=at-timedelta(minutes=1),finished_at=at,
                    **({'comparison_id':comparison} if kind=='comparison' else {'dataset_id':datasets[0]}))
                if key:values['id']=key
                run=c.execute(m.runs.insert().values(**values).returning(m.runs.c.id)).scalar_one()
                if status=='succeeded':
                    c.execute(m.run_results.insert().values(run_id=run,format_version=4,conclusion='inconclusive',
                        result={'indicators':{'agreement':{'passed':passed,'evaluated':evaluated,'total':total,'percentage':'999'},'quality':{'overall':{'passed':passed,'evaluated':evaluated,'total':total,'percentage':'999'}}}}))
                return str(run)
            # 02:59Z belongs to the previous day in Sao Paulo; 03:00Z starts today.
            old=add(datetime(2026,10,19,2,59,tzinfo=timezone.utc),passed=1,evaluated=2,total=4)
            today=add(datetime(2026,10,19,3,tzinfo=timezone.utc),passed=1,evaluated=4,total=8)
            failure=add(now-timedelta(hours=1),status='failed')
            add(now,kind='profile');add(now,comparison=inactive)
            add(now+timedelta(minutes=1)) # Future completions must not enter the response.
            add(now-timedelta(days=10));add(now-timedelta(days=20));add(now-timedelta(days=30))
            # An evaluated success followed by an unevaluated success must leave a gap.
            at=now-timedelta(days=2)
            add(at-timedelta(minutes=2))
            zero=add(at,evaluated=0,passed=0,total=5)
            tie=now-timedelta(days=3)
            add(tie,passed=1,evaluated=1,key=UUID(int=1))
            winner=add(tie,passed=1,evaluated=3,key=UUID(int=2))
        for path in Path(self.files.name).glob('*.sqlite'):path.unlink()
        with patch.object(read_api,'datetime',Clock):
            default=self.request('GET','/overview/quality-trend')
            self.assertEqual((default['days'],default['timezone'],default['start_day'],default['end_day']),
                (7,'America/Sao_Paulo','2026-10-13','2026-10-19'))
            self.assertEqual(len(default['series']),2)
            for days,count in [(7,4),(15,5),(30,6)]:
                result=self.request('GET','/overview/quality-trend',params={'days':days})
                series=next(s for s in result['series'] if s['comparison_id']==identifier)
                self.assertEqual(len(series['points']),days)
                self.assertEqual(sum(p['run_id'] is not None for p in series['points']),count)
            points=next(s for s in default['series'] if s['comparison_id']==identifier)['points']
            self.assertEqual(points[-1]['run_id'],failure)
            self.assertEqual(points[-1]['status'],'failed')
            self.assertIsNone(points[-1]['percentage'])
            self.assertEqual((points[-2]['run_id'],points[-2]['percentage'],points[-2]['coverage_percentage']),
                (old,'50.0000','50.0000'))
            self.assertEqual(points[-3]['run_id'],zero);self.assertIsNone(points[-3]['percentage'])
            self.assertEqual((points[-4]['run_id'],points[-4]['percentage']),(winner,'33.3333'))
            agreement=self.request('GET','/overview/quality-trend',params={'metric':'agreement'})
            self.assertEqual(agreement['metric'],'agreement')
            self.assertEqual(agreement['series'],default['series'])
            self.assertEqual(agreement['regression_observations'],2)
            self.assertEqual(agreement['overall'][-2]['percentage'],'50.0000')
            self.assertIsNone(agreement['overall'][-1]['percentage'])
            self.assertIsNone(agreement['linear_trend'][-1]['percentage'])
            self.assertEqual(agreement['linear_trend'][-3]['percentage'],'41.6667')
            self.assertIsNone(points[0]['run_id']);self.assertIsNone(points[0]['percentage'])
            self.assertTrue(all(p['percentage'] is None for s in default['series'] if s['comparison_id']==str(empty) for p in s['points']))
            utc=self.request('GET','/overview/quality-trend',params={'timezone':'UTC'})
            self.assertEqual(next(s for s in utc['series'] if s['comparison_id']==identifier)['points'][-2]['run_id'],None)
            for invalid in ({'metric':'unknown'},{'days':8},{'days':0},{'days':'invalid'},{'timezone':'Invalid/Zone'},{'timezone':'../etc/passwd'},{'timezone':''},{'timezone':'x'*101}):
                self.request('GET','/overview/quality-trend',422,params=invalid)
        self.assertNotIn('PRIVATE_VALUE',json.dumps(default))
        self.assertEqual(self.client.get('/v1/overview/quality-trend').status_code,401)

    def test_overview_uses_latest_completion_and_does_not_hide_failures(self):
        _,_,identifier=self.fixture()
        first=self.request('POST',f'/comparisons/{identifier}/runs',202,json={})
        self.finish(first['id'])
        # A queued scheduled/manual request keeps the last completed evidence.
        latest=self.request('POST',f'/comparisons/{identifier}/runs',202,json={})
        before=self.request('GET','/overview')
        self.assertEqual(before['evaluated_comparisons'],1)
        self.assertEqual(before['attention'][0]['name'],'compare')
        with self.engine.begin() as c:
            c.execute(m.runs.update().where(m.runs.c.id==UUID(latest['id'])).values(status='failed',finished_at=func.now(),error_code='source_unavailable'))
        after=self.request('GET','/overview')
        self.assertIsNone(after['comparison_agreement']['percentage'])
        self.assertIsNone(after['sample_quality']['percentage'])
        self.assertEqual(after['evaluated_comparisons'],0)
        self.assertEqual(after['latest_conclusions']['failed'],1)

    def test_daily_quality_trend_dst_and_empty_comparisons(self):
        from dataqore_engine import read_api
        now=datetime(2026,11,1,16,tzinfo=timezone.utc)
        class Clock(datetime):
            @classmethod
            def now(cls,tz=None): return now.astimezone(tz) if tz else now.replace(tzinfo=None)
        with patch.object(read_api,'datetime',Clock):
            empty=self.request('GET','/overview/quality-trend',params={'days':7,'timezone':'America/New_York'})
            self.assertEqual(empty['series'],[])
            self.assertEqual(empty['start_day'],'2026-10-26')
            _,_,identifier=self.fixture()
            with self.engine.begin() as c:
                ids=[]
                for hour,minute in [(3,59),(4,0)]:
                    at=datetime(2026,11,1,hour,minute,tzinfo=timezone.utc)
                    ids.append(str(c.execute(m.runs.insert().values(kind='comparison',comparison_id=identifier,parameters={},
                        status='failed',requested_at=at,finished_at=at).returning(m.runs.c.id)).scalar_one()))
            result=self.request('GET','/overview/quality-trend',params={'timezone':'America/New_York'})
            self.assertEqual([p['run_id'] for p in result['series'][0]['points'][-2:]],ids)

    def test_http_flow_comparison_profile_metrics_and_no_private_rows(self):
        connections,datasets,definition=self.fixture()
        self.assertEqual(self.request('GET',f'/connections/{connections[0]}/schemas')['items'],[''])
        self.assertEqual(self.request('GET',f'/connections/{connections[0]}/tables')['items'][0]['table_name'],'records')
        self.request('POST',f'/connections/{connections[0]}/test')
        run=self.request('POST',f'/comparisons/{definition}/runs',202)
        self.request('GET',f"/runs/{run['id']}/result",409)
        self.assertEqual(self.finish(run['id'])['status'],'succeeded')
        result=self.request('GET',f"/runs/{run['id']}/result")
        self.assertEqual(result['conclusion'],'difference_observed')
        self.assertEqual(result['result']['execution_id'],run['id'])
        self.assertNotIn('PRIVATE_VALUE',json.dumps(result))
        self.assertNotIn('sample_rows',json.dumps(result))
        profile=self.request('POST',f'/datasets/{datasets[0]}/profile-runs',202,json={})
        self.assertEqual(self.finish(profile['id'])['status'],'succeeded')
        stored=self.request('GET',f'/datasets/{datasets[0]}/profiles')
        self.assertGreater(stored['total'],0)
        metric=self.request('GET','/metrics',params={'dataset_id':datasets[0],'column_name':'amount','metric_name':'mean'})
        self.assertEqual(metric['items'][0]['value'],'15')
        self.request('POST',f'/datasets/{datasets[0]}/refresh')
        self.assertEqual(self.request('GET','/runs',params={'status':'succeeded'})['total'],2)

    def test_auth_validation_errors_pagination_and_openapi(self):
        self.assertEqual(self.client.get('/v1/connections').status_code,401)
        response=self.client.post('/v1/connections',headers=self.headers,json={
            'name':'x','connector':'postgresql','credentials':{'database':'x','password':'DO_NOT_ECHO','port':'DO_NOT_ECHO'}})
        self.assertEqual(response.status_code,422)
        self.assertNotIn('DO_NOT_ECHO',response.text)
        self.request('GET','/runs',422,params={'limit':201})
        self.request('GET','/runs/not-a-uuid',422)
        spec=self.client.get('/openapi.json').json()
        self.assertIn('APIKeyHeader',spec['components']['securitySchemes'])
        self.assertIn('/v1/runs/{identifier}/result',spec['paths'])
        self.assertEqual(self.client.get('/health/ready').status_code,200)

    def test_credentials_encrypted_updates_versioning_and_not_returned(self):
        payload={'name':'pg','connector':'postgresql','credentials':{
            'hostname':'private-host','database':'source','username':'reader','password':'VERY_PRIVATE_PASSWORD'}}
        row=self.request('POST','/connections',201,json=payload)
        self.assertNotIn('credentials',row)
        with self.engine.connect() as conn:
            ciphertext=conn.scalar(select(m.connections.c.credentials_ciphertext).where(m.connections.c.id==UUID(row['id'])))
        self.assertNotIn('VERY_PRIVATE_PASSWORD',ciphertext)
        self.request('PATCH',f"/connections/{row['id']}",json={'name':'changed'})
        self.request('PATCH',f"/connections/{row['id']}",422,json={'credentials':{'database':'missing'}})
        self.request('PATCH',f"/connections/{row['id']}",json={'credentials':payload['credentials']})
        with self.engine.begin() as conn:
            conn.execute(m.connections.update().where(m.connections.c.id==UUID(row['id'])).values(encryption_key_version='v2'))
        response=self.request('POST',f"/connections/{row['id']}/test",503)
        self.assertEqual(response['code'],'encryption_key_version_unavailable')

    def test_idempotency_concurrency_and_frozen_definition(self):
        _,_,definition=self.fixture()
        def enqueue(_):
            return self.queue.enqueue('comparison',UUID(definition),key='same-request')['id']
        with ThreadPoolExecutor(max_workers=4) as executor:
            identifiers=list(executor.map(enqueue,range(4)))
        self.assertEqual(len(set(identifiers)),1)
        self.request('PATCH',f'/comparisons/{definition}',json={'sample_size':1})
        old=self.request('POST',f'/comparisons/{definition}/runs',202,headers={'Idempotency-Key':'same-request'})
        self.assertEqual(old['parameters']['sample_size'],10)
        dataset=self.request('GET','/datasets')['items'][0]['id']
        self.request('POST',f'/datasets/{dataset}/profile-runs',409,headers={'Idempotency-Key':'same-request'},json={})

    def test_deactivation_and_missing_source_fail_without_results(self):
        connections,_,definition=self.fixture()
        run=self.request('POST',f'/comparisons/{definition}/runs',202)
        self.request('PATCH',f'/connections/{connections[0]}',json={'is_active':False})
        self.request('POST',f'/comparisons/{definition}/runs',409)
        final=self.finish(run['id'])
        self.assertEqual(final['status'],'failed')
        self.assertEqual(final['error_code'],'connection_inactive')
        self.request('GET',f"/runs/{run['id']}/result",409)
        self.request('PATCH',f'/comparisons/{definition}',json={'is_active':False})

    def test_new_runs_read_fresh_values_and_metadata_and_preserve_history(self):
        _,_,definition=self.fixture()
        first=self.request('POST',f'/comparisons/{definition}/runs',202)
        self.finish(first['id'])
        with sqlite3.connect(Path(self.files.name)/'left.sqlite') as conn:
            conn.execute('UPDATE records SET amount=100 WHERE id=1')
            conn.execute('ALTER TABLE records ADD COLUMN fresh_column integer')
        second=self.request('POST',f'/comparisons/{definition}/runs',202)
        self.finish(second['id'])
        old=self.request('GET',f"/runs/{first['id']}/result")['result']['sources'][0]
        new=self.request('GET',f"/runs/{second['id']}/result")['result']['sources'][0]
        self.assertEqual(Decimal(old['metrics']['amount']['mean']),Decimal(15))
        self.assertEqual(Decimal(new['metrics']['amount']['mean']),Decimal(60))
        self.assertNotIn('fresh_column',old['columns'])
        self.assertIn('fresh_column',new['columns'])

    def test_real_worker_exclusive_leadership_and_process_execution(self):
        _,_,definition=self.fixture()
        run=self.request('POST',f'/comparisons/{definition}/runs',202)
        with Worker(self.settings) as worker:
            with self.assertRaises(DomainError):
                with Worker(self.settings):
                    pass
            self.assertTrue(worker.process_one())
            self.assertFalse(worker.process_one())
        self.assertEqual(self.request('GET',f"/runs/{run['id']}")['status'],'succeeded')

    def test_timeouts_crashes_recovery_and_late_publication(self):
        _,datasets,_=self.fixture()
        first=self.request('POST',f'/datasets/{datasets[0]}/profile-runs',202,json={})
        with Worker(replace(self.settings,job_timeout_seconds=0.3)) as worker:
            worker.process_one(target=sleeping_job)
        self.assertEqual(self.request('GET',f"/runs/{first['id']}")['error_code'],'execution_timeout')
        second=self.request('POST',f'/datasets/{datasets[0]}/profile-runs',202,json={})
        with Worker(self.settings) as worker:
            worker.process_one(target=crashed_job)
        self.assertEqual(self.request('GET',f"/runs/{second['id']}")['error_code'],'worker_process_exited')
        third=self.request('POST',f'/datasets/{datasets[0]}/profile-runs',202,json={})
        self.queue.claim()
        with Worker(self.settings):
            pass
        self.assertEqual(self.request('GET',f"/runs/{third['id']}")['error_code'],'worker_interrupted')
        self.assertFalse(self.queue.publish(UUID(third['id']),{},[]))

    def test_missing_partition_rolls_back_entire_publication(self):
        _,datasets,_=self.fixture()
        run=self.request('POST',f'/datasets/{datasets[0]}/profile-runs',202,json={})
        partition=datetime.now(timezone.utc).strftime('metrics_%Y_%m')
        with self.connect('engine') as conn:
            conn.execute(f'ALTER TABLE engine.metrics DETACH PARTITION engine.{partition}')
        self.assertEqual(self.finish(run['id'])['status'],'failed')
        with self.engine.connect() as conn:
            for table in (m.run_results,m.column_profiles,m.metrics):
                count=conn.scalar(select(func.count()).select_from(table).where(table.c.run_id==UUID(run['id'])))
                self.assertEqual(count,0)

    def test_postgres_source_real_read_only_and_decimal_precision(self):
        row=self.request('POST','/connections',201,json={'name':'postgres-source','connector':'postgresql',
            'credentials':{'hostname':'127.0.0.1','port':self.port,'database':'dataqore_source',
                'username':'source_reader','password':'','sslmode':'disable'}})
        self.request('POST',f"/connections/{row['id']}/test")
        dataset=self.request('POST','/datasets',201,json={'connection_id':row['id'],'schema_name':'public','table_name':'records'})
        run=self.request('POST',f"/datasets/{dataset['id']}/profile-runs",202,json={})
        self.assertEqual(self.finish(run['id'])['status'],'succeeded')
        metric=self.request('GET','/metrics',params={'dataset_id':dataset['id'],'column_name':'amount','metric_name':'mean'})
        self.assertEqual(Decimal(metric['items'][0]['value']),Decimal('12345678901234567890.12345678901234567890'))
        from dataqore_engine.storage import Repository
        saved=Repository(self.engine).get(m.connections,UUID(row['id']))
        with SourceManager(self.settings).session(saved) as source:
            with self.assertRaises(psycopg.Error):
                source['conn'].execute('UPDATE public.records SET amount=0')

    def test_real_postgres_sqlite_scopes_and_transaction_snapshot(self):
        with self.connect('source') as db:
            db.execute('CREATE TABLE public.scoped_records(account text, line integer, day date, batch text, amount numeric)')
            with db.cursor() as cursor:
                cursor.executemany('INSERT INTO public.scoped_records VALUES(%s,%s,%s,%s,%s)',[
                    ('A',1,'2026-10-01','B',10),('A',2,'2026-10-01','B',20),
                    ('A',1,'2026-09-30','B',999),(None,9,'2026-10-02','B',999)])
            db.execute('GRANT SELECT ON public.scoped_records TO source_reader')
        with sqlite3.connect(Path(self.files.name)/'scoped.sqlite') as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE records(customer text, item integer, event_date date, batch text, total numeric)')
            db.executemany('INSERT INTO records VALUES(?,?,?,?,?)',[
                ('A',1,'2026-10-01','B',10),('A',2,'2026-10-01','B',20),
                ('A',1,'2026-10-01','OTHER',999)])
        pg=self.request('POST','/connections',201,json={'name':'scoped-postgres','connector':'postgresql',
            'credentials':{'hostname':'127.0.0.1','port':self.port,'database':'dataqore_source',
                'username':'source_reader','password':'','sslmode':'disable'}})
        sqlite=self.request('POST','/connections',201,json={'name':'scoped-sqlite','connector':'sqlite','credentials':{'database':'scoped.sqlite'}})
        a=self.request('POST','/datasets',201,json={'connection_id':pg['id'],'schema_name':'public','table_name':'scoped_records'})
        b=self.request('POST','/datasets',201,json={'connection_id':sqlite['id'],'table_name':'records'})
        pairs=[{'left':x,'right':y} for x,y in [('account','customer'),('line','item'),('day','event_date'),('amount','total')]]
        options={'mapping':pairs,'business_key':pairs[:2], 'scope':{'period':{'left':'day','right':'event_date',
            'kind':'fixed','start':'2026-10-01','end':'2026-10-02'},'filters':[{'left':'batch','right':'batch','operator':'eq','value':'B'}]}}
        comparison=self.request('POST','/comparisons',201,json={'name':'pg-sqlite','left_dataset_id':a['id'],'right_dataset_id':b['id'],
            'comparison_options':options,'sample_size':2})
        job=self.request('POST',f"/comparisons/{comparison['id']}/runs",202)
        self.assertEqual(self.finish(job['id'])['status'],'succeeded')
        result=self.request('GET',f"/runs/{job['id']}/result")['result']
        self.assertEqual(result['summary']['status'],'compatible_in_sample')
        self.assertEqual([k['total_rows'] for k in result['key_validation']],[2,2])
        self.assertTrue(all(k['read_consistency']=='stable_snapshot' for k in result['key_validation']))
        saved=self.queue.repository.get(m.connections,UUID(pg['id']))
        with SourceManager(self.settings).session(saved,comparison=True) as source:
            with source['conn'].cursor() as cursor:
                cursor.execute('SELECT count(*) FROM public.scoped_records');before=cursor.fetchone()[0]
                with self.connect('source') as writer:
                    writer.execute("INSERT INTO public.scoped_records VALUES ('AFTER',3,'2026-10-01','B',30)")
                cursor.execute('SELECT count(*) FROM public.scoped_records')
                self.assertEqual(cursor.fetchone()[0],before)
                with self.assertRaises(psycopg.Error):cursor.execute('DELETE FROM public.scoped_records')

    def test_postgres_text_scope_keeps_fixed_char_padding_and_unicode_exact(self):
        from dataqore_engine.comparison_options import validate_options
        from dataqore_engine.core.db_adapters import get_adapter
        with self.connect('source') as conn:
            conn.execute('CREATE TABLE public.text_scope(id integer PRIMARY KEY,batch text,fixed character(2))')
            conn.execute("INSERT INTO public.text_scope VALUES(1,'B','B'),(2,'b','b'),(3,'B ','B '),(4,'é','é'),(5,'É','É')")
            conn.execute('GRANT SELECT ON public.text_scope TO source_reader')
        with self.connect('source','source_reader') as conn:
            adapter=get_adapter('postgresql');columns=adapter.metadata(conn,'public','text_scope')
            for name,value,expected in [('batch','B',1),('batch','é',1),('fixed','B',0),('fixed','B ',2)]:
                options={'scope':{'filters':[{'left':name,'right':name,'operator':'eq','value':value}]}}
                context=validate_options(options,[columns,columns])
                _,rows=adapter.fetch_random(conn,'public','text_scope',['id'],10,metadata=columns,scope=context['predicates'][0])
                self.assertEqual(len(rows),expected)


if __name__=='__main__':
    unittest.main()
