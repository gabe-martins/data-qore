"""Carga administrativa explícita de dados sintéticos; não faz parte da API.

Usa a conexão SQL Server cadastrada sem imprimir ou copiar suas credenciais.
Nunca limpa tabelas. Reexecuções retomam apenas a tabela marcada por este script.
"""
import argparse
from datetime import date
import json
from pathlib import Path
import sys
from time import monotonic
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

TABLE = "dbo.dataqore_sample_sales"
MARKER = "dataqore-synthetic-sales-v1:2026-09-21"
CREATE = """
CREATE TABLE dbo.dataqore_sample_sales (
    SaleId bigint NOT NULL CONSTRAINT PK_dataqore_sample_sales PRIMARY KEY CLUSTERED,
    SaleDate datetime2(0) NOT NULL,
    SaleType varchar(20) NOT NULL,
    SellerId int NOT NULL,
    CustomerId bigint NOT NULL,
    PaymentMethod varchar(20) NOT NULL,
    Amount decimal(18,2) NOT NULL,
    Quantity smallint NOT NULL,
    Category varchar(30) NOT NULL,
    Region varchar(20) NOT NULL,
    Notes nvarchar(160) NULL
);
"""
INSERT = """
;WITH digits(n) AS (SELECT n FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) v(n)),
numbers AS (
    SELECT CAST(? AS bigint) + 1 + a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n AS n
    FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
)
INSERT INTO dbo.dataqore_sample_sales
    (SaleId,SaleDate,SaleType,SellerId,CustomerId,PaymentMethod,Amount,Quantity,Category,Region,Notes)
SELECT n,
    DATEADD(SECOND,CAST(n % 86400 AS int),DATEADD(DAY,CAST((n-1) % 30 AS int),CAST(? AS datetime2(0)))),
    CASE n % 3 WHEN 0 THEN 'Online' WHEN 1 THEN 'Store' ELSE 'Wholesale' END,
    CAST(n % 1000 + 1 AS int), n % 50000 + 1,
    CASE n % 4 WHEN 0 THEN 'PIX' WHEN 1 THEN 'Credit card' WHEN 2 THEN 'Debit card' ELSE 'Cash' END,
    CAST(CAST((n*7919) % 1000000 AS decimal(18,2))/100 AS decimal(18,2)),
    CAST(n % 10 + 1 AS smallint),
    CASE n % 7 WHEN 0 THEN 'Food' WHEN 1 THEN 'Electronics' WHEN 2 THEN 'Clothing'
        WHEN 3 THEN 'Home' WHEN 4 THEN 'Books' WHEN 5 THEN 'Sports' ELSE 'Services' END,
    CASE n % 5 WHEN 0 THEN 'North' WHEN 1 THEN 'Northeast' WHEN 2 THEN 'Central-West'
        WHEN 3 THEN 'Southeast' ELSE 'South' END,
    CASE WHEN n % 100 = 0 THEN NULL WHEN n % 100 = 1 THEN N''
        ELSE CONCAT(N'Synthetic sample #',n) END
FROM numbers WHERE n <= ?;
"""


