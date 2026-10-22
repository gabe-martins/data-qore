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


@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN'),'Disposable PostgreSQL required')
class PostgreSQLMigrationTests(TemporaryPostgres):
    def test_new_schema_grants_and_idempotent_apply(self):
        for service in ('app','engine'):
            self.command(service,'baseline');self.command(service,'apply');self.command(service,'verify')
            before=self.table_oids(service);self.command(service,'apply');self.assertEqual(before,self.table_oids(service))
        with self.connect('engine','srv_dataqore_engine') as c:
            self.assertIsNone(c.execute("SELECT to_regclass('engine.metrics')").fetchone()[0])
            self.assertIsNone(c.execute("SELECT to_regclass('engine.column_profiles')").fetchone()[0])
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):c.execute('ALTER TABLE engine.runs ADD COLUMN forbidden int')
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):c.execute('SELECT * FROM engine.alembic_version')
        with self.connect('app','srv_dataqore_app') as c:
            self.assertIsNone(c.execute("SELECT to_regclass('app.environment_settings')").fetchone()[0])
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):c.execute('CREATE TABLE app.forbidden(id int)')

    def test_migration_refuses_nonempty_engine_without_deleting_connections(self):
        self.command('engine','baseline')
        with self.connect('engine') as c:c.execute("INSERT INTO engine.connections(name,connector,credentials_ciphertext) VALUES('preserved','sqlite','cipher')")
        self.command('engine','apply',success=False)
        with self.connect('engine') as c:self.assertEqual(c.execute('SELECT count(*) FROM engine.connections').fetchone()[0],1)

    def test_reset_preserves_admin_and_migrations_and_is_idempotent(self):
        from tools.reset_operational_data import reset_service
        for service in ('app','engine'):
            self.command(service,'baseline');self.command(service,'apply')
        with self.connect('app') as c:
            user=c.execute("INSERT INTO app.users(email,display_name,password_hash) VALUES('reset@test.local','Admin','original-hash') RETURNING id").fetchone()[0]
            c.execute("INSERT INTO app.auth_sessions(user_id,refresh_token_hash,expires_at) VALUES(%s,'session',now()+interval '1 day')",(user,))
            c.execute("INSERT INTO app.audit_log(action,resource_type,outcome) VALUES('test','test','success')")
            c.execute("INSERT INTO app.schedules(name,comparison_id,cron_expression,next_run_at) VALUES('test',gen_random_uuid(),'0 * * * *',now())")
        with self.connect('engine') as c:c.execute("INSERT INTO engine.connections(name,connector,credentials_ciphertext) VALUES('delete','sqlite','cipher')")
        for service in ('app','engine'):
            with self.connect(service,f'srv_dataqore_{service}_migrator') as c:
                reset_service(c,service);reset_service(c,service)
            self.command(service,'verify')
        with self.connect('app') as c:
            self.assertEqual(c.execute('SELECT password_hash FROM app.users WHERE id=%s',(user,)).fetchone()[0],'original-hash')
            self.assertEqual(c.execute('SELECT count(*) FROM app.auth_sessions').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT count(*) FROM app.schedules').fetchone()[0],0)
        with self.connect('engine') as c:self.assertEqual(c.execute('SELECT count(*) FROM engine.connections').fetchone()[0],0)

    def test_reset_rejects_wrong_identity(self):
        from tools.reset_operational_data import reset_service
        with self.connect('app') as c:
            with self.assertRaises(ValueError):reset_service(c,'app')

    def test_drift_still_blocks_verification(self):
        self.command('engine','baseline');self.command('engine','apply')
        with self.connect('engine') as c:c.execute('ALTER TABLE engine.runs ADD COLUMN unexpected int')
        self.command('engine','verify',success=False)
