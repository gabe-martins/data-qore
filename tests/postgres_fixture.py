"""PostgreSQL descartável compartilhado pelos testes; nunca usa .env reais."""
import os
import base64,hashlib,hmac,json,secrets
from uuid import uuid4
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
import psycopg

IDENTITY_KEY=secrets.token_urlsafe(32)
os.environ['IDENTITY_ENCRYPTION_KEY']=IDENTITY_KEY
from cryptography.fernet import Fernet
os.environ['CONNECTIONS_ENCRYPTION_KEY']=Fernet.generate_key().decode()

def sealed_user(email,name,identifier=None,key=IDENTITY_KEY):
    identifier=identifier or str(uuid4());master=base64.urlsafe_b64decode(key+'=')
    derive=lambda label:HKDF(algorithm=hashes.SHA256(),length=32,salt=b'dataqore.identity.v1',info=label).derive(master)
    encode=lambda value:base64.urlsafe_b64encode(value).decode().rstrip('=')
    nonce=secrets.token_bytes(12);email=email.strip().lower()
    ciphertext=AESGCM(derive(b'aes-256-gcm')).encrypt(nonce,json.dumps({'email':email,'displayName':name},ensure_ascii=False).encode(),f'dataqore/users/{identifier}/identity/v1'.encode())
    lookup=hmac.new(derive(b'email-lookup'),email.encode(),hashlib.sha256).hexdigest()
    envelope=':'.join(['dqpii','1',hashlib.sha256(master).hexdigest()[:16],encode(nonce),encode(ciphertext[-16:]),encode(ciphertext[:-16])])
    return identifier,lookup,envelope

ROOT = Path(__file__).resolve().parents[1]

class TemporaryPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary=tempfile.TemporaryDirectory(prefix='dataqore-migrations-')
        cls.directory=Path(cls.temporary.name)
        cls.bin=Path(os.environ['DATAQORE_PG_BIN'])
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0))
            cls.port=sock.getsockname()[1]
        def run(*args):
            return subprocess.run([str(cls.bin/args[0]),*args[1:]],check=True,capture_output=True,text=True)
        cls.pg_run=staticmethod(run)
        run('initdb','-D',str(cls.directory/'data'),'-A','trust','-U','postgres','--no-locale','-E','UTF8')
        run('pg_ctl','-D',str(cls.directory/'data'),'-l',str(cls.directory/'server.log'),
            '-o',f'-h 127.0.0.1 -p {cls.port} -k {cls.directory} -F','-w','start')
        cls.addClassCleanup(cls.stop_cluster)
        with cls.connect() as connection:
            script=(ROOT/'database/00_databases_and_roles.sql').read_text()
            for statement in script.split(';'):
                if any(line.strip() and not line.strip().startswith('--') for line in statement.splitlines()):
                    connection.execute(statement)
            connection.execute((ROOT/'database/05_migration_roles.sql').read_text())
            # Provisionamento 05 é repetível e preserva as contas existentes.
            connection.execute((ROOT/'database/05_migration_roles.sql').read_text())


    @classmethod
    def stop_cluster(cls):
        try:
            cls.pg_run('pg_ctl','-D',str(cls.directory/'data'),'-m','immediate','-w','stop')
        finally:
            cls.temporary.cleanup()


    @classmethod
    def connect(cls, service=None, user='postgres'):
        database='postgres' if service is None else f'dataqore_{service}'
        return psycopg.connect(f'postgresql://{user}@127.0.0.1:{cls.port}/{database}',autocommit=True)


    def setUp(self):
        for service in ('app','engine'):
            schema='app' if service=='app' else 'engine'
            with self.connect(service) as connection:
                connection.execute(f'DROP SCHEMA IF EXISTS {schema} CASCADE')
                files=['01_app.sql'] if service=='app' else ['02_engine.sql','03_metrics_partitions.sql']
                for filename in files:
                    connection.execute((ROOT/'database'/filename).read_text())


    def command(self, service, action, success=True):
        environment=os.environ.copy()
        environment["DATAQORE_ENV_FILE"]="/dev/null"
        environment['MIGRATION_DATABASE_URL']=f'postgresql://srv_dataqore_{service}_migrator@127.0.0.1:{self.port}/dataqore_{service}'
        result=subprocess.run([sys.executable,str(ROOT/'tools/migrations.py'),service,action],
            cwd=ROOT,env=environment,capture_output=True,text=True)
        if success:
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        else:
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        return result


    def table_oids(self, service):
        with self.connect(service) as connection:
            return connection.execute("""SELECT c.relname,c.oid FROM pg_class c JOIN pg_namespace n
                ON n.oid=c.relnamespace WHERE n.nspname=%s AND c.relkind IN ('r','p')
                AND c.relname NOT IN ('_prisma_migrations','alembic_version') ORDER BY c.relname""",(service,)).fetchall()