def bounds(cursor):
    cursor.execute(f"SELECT COUNT_BIG(*),MIN(SaleId),MAX(SaleId) FROM {TABLE}")
    count, first, last = cursor.fetchone()
    if count and (first != 1 or last != count):
        raise ValueError("A sequência existente foi alterada. A carga foi interrompida sem remover dados.")
    return count


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection-id", type=UUID)
    parser.add_argument("--rows", type=int, default=1_200_000)
    parser.add_argument("--batch-size", type=int, default=100_000)
    parser.add_argument("--check", action="store_true", help="Somente consulta contagens; não cria nem carrega dados.")
    args = parser.parse_args(argv)
    if not 1 <= args.rows <= 5_000_000 or not 1 <= args.batch_size <= 100_000:
        parser.error("Use 1 a 5.000.000 de linhas e lotes de 1 a 100.000.")

    from sqlalchemy import select
    from dataqore_engine import models as m
    from dataqore_engine.connectors import SourceManager, PLUGINS
    from dataqore_engine.settings import load_settings
    from dataqore_engine.storage import database_engine

    settings = load_settings()
    engine = database_engine(settings)
    try:
        statement = select(m.connections).where(m.connections.c.connector == "mssql", m.connections.c.is_active.is_(True))
        if args.connection_id:
            statement = statement.where(m.connections.c.id == args.connection_id)
        with engine.connect() as conn:
            rows = conn.execute(statement).mappings().all()
        if len(rows) != 1:
            raise ValueError("Selecione uma única conexão SQL Server ativa usando --connection-id.")
        saved = rows[0]
        credentials = SourceManager(settings).decrypt(saved)
        # Deliberately outside SourceManager.session: writes belong only to this
        # user-invoked administrative tool; engine source sessions remain read-only.
        connection = PLUGINS["mssql"].opener(credentials)
        cursor = None
        started = monotonic()
        try:
            cursor = connection.cursor()
            cursor.execute("SET NOCOUNT ON; SET LOCK_TIMEOUT 15000; SET DEADLOCK_PRIORITY LOW;")
            cursor.execute("SELECT DB_NAME()")
            database = cursor.fetchone()[0]
            if database != credentials["database"]:
                raise ValueError("O database conectado difere da configuração selecionada.")
            print(json.dumps({"connection": saved["name"], "database": database, "table": TABLE,
                              "target_rows": args.rows, "synthetic": True}), flush=True)
            if not args.check:
                cursor.execute("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=N'DataQore:sample:dbo.dataqore_sample_sales', @LockMode='Exclusive', @LockOwner='Session', @LockTimeout=0; SELECT @r;")
                if cursor.fetchone()[0] < 0:
                    raise ValueError("Já existe uma carga em execução para esta tabela.")
            cursor.execute("SELECT OBJECT_ID(N'dbo.dataqore_sample_sales',N'U')")
            exists = cursor.fetchone()[0] is not None
            if not exists:
                if args.check:
                    print(json.dumps({"status": "not_created", "rows": 0}), flush=True)
                    return 0
                cursor.execute(CREATE)
                cursor.execute("EXEC sys.sp_addextendedproperty @name=N'DataQore.SampleSeed', @value=?, @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'dataqore_sample_sales'", (MARKER,))
                connection.commit()
            cursor.execute("SELECT CONVERT(nvarchar(200),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(N'dbo.dataqore_sample_sales') AND minor_id=0 AND name=N'DataQore.SampleSeed'")
            marker = cursor.fetchone()
            if not marker or marker[0] != MARKER:
                raise ValueError("A tabela existente não foi criada por esta versão do gerador. Nenhum dado foi removido.")
            loaded = bounds(cursor)
            if not args.check and loaded > args.rows:
                raise ValueError("A tabela já possui mais linhas que o solicitado. Nenhum dado foi removido.")
            while not args.check and loaded < args.rows:
                end = min(loaded + args.batch_size, args.rows)
                cursor.execute(INSERT, (loaded, date(2026, 9, 21), end))
                connection.commit()
                loaded = end
                print(json.dumps({"committed_rows": loaded, "target_rows": args.rows,
                                  "elapsed_seconds": round(monotonic()-started, 2)}), flush=True)
            cursor.execute(f"""SELECT COUNT_BIG(*),MIN(SaleId),MAX(SaleId),MIN(SaleDate),MAX(SaleDate),
                SUM(CAST(CASE WHEN Notes IS NULL THEN 1 ELSE 0 END AS bigint)),
                SUM(CAST(CASE WHEN Notes=N'' THEN 1 ELSE 0 END AS bigint)),MIN(Amount),MAX(Amount)
                FROM {TABLE}""")
            result = cursor.fetchone()
            if result[0] != loaded or (loaded and (result[1] != 1 or result[2] != loaded)):
                raise ValueError("A contagem final não corresponde à carga confirmada.")
            print(json.dumps({"status": "verified", "rows": result[0], "min_id": result[1], "max_id": result[2],
                "first_date": str(result[3]), "last_date": str(result[4]), "null_notes": result[5],
                "blank_notes": result[6], "min_amount": str(result[7]), "max_amount": str(result[8]),
                "elapsed_seconds": round(monotonic()-started, 2)}), flush=True)
            connection.rollback()  # End the final read transaction; batches are already committed.
            return 0
        except BaseException:
            connection.rollback()
            raise
        finally:
            if cursor is not None:
                cursor.close()
            connection.close()
    finally:
        engine.dispose()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        # Driver messages can contain secrets. Report type only.
        print(f"Carga interrompida ({type(error).__name__}). Lotes confirmados podem ser retomados; confira acesso e espaço no servidor.", file=sys.stderr)
        raise SystemExit(1)
