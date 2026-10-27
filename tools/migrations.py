"""Comandos locais: check, verify, status, baseline e apply."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
from dotenv import dotenv_values
import re
import base64
from urllib.parse import unquote, urlsplit

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.catalog import verify
from tools.migration_config import ROOT, load_url, postgres_url, prisma_url, sqlalchemy_url


def check_connection(connection, service):
    with connection.cursor() as cur:
        cur.execute("SELECT session_user,current_user,current_database(),current_setting('server_version_num')::int")
        login, owner, database, version = cur.fetchone()
        if (login, owner, database) != (f"srv_dataqore_{service}_migrator",f"dataqore_{service}_owner",f"dataqore_{service}"):
            raise ValueError("Identidade da conexão incorreta. Confira o provisionamento 05 e abra uma nova conexão.")
        if version < 150000:
            raise ValueError("PostgreSQL 15 ou superior é necessário.")
        cur.execute("SET search_path TO pg_catalog")
        return login, database


def history(connection, service):
    schema, table = ("app", "_prisma_migrations") if service == "app" else ("engine", "alembic_version")
    with connection.cursor() as cur:
        cur.execute("SELECT to_regclass(%s)", (f"{schema}.{table}",))
        if cur.fetchone()[0] is None:
            return []
        if service == "app":
            cur.execute("""SELECT migration_name,finished_at IS NOT NULL,rolled_back_at IS NOT NULL
                FROM app._prisma_migrations ORDER BY started_at,id""")
            rows=cur.fetchall()
            if any(not finished and not rolled_back for _,finished,rolled_back in rows):
                raise ValueError("Há uma migration Prisma incompleta. Inspecione-a antes de continuar.")
            return [name for name,finished,rolled_back in rows if finished and not rolled_back]
        cur.execute("SELECT version_num FROM engine.alembic_version ORDER BY version_num")
        return [r[0] for r in cur.fetchall()]


def protect_history(connection, service):
    schema, table = ("app", "_prisma_migrations") if service == "app" else ("engine", "alembic_version")
    with connection.cursor() as cur:
        cur.execute(sql.SQL("REVOKE ALL ON {}.{} FROM {}").format(
            sql.Identifier(schema),sql.Identifier(table),sql.Identifier(f"srv_dataqore_{service}")))


def run_tool(service, action, url):
    environment = os.environ.copy()
    if service == "app":
        cli = ROOT / "controller/node_modules/prisma/build/index.js"
        if not cli.exists():
            raise ValueError("Instale as dependências com npm ci --prefix controller.")
        command = ["node", str(cli), "migrate"]
        command += ["resolve", "--applied", "0_initial"] if action == "baseline" else ["deploy"]
        environment["MIGRATION_DATABASE_URL"] = prisma_url(url)
        if action == "apply":
            key = os.environ.get("IDENTITY_ENCRYPTION_KEY")
            if key is None:
                config_path = Path(os.environ.get("DATAQORE_ENV_FILE", ROOT / "controller.env"))
                key = (dotenv_values(config_path, interpolate=False).get("IDENTITY_ENCRYPTION_KEY") if config_path.exists() else None)
            if not key or not re.fullmatch(r"[A-Za-z0-9_-]{43}", key) or base64.urlsafe_b64encode(base64.urlsafe_b64decode(key+"=")).decode().rstrip("=") != key:
                raise ValueError("Configure IDENTITY_ENCRYPTION_KEY before applying app migrations; existing keys are never replaced.")
            environment["IDENTITY_ENCRYPTION_KEY"] = key
        workdir = ROOT / "controller"
    else:
        command = [sys.executable, "-m", "alembic", "-c", str(ROOT / "engine/alembic.ini")]
        command += ["stamp", "0001_initial"] if action == "baseline" else ["upgrade", "head"]
        environment["MIGRATION_DATABASE_URL"] = sqlalchemy_url(url)
        workdir = ROOT / "engine"
    completed = subprocess.run(command, cwd=workdir, env=environment, capture_output=True, text=True)
    output = completed.stdout + completed.stderr
    # Não imprimir URLs/valores secretos retornados por drivers ou ferramentas.
    for secret in (url, postgres_url(url), prisma_url(url), sqlalchemy_url(url), unquote(urlsplit(url).password or "")):
        if secret:
            output = output.replace(secret, "[REDACTED]")
    if output.strip():
        print(output.strip())
    if not completed.returncode and service == "app" and action == "apply":
        built = ROOT / "controller/dist/src/identity-migrate.js"
        command = ["node", str(built)] if built.exists() else ["node", "--import", "tsx", "src/identity-migrate.ts"]
        backfill = subprocess.run(command, cwd=ROOT / "controller", env=environment, capture_output=True, text=True)
        if backfill.returncode:
            raise ValueError("Identity encryption backfill failed; do not start the controller. Restore the original key and rerun apply. No identity updates were committed.")
        print(backfill.stdout.strip())
    if not completed.returncode and service == "engine" and action == "apply":
        key = os.environ.get("CONNECTIONS_ENCRYPTION_KEY")
        if key is None:
            config_path = Path(os.environ.get("DATAQORE_ENV_FILE", ROOT / "engine.env"))
            key = dotenv_values(config_path, interpolate=False).get("CONNECTIONS_ENCRYPTION_KEY") if config_path.exists() else None
        try:
            from tools.encrypt_documents import encrypt_documents
            changed = encrypt_documents(url, key or "")
        except Exception:
            raise ValueError("Sensitive document encryption failed; all document changes rolled back. Check the original encryption key before starting the engine.") from None
        print(f"Sensitive engine documents verified; {changed} encrypted.")
    if completed.returncode:
        raise ValueError("Ferramenta de migration terminou com erro; nenhum baseline será presumido.")


def execute(service, action):
    url = load_url(service)
    with psycopg.connect(postgres_url(url), autocommit=True, connect_timeout=10) as connection:
        login, database = check_connection(connection, service)
        if action == "check":
            print(f"Conexão validada: {login} → {database}; owner correto.")
            return
        if action == "verify":
            verify(connection, service)
            print("Catálogo da revisão registrada, proprietários e grants conferidos.")
            return
        if action == "status":
            versions=history(connection, service)
            print("Histórico: " + (", ".join(versions) if versions else "sem baseline registrado"))
            if service == "app":
                local=[p.name for p in sorted((ROOT / "controller/prisma/migrations").iterdir()) if p.is_dir()]
                print("Pendentes: " + (", ".join(n for n in local if n not in versions) or "nenhuma"))
            else:
                from alembic.config import Config
                from alembic.script import ScriptDirectory
                heads=ScriptDirectory.from_config(Config(str(ROOT / "engine/alembic.ini"))).get_heads()
                print("Head local: " + ", ".join(heads))
            return
        # Serializa os comandos locais do mesmo serviço. Cada ferramenta também usa seu histórico.
        connection.execute("SELECT pg_advisory_lock(80418,%s)", (1 if service == "app" else 2,))
        versions = history(connection, service)
        initial = "0_initial" if service == "app" else "0001_initial"
        if action == "baseline":
            if versions and versions != [initial]:
                raise ValueError("Já existe histórico posterior/diferente. Baseline não pode rebaixar a versão.")
            verify(connection, service)
            if versions:
                protect_history(connection, service)
                print("Baseline já registrado e catálogo inicial conferido.")
                return
        elif not versions:
            schema = "app" if service == "app" else "engine"
            found=connection.execute("""SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n
                ON n.oid=c.relnamespace WHERE n.nspname=%s AND c.relkind IN ('r','p'))""",(schema,)).fetchone()[0]
            if found:
                raise ValueError("Database com tabelas e sem histórico: execute verify e baseline antes de apply.")
        try:
            run_tool(service, action, url)
        finally:
            schema, table = ("app", "_prisma_migrations") if service == "app" else ("engine", "alembic_version")
            if connection.execute("SELECT to_regclass(%s)",(f"{schema}.{table}",)).fetchone()[0]:
                protect_history(connection, service)
        print("Baseline registrado." if action == "baseline" else "Migrations aplicadas; histórico protegido.")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service",choices=("app","engine"))
    parser.add_argument("action",choices=("check","verify","status","baseline","apply"))
    args=parser.parse_args()
    try:
        execute(args.service,args.action)
    except (ValueError,psycopg.Error,OSError) as error:
        # Erros de conexão podem conter host/usuário, mas nunca ecoar o DSN ou a senha.
        if isinstance(error,psycopg.Error):
            print(f"Erro PostgreSQL ({error.sqlstate or 'conexão'}). Confira acesso/configuração; nenhuma credencial foi exibida.",file=sys.stderr)
        else:
            print(str(error),file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
