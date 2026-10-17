"""PostgreSQL descartável compartilhado pelos testes; nunca usa .env reais."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
import psycopg

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

