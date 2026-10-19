"""Plugins de fonte: abertura somente leitura e descarte por operação."""
from contextlib import contextmanager
from dataclasses import dataclass
import importlib
import importlib.util
import json
from pathlib import Path
import sqlite3
from time import monotonic

from cryptography.fernet import Fernet,InvalidToken

from .core.db_adapters import get_adapter
from .schemas import ConnectionTest
from .storage import DomainError


class ReadOnlySQLiteConnection(sqlite3.Connection):
    def cursor(self, *args, **kwargs):
        deadline=monotonic()+30
        self.set_progress_handler(lambda: int(monotonic() >= deadline),1000)
        return super().cursor(*args,**kwargs)


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
    dsn+=";Encrypt=yes;TrustServerCertificate="+("yes" if creds.get("trust_server_certificate") else "no")+";"
    return driver.connect(dsn,timeout=10)


@dataclass(frozen=True)
class Plugin:
    module: str
    opener: object


PLUGINS={"postgresql":Plugin("psycopg",postgres),"mysql":Plugin("pymysql",mysql),
    "oracle":Plugin("oracledb",oracle),"mssql":Plugin("mssql_python",mssql),
    "sqlite":Plugin("sqlite3",None)}


def source_failure(kind,error,connected=True):
    """Classify source failures without returning/logging driver messages."""
    if kind=="sqlite" and "user-defined function raised exception" in str(error).lower():
        return DomainError(503,"source_scope_encoding_invalid",
            "SQLite scope values must match their declared numeric/text types or canonical ISO date/timestamp encoding; timestamp precision is at most six fractional digits.")
    if kind=="mssql" and any(marker in str(error).lower() for marker in (
        "self-signed certificate","certificate verify failed","certificate chain was issued by an authority that is not trusted",
        "hostname mismatch","certificate subject name does not match")):
        return DomainError(503,"source_mssql_certificate_invalid",
            "O certificado do SQL Server não foi validado. Configure um certificado confiável; para uma exceção local explícita, use Trust server certificate.")
    reason=None
    if kind=="postgresql":
        reason={"28P01":"authentication_failed","28000":"access_denied",
            "3D000":"database_not_found","42501":"permission_denied",
            "57P03":"server_unavailable","53300":"server_unavailable",
            "57014":"query_timeout"}.get(getattr(error,"sqlstate",None))
        # libpq connection failures often lack SQLSTATE. Inspect locally only;
        # never interpolate this text, which can contain user/database/password.
        message=str(error).lower()
        if reason is None:
            for markers,category in [
                (("no pg_hba.conf entry",),"access_denied"),
                (("password authentication failed","no password supplied","authentication failed"),"authentication_failed"),
                (("could not translate host name","name or service not known","nodename nor servname provided"),"host_unresolved"),
                (("connection refused",),"connection_refused"),
                (("timeout expired","connection timed out"),"connection_timeout"),
                (("no route to host","network is unreachable"),"network_unreachable"),
                (("certificate verify failed","server does not support ssl","ssl error","ssl connection","root certificate file","private key file"),"tls_error"),
                (("database system is starting up","database system is shutting down","too many clients","remaining connection slots"),"server_unavailable"),
            ]:
                if category and any(marker in message for marker in markers):
                    reason=category;break
            if reason is None and "database" in message and "does not exist" in message:
                reason="database_not_found"
    if reason is None and kind != "postgresql":
        message=str(error).lower()
        if any(marker in message for marker in ("timeout", "timed out", "ora-01013", "ora-03156", "dpy-4024", "maximum statement execution time exceeded")) or kind=="sqlite" and message=="interrupted":
            reason="query_timeout" if connected else "connection_timeout"
    descriptions={
        "authentication_failed":"O PostgreSQL recusou a autenticação. Confira usuário e senha da fonte.",
        "access_denied":"O PostgreSQL recusou o acesso. Confira pg_hba.conf, usuário e database da fonte.",
        "database_not_found":"O database informado não existe no servidor PostgreSQL.",
        "permission_denied":"A conta da fonte não possui permissão para esta operação de leitura.",
        "host_unresolved":"Não foi possível resolver o host da fonte. Informe somente o hostname ou IP.",
        "connection_refused":"A fonte recusou a conexão. Confira host, porta e se o PostgreSQL está escutando.",
        "connection_timeout":"A conexão com a fonte excedeu o tempo limite. Confira rede e firewall.",
        "network_unreachable":"Não há rota de rede até a fonte. Confira conectividade e firewall.",
        "tls_error":"Falha na negociação SSL da fonte. Confira o modo SSL e os certificados do servidor.",
        "server_unavailable":"O PostgreSQL da fonte não está aceitando conexões neste momento.",
        "query_timeout":"A consulta na fonte excedeu o tempo limite.",
    }
    if reason:return DomainError(503,"source_"+reason,descriptions[reason])
    return DomainError(503,"source_unavailable","Falha ao consultar a fonte. Verifique acesso, configuração e permissões.")


