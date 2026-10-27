"""Focused RBAC integration in its own disposable database; never reads personal .env."""
import os
import subprocess
import unittest
from postgres_fixture import sealed_user, TemporaryPostgres, ROOT


@unittest.skipUnless(os.environ.get('DATAQORE_PG_BIN'), 'Disposable PostgreSQL required')
class AccessControlTests(TemporaryPostgres):
    def test_controller_access_boundary(self):
        self.command('app', 'baseline')
        self.command('app', 'apply')
        with self.connect('app') as connection:
            connection.execute("INSERT INTO app.users(id,email_lookup,identity_ciphertext,password_hash,group_id) SELECT %s,%s,%s,'unused-fixture-hash',id FROM app.access_groups WHERE profile='platform_admin'",sealed_user('fixture@access.test','Fixture admin'))
        environment = {**os.environ, 'DATAQORE_ISOLATED_TEST': '1',
            'DATAQORE_ENV_FILE': str(self.directory / 'absent.env'),
            'DATABASE_URL': f'postgresql://srv_dataqore_app@127.0.0.1:{self.port}/dataqore_app',
            'ENGINE_API_URL': 'http://127.0.0.1:8000', 'WEB_ORIGIN': 'http://127.0.0.1:5173',
            'ENGINE_API_KEY': 'isolated-access-test-key-only',
            'JWT_SECRET': 'isolated-access-test-jwt-secret-for-validation-only'}
        result = subprocess.run(['node', '--import', 'tsx', '--test', 'tests/access.test.ts'],
            cwd=ROOT / 'controller', env=environment, capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout)
