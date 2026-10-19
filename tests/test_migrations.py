"""Integração real em cluster próprio descartável; nunca usa URLs de arquivos .env."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from decimal import Decimal
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace

import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.migration_config import load_url, postgres_url, prisma_url, sqlalchemy_url
from tools.migrations import run_tool
from postgres_fixture import TemporaryPostgres


class ConfigurationTests(unittest.TestCase):
    def test_explicit_migration_url_does_not_read_local_secret_files(self):
        url='postgresql://srv_dataqore_app_migrator@host/dataqore_app'
        with patch.dict(os.environ,{'MIGRATION_DATABASE_URL':url}),patch('tools.migration_config.dotenv_values',side_effect=AssertionError('Não ler arquivos locais')):
            self.assertEqual(load_url('app'),url)

    def test_migration_credentials_have_no_runtime_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            env=Path(directory)/'test.env'
            env.write_text('DATABASE_URL=postgresql://srv_dataqore_app@host/dataqore_app\n')
            with patch.dict(os.environ, {'DATAQORE_ENV_FILE':str(env)}, clear=True):
                with self.assertRaisesRegex(ValueError,'MIGRATION_DATABASE_URL'):
                    load_url('app')
            with patch.dict(os.environ, {'MIGRATION_DATABASE_URL':'postgresql://srv_dataqore_app@host/dataqore_app'}, clear=True):
                with self.assertRaisesRegex(ValueError,'conta migrator'):
                    load_url('app')

    def test_tool_output_redacts_url_and_decoded_password(self):
        url='postgresql://srv_dataqore_engine_migrator:p%40ss%3Aword@host/dataqore_engine'
        output=StringIO()
        result=SimpleNamespace(returncode=1,stdout=f'URL={url}',stderr='password=p@ss:word')
        with patch('tools.migrations.subprocess.run',return_value=result),redirect_stdout(output):
            with self.assertRaises(ValueError):
                run_tool('engine','baseline',url)
        self.assertNotIn('p@ss:word',output.getvalue())
        self.assertNotIn('p%40ss%3Aword',output.getvalue())

    def test_url_conversion_preserves_escaped_password_and_tls(self):
        url = 'postgresql+psycopg://srv_dataqore_app_migrator:p%40ss%3Aword@host/dataqore_app?schema=app&sslmode=verify-full'
        self.assertEqual(postgres_url(url), 'postgresql://srv_dataqore_app_migrator:p%40ss%3Aword@host/dataqore_app?sslmode=verify-full')
        self.assertIn('sslmode=verify-full&schema=app', prisma_url(url))
        self.assertTrue(sqlalchemy_url(url).startswith('postgresql+psycopg://'))

    def test_secret_files_are_ignored_but_examples_are_not(self):
        result=subprocess.run(['git','check-ignore','controller.env','engine.env'],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(set(result.stdout.splitlines()), {'controller.env','engine.env'})
        result=subprocess.run(['git','check-ignore','controller.env.example','engine.env.example'],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,1)


@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN'), 'Defina DATAQORE_PG_BIN para iniciar um cluster descartável')
class PostgreSQLMigrationTests(TemporaryPostgres):
    def test_baseline_preserves_data_objects_and_repeated_apply(self):
        with self.connect('app') as connection:
            identifier=connection.execute("INSERT INTO app.users(email,display_name,password_hash) VALUES ('test@dataqore.local','Sentinela','hash-teste') RETURNING id").fetchone()[0]
        with self.connect('engine') as connection:
            engine_id=connection.execute("INSERT INTO engine.connections(name,connector,credentials_ciphertext) VALUES ('teste','postgresql','ciphertext-teste') RETURNING id").fetchone()[0]
        for service in ('app','engine'):
            before=self.table_oids(service)
            self.command(service,'check')
            self.command(service,'verify')
            self.command(service,'baseline')
            self.command(service,'baseline')
            self.command(service,'apply')
            self.command(service,'apply')
            self.command(service,'verify')
            self.assertEqual(before,self.table_oids(service))
            with self.connect(service) as connection:
                table='_prisma_migrations' if service=='app' else 'alembic_version'
                self.assertEqual(connection.execute(f'SELECT count(*) FROM {service}.{table}').fetchone()[0],1)
                for privilege in ('SELECT','INSERT','UPDATE','DELETE'):
                    self.assertFalse(connection.execute('SELECT has_table_privilege(%s,%s,%s)',
                        (f'srv_dataqore_{service}',f'{service}.{table}',privilege)).fetchone()[0])
        with self.connect('app') as connection:
            self.assertEqual(connection.execute('SELECT id FROM app.users').fetchone()[0],identifier)
        with self.connect('engine') as connection:
            self.assertEqual(connection.execute('SELECT id FROM engine.connections').fetchone()[0],engine_id)

    def test_existing_tables_require_baseline(self):
        for service in ('app','engine'):
            result=self.command(service,'apply',success=False)
            self.assertIn('sem histórico',result.stderr)

    def test_drift_blocks_registration_without_creating_history(self):
        mutations=[
            ('app','ALTER TABLE app.users ADD COLUMN unexpected text','ALTER TABLE app.users DROP COLUMN unexpected'),
            ('app','ALTER TABLE app.users DROP CONSTRAINT users_role_check',"ALTER TABLE app.users ADD CONSTRAINT users_role_check CHECK (role = 'admin')"),
            ('app','DROP INDEX app.users_email_unique','CREATE UNIQUE INDEX users_email_unique ON app.users(lower(email))'),
            ('app','GRANT DELETE ON app.audit_log TO srv_dataqore_app','REVOKE DELETE ON app.audit_log FROM srv_dataqore_app'),
            ('engine','GRANT CREATE ON SCHEMA engine TO srv_dataqore_engine','REVOKE CREATE ON SCHEMA engine FROM srv_dataqore_engine'),
            ('engine','ALTER FUNCTION engine.ensure_metrics_partitions(date,integer) SECURITY DEFINER','ALTER FUNCTION engine.ensure_metrics_partitions(date,integer) SECURITY INVOKER'),
            ('engine','ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_engine_owner IN SCHEMA engine REVOKE INSERT ON TABLES FROM srv_dataqore_engine','ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_engine_owner IN SCHEMA engine GRANT INSERT ON TABLES TO srv_dataqore_engine'),
            ('engine',"CREATE TABLE engine.metrics_2040_01 PARTITION OF engine.metrics FOR VALUES FROM ('2040-01-01 00:00:00+00') TO ('2040-01-02 00:00:00+00')",'DROP TABLE engine.metrics_2040_01'),
        ]
        for service,change,restore in mutations:
            with self.subTest(change=change):
                with self.connect(service) as connection:
                    connection.execute(change)
                try:
                    result=self.command(service,'baseline',success=False)
                    self.assertIn('Baseline recusado',result.stderr)
                    with self.connect(service) as connection:
                        table='_prisma_migrations' if service=='app' else 'alembic_version'
                        self.assertIsNone(connection.execute('SELECT to_regclass(%s)',(f'{service}.{table}',)).fetchone()[0])
                finally:
                    with self.connect(service) as connection:
                        connection.execute(restore)

    def test_empty_database_migrations_reproduce_legacy_schema(self):
        for service in ('app','engine'):
            with self.connect(service) as connection:
                connection.execute(f'DROP SCHEMA {service} CASCADE')
            self.command(service,'apply')
            self.command(service,'verify')
            before=self.table_oids(service)
            self.command(service,'apply')
            self.assertEqual(before,self.table_oids(service))

    def test_isolation_ownership_and_future_default_grants(self):
        for service in ('app','engine'):
            other='engine' if service=='app' else 'app'
            for user in (f'srv_dataqore_{service}',f'srv_dataqore_{service}_migrator'):
                with self.assertRaises(psycopg.OperationalError):
                    self.connect(other,user)
            with self.connect(service,f'srv_dataqore_{service}') as connection:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    connection.execute(f'CREATE TABLE {service}.forbidden (id int)')
            with self.connect(service,f'srv_dataqore_{service}_migrator') as connection:
                connection.execute(f'CREATE TABLE {service}.grant_probe (id bigint GENERATED ALWAYS AS IDENTITY)')
                owner=connection.execute('SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=%s::regclass',(f'{service}.grant_probe',)).fetchone()[0]
                self.assertEqual(owner,f'dataqore_{service}_owner')
            with self.connect(service,f'srv_dataqore_{service}') as connection:
                connection.execute(f'INSERT INTO {service}.grant_probe DEFAULT VALUES')
                self.assertEqual(connection.execute(f'SELECT id FROM {service}.grant_probe').fetchone()[0],1)

    def test_monthly_partitions_are_ignored_by_alembic_autogenerate(self):
        self.command('engine','baseline')
        self.command('engine','apply')
        with self.connect('engine', 'srv_dataqore_engine_migrator') as connection:
            connection.execute("SELECT engine.ensure_metrics_partitions('2035-01-01'::date,2)")
        environment=os.environ.copy()
        environment['MIGRATION_DATABASE_URL']=f'postgresql://srv_dataqore_engine_migrator@127.0.0.1:{self.port}/dataqore_engine'
        result=subprocess.run([sys.executable,'-m','alembic','-c',str(ROOT/'engine/alembic.ini'),'check'],
            env=environment,cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('No new upgrade operations',result.stdout)

    def test_comparison_options_upgrade_preserves_existing_definition_and_grants(self):
        with self.connect('engine','srv_dataqore_engine') as conn:
            c=conn.execute("INSERT INTO engine.connections(name,connector,credentials_ciphertext) VALUES ('preserved','sqlite','test') RETURNING id").fetchone()[0]
            a,b=[conn.execute("INSERT INTO engine.datasets(connection_id,table_name) VALUES (%s,%s) RETURNING id",(c,t)).fetchone()[0] for t in ('a','b')]
            identifier=conn.execute("INSERT INTO engine.comparison_definitions(name,left_dataset_id,right_dataset_id) VALUES ('legacy',%s,%s) RETURNING id",(a,b)).fetchone()[0]
        before=self.table_oids('engine')
        self.command('engine','baseline');self.command('engine','apply');self.command('engine','verify')
        self.command('engine','apply')
        self.assertEqual(before,self.table_oids('engine'))
        with self.connect('engine','srv_dataqore_engine') as conn:
            name,options=conn.execute('SELECT name,comparison_options FROM engine.comparison_definitions WHERE id=%s',(identifier,)).fetchone()
            self.assertEqual((name,options),('legacy',{}))
            conn.execute("UPDATE engine.comparison_definitions SET comparison_options='{\"mapping\":[]}' WHERE id=%s",(identifier,))
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute("UPDATE engine.comparison_definitions SET comparison_options='[]' WHERE id=%s",(identifier,))
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('ALTER TABLE engine.comparison_definitions ADD COLUMN forbidden text')
        with self.connect('engine') as conn:
            owner=conn.execute("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='engine.comparison_definitions'::regclass").fetchone()[0]
            self.assertEqual(owner,'dataqore_engine_owner')

    def test_metrics_route_to_monthly_partitions_with_decimal_precision(self):
        expected=Decimal('0.123456789012345678901234567890123456789')
        with self.connect('engine','srv_dataqore_engine') as connection:
            source=connection.execute("INSERT INTO engine.connections(name,connector,credentials_ciphertext) VALUES ('metrics-test','postgresql','ciphertext-test') RETURNING id").fetchone()[0]
            dataset=connection.execute("INSERT INTO engine.datasets(connection_id,table_name) VALUES (%s,'sample') RETURNING id",(source,)).fetchone()[0]
            run=connection.execute("INSERT INTO engine.runs(kind,dataset_id,parameters) VALUES ('profile',%s,'{}') RETURNING id",(dataset,)).fetchone()[0]
            for month in (0,1):
                connection.execute("""INSERT INTO engine.metrics(measured_at,run_id,dataset_id,metric_name,value)
                    VALUES (date_trunc('month',now())+make_interval(months=>%s),%s,%s,'mean',%s)""",(month,run,dataset,expected))
            rows=connection.execute('SELECT tableoid,value FROM engine.metrics ORDER BY measured_at').fetchall()
            self.assertEqual(len({row[0] for row in rows}),2)
            self.assertEqual([row[1] for row in rows],[expected,expected])

    def test_baseline_never_rewinds_existing_engine_history(self):
        self.command('engine','baseline')
        with self.connect('engine') as connection:
            connection.execute("UPDATE engine.alembic_version SET version_num='later_revision'")
        self.command('engine','baseline',success=False)
        with self.connect('engine') as connection:
            self.assertEqual(connection.execute('SELECT version_num FROM engine.alembic_version').fetchone()[0],'later_revision')


if __name__=='__main__':
    unittest.main()