def prepare_read_session(conn,kind,comparison=False):
    cursor=conn.cursor()
    consistency="best_effort"
    try:
        if kind=="postgresql":
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            cursor.execute("SET LOCAL statement_timeout = '30000ms'")
            consistency="stable_snapshot"
        elif kind=="mysql":
            if comparison:
                cursor.execute("SET SESSION MAX_EXECUTION_TIME = 30000")
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                cursor.execute("SET time_zone = '+00:00'")
            cursor.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY" if comparison else "START TRANSACTION READ ONLY")
            if comparison:
                consistency="transactional_snapshot_pending"
        elif kind=="sqlite":
            cursor.execute("PRAGMA query_only = ON")
            if comparison:
                cursor.execute("PRAGMA journal_mode")
                journal=cursor.fetchone()
                if journal and str(journal[0]).lower()=="wal":
                    cursor.execute("BEGIN")
                    consistency="stable_snapshot"
        elif kind=="oracle":
            conn.call_timeout=30000
            cursor.execute("SET TRANSACTION READ ONLY")
            consistency="stable_snapshot"
        elif kind=="mssql":
            conn.timeout=30
            cursor.execute("SET LOCK_TIMEOUT 15000")
            if comparison:
                try:
                    cursor.execute("SELECT snapshot_isolation_state FROM sys.databases WHERE name = DB_NAME()")
                    enabled=cursor.fetchone()[0] == 1
                    conn.rollback()
                    if enabled:
                        cursor.execute("SET TRANSACTION ISOLATION LEVEL SNAPSHOT")
                        consistency="stable_snapshot"
                except Exception:
                    conn.rollback()
                cursor.execute("SET LOCK_TIMEOUT 15000")
    finally:
        cursor.close()
    return consistency


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
    def session(self,row,comparison=False):
        if not row["is_active"]:
            raise DomainError(409,"connection_inactive","A conexão está desativada.")
        kind=row["connector"]
        creds=self.decrypt(row)
        conn=None
        try:
            if kind=="sqlite":
                path=self.sqlite_path(creds["database"])
                conn=sqlite3.connect(path.as_uri()+"?mode=ro",uri=True,timeout=30,factory=ReadOnlySQLiteConnection)
            else:
                plugin=PLUGINS[kind]
                if importlib.util.find_spec(plugin.module) is None:
                    raise DomainError(503,"driver_unavailable","O driver desta fonte não está instalado.")
                conn=plugin.opener(creds)
            consistency=prepare_read_session(conn,kind,comparison=comparison)
            yield {"connection":row["name"],"creds":{"type":kind},"conn":conn,"adapter":get_adapter(kind),
                "read_consistency":consistency}
        except DomainError:
            raise
        except Exception as error:
            raise source_failure(kind,error,connected=conn is not None) from None
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
