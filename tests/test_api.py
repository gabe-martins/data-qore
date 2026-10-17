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
from sqlalchemy import func,select

from postgres_fixture import TemporaryPostgres
from dataqore_engine.api import create_app
from dataqore_engine import models as m
from dataqore_engine.connectors import SourceManager,prepare_read_session,odbc_value
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


if __name__=='__main__':
    unittest.main()
