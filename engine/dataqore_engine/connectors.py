"""Plugins de fonte: abertura somente leitura e descarte por operação."""
from contextlib import contextmanager
from dataclasses import dataclass
import importlib
import importlib.util
import json
from pathlib import Path
import sqlite3

from cryptography.fernet import Fernet,InvalidToken

from .core.db_adapters import get_adapter
from .schemas import ConnectionTest
from .storage import DomainError


def postgres(creds):
    driver=importlib.import_module("psycopg")
    return driver.connect(host=creds["hostname"],port=creds.get("port") or 5432,
        dbname=creds["database"],user=creds["username"],password=creds["password"],
        sslmode=creds.get("sslmode","prefer"),connect_timeout=10)


def mysql(creds):
    driver=importlib.import_module("pymysql")
    return driver.connect(host=creds["hostname"],port=creds.get("port") or 3306,
        database=creds["database"],user=creds["username"],password=creds["password"],
        connect_timeout=10,read_timeout=30,write_timeout=30,autocommit=False)


def oracle(creds):
    driver=importlib.import_module("oracledb")
    params=driver.ConnectParams(host=creds["hostname"],port=creds.get("port") or 1521,
        service_name=creds["database"],tcp_connect_timeout=10)
    return driver.connect(user=creds["username"],password=creds["password"],params=params)


def odbc_value(value):
    value=str(value)
    return "{"+value.replace("}","}}")+"}"


def mssql(creds):
    driver=importlib.import_module("mssql_python")
    fields={"SERVER":f"{creds['hostname']},{creds.get('port') or 1433}",
        "DATABASE":creds["database"],"UID":creds["username"],"PWD":creds["password"]}
    dsn=";".join(f"{k}={odbc_value(v)}" for k,v in fields.items())
    dsn+=";Encrypt=yes;TrustServerCertificate="+("yes" if creds.get("trust_server_certificate") else "no")+";Connection Timeout=10;"
    return driver.connect(dsn)


@dataclass(frozen=True)
class Plugin:
    module: str
    opener: object


PLUGINS={"postgresql":Plugin("psycopg",postgres),"mysql":Plugin("pymysql",mysql),
    "oracle":Plugin("oracledb",oracle),"mssql":Plugin("mssql_python",mssql),
    "sqlite":Plugin("sqlite3",None)}


def prepare_read_session(conn,kind):
    cursor=conn.cursor()
    try:
        if kind=="postgresql":
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            cursor.execute("SET LOCAL statement_timeout = '30000ms'")
        elif kind=="mysql":
            cursor.execute("START TRANSACTION READ ONLY")
        elif kind=="sqlite":
            cursor.execute("PRAGMA query_only = ON")
        elif kind=="oracle":
            conn.call_timeout=30000
            cursor.execute("SET TRANSACTION READ ONLY")
        elif kind=="mssql":
            conn.timeout=30
            cursor.execute("SET LOCK_TIMEOUT 15000")
    finally:
        cursor.close()


class SourceManager:
    def __init__(self,settings):
        self.settings=settings
        self.fernet=Fernet(settings.encryption_key.encode())

    def available(self):
        return [{"connector":kind,"driver":plugin.module,
            "available":importlib.util.find_spec(plugin.module) is not None} for kind,plugin in PLUGINS.items()]

    def encrypt(self,kind,credentials):
        checked=ConnectionTest(connector=kind,credentials=credentials)
        data=checked.credentials.model_dump(exclude={"password"})
        if checked.credentials.password is not None:
            data["password"]=checked.credentials.password.get_secret_value()
        if kind=="sqlite":
            data["database"]=str(self.sqlite_path(data["database"]))
        return self.fernet.encrypt(json.dumps(data).encode()).decode()

    def decrypt(self,row):
        if row["encryption_key_version"]!=self.settings.encryption_key_version:
            raise DomainError(503,"encryption_key_version_unavailable","Versão da chave de conexão indisponível.")
        try:
            return json.loads(self.fernet.decrypt(row["credentials_ciphertext"].encode()))
        except (InvalidToken,ValueError,TypeError):
            raise DomainError(503,"connection_decryption_failed","Não foi possível abrir a configuração da conexão.") from None

    def sqlite_path(self,database):
        candidate=Path(database)
        if not candidate.is_absolute():
            candidate=self.settings.sqlite_allowed_root / candidate
        try:
            path=candidate.resolve(strict=True)
            if not path.is_relative_to(self.settings.sqlite_allowed_root) or not path.is_file():
                raise ValueError
        except (OSError,ValueError):
            raise DomainError(422,"sqlite_path_not_allowed","Informe um arquivo SQLite existente dentro de SQLITE_ALLOWED_ROOT.") from None
        return path

    @contextmanager
    def session(self,row):
        if not row["is_active"]:
            raise DomainError(409,"connection_inactive","A conexão está desativada.")
        kind=row["connector"]
        creds=self.decrypt(row)
        conn=None
        try:
            if kind=="sqlite":
                path=self.sqlite_path(creds["database"])
                conn=sqlite3.connect(path.as_uri()+"?mode=ro",uri=True,timeout=30)
            else:
                plugin=PLUGINS[kind]
                if importlib.util.find_spec(plugin.module) is None:
                    raise DomainError(503,"driver_unavailable","O driver desta fonte não está instalado.")
                conn=plugin.opener(creds)
            prepare_read_session(conn,kind)
            yield {"connection":row["name"],"creds":{"type":kind},"conn":conn,"adapter":get_adapter(kind)}
        except DomainError:
            raise
        except Exception:
            raise DomainError(503,"source_unavailable","Falha ao consultar a fonte. Verifique acesso, configuração e permissões.") from None
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def test(self,row):
        with self.session(row) as source:
            cursor=source["conn"].cursor()
            try:
                cursor.execute("SELECT 1 FROM DUAL" if row["connector"]=="oracle" else "SELECT 1")
                cursor.fetchone()
            finally:
                cursor.close()
        return {"status":"ok"}

    def catalog(self,row):
        with self.session(row) as source:
            return source["adapter"].list_tables(source["conn"])

    def table_metadata(self,row,schema,table):
        if row["connector"]=="sqlite" and schema=="main":
            schema=""
        with self.session(row) as source:
            if (schema,table) not in source["adapter"].list_tables(source["conn"]):
                raise DomainError(404,"source_table_not_found","Tabela não encontrada no catálogo atual.")
            columns=source["adapter"].metadata(source["conn"],schema,table)
            estimate=source["adapter"].estimate_rows(source["conn"],schema,table)
        return schema,{"columns":columns,"estimated_rows":estimate}
