"""Snapshot estrutural para conferir o baseline, sem consultar dados do produto."""
import json
from datetime import datetime, timezone
from pathlib import Path
import re

from psycopg.rows import dict_row

def snapshot(connection, service):
    schema = "app" if service == "app" else "engine"
    owner = f"dataqore_{service}_owner"
    runtime = f"srv_dataqore_{service}"
    result = {}
    with connection.cursor(row_factory=dict_row) as cur:
        def query(name, sql, params=()):
            cur.execute(sql, params)
            result[name] = cur.fetchall()

        query("database", """SELECT datname, pg_get_userbyid(datdba) AS owner,
            pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname=current_database()""")
        query("schemas", """SELECT nspname, pg_get_userbyid(nspowner) AS owner,
            EXISTS (SELECT FROM aclexplode(coalesce(nspacl,acldefault('n',nspowner))) x
                WHERE x.grantee=0 AND x.privilege_type='CREATE') AS public_create,
            EXISTS (SELECT FROM aclexplode(coalesce(nspacl,acldefault('n',nspowner))) x
                WHERE x.grantee=0 AND x.privilege_type='USAGE') AS public_usage,
            has_schema_privilege(%s,oid,'CREATE') AS runtime_create,
            has_schema_privilege(%s,oid,'USAGE') AS runtime_usage
            FROM pg_namespace WHERE nspname IN (%s,'public') ORDER BY nspname""", (runtime,runtime,schema))
        query("tables", """SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
            pg_get_partkeydef(c.oid) AS partition_key FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%s
            AND c.relkind IN ('r','p','v','m','S','f') AND NOT c.relispartition
            AND c.relname NOT IN ('_prisma_migrations','alembic_version') ORDER BY c.relname""", (schema,))
        query("columns", """SELECT c.relname, a.attname, a.attnum,
            format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull,
            a.attidentity, a.attgenerated, co.collname AS collation,
            pg_get_expr(d.adbin,d.adrelid) AS default_value
            FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
            LEFT JOIN pg_collation co ON co.oid=a.attcollation
            WHERE n.nspname=%s AND NOT c.relispartition AND c.relkind IN ('r','p')
            AND c.relname NOT IN ('_prisma_migrations','alembic_version')
            AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum""", (schema,))
        query("constraints", """SELECT c.relname, con.conname, con.contype,
            pg_get_constraintdef(con.oid,true) AS definition FROM pg_constraint con
            JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=%s AND NOT c.relispartition
            AND c.relname NOT IN ('_prisma_migrations','alembic_version')
            ORDER BY c.relname,con.conname""", (schema,))
        query("indexes", """SELECT c.relname, ic.relname AS index_name,
            pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready
            FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
            JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=%s AND NOT c.relispartition
            AND c.relname NOT IN ('_prisma_migrations','alembic_version')
            ORDER BY c.relname,ic.relname""", (schema,))
        query("table_grants", """SELECT c.relname,
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
            x.privilege_type, x.is_grantable FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace,
            LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
            WHERE n.nspname=%s AND NOT c.relispartition AND c.relkind IN ('r','p')
            AND c.relname NOT IN ('_prisma_migrations','alembic_version') AND x.privilege_type <> 'MAINTAIN'
            ORDER BY c.relname,grantee,x.privilege_type""", (schema,))
        query("default_grants", """SELECT coalesce(n.nspname,'') AS schema,
            d.defaclobjtype AS object_type,
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
            x.privilege_type,x.is_grantable FROM pg_default_acl d
            LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace,
            LATERAL aclexplode(d.defaclacl) x WHERE d.defaclrole=%s::regrole
            ORDER BY schema,object_type,grantee,x.privilege_type""", (owner,))
        query("functions", """SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_get_function_result(p.oid) AS result, p.prosrc, p.proconfig, p.prosecdef,
            p.provolatile,p.proparallel,p.proisstrict,
            pg_get_userbyid(p.proowner) AS owner,
            has_function_privilege(%s,p.oid,'EXECUTE') AS runtime_execute
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname=%s ORDER BY p.proname,arguments""", (runtime, schema))
        query("triggers", """SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid,true) AS definition
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=%s AND NOT t.tgisinternal AND NOT c.relispartition
            ORDER BY c.relname,t.tgname""", (schema,))
        query("database_grants", """SELECT d.datname,
            has_database_privilege(%s,d.oid,'CONNECT') AS runtime_connect,
            has_database_privilege(%s,d.oid,'CREATE') AS runtime_create,
            has_database_privilege(%s,d.oid,'TEMP') AS runtime_temp,
            EXISTS (SELECT FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) x
                WHERE x.grantee=0) AS public_grants
            FROM pg_database d WHERE d.datname IN ('dataqore_app','dataqore_engine') ORDER BY datname""",
            (runtime, runtime, runtime))
        query("role_flags", """SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
            rolbypassrls,rolcanlogin,rolinherit FROM pg_roles
            WHERE rolname IN (%s,%s,%s) ORDER BY rolname""", (owner,runtime,runtime+"_migrator"))
        query("role_memberships", """SELECT pg_get_userbyid(member) AS member,
            pg_get_userbyid(roleid) AS granted_role,admin_option FROM pg_auth_members
            WHERE member IN (%s::regrole,%s::regrole,%s::regrole)
            ORDER BY member,granted_role""", (owner,runtime,runtime+"_migrator"))
    return result


def differences(expected, actual, prefix=""):
    """Relata caminhos divergentes; não inclui dados das tabelas ou credenciais."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        output = []
        for key in sorted(expected.keys() | actual.keys()):
            path = f"{prefix}.{key}" if prefix else key
            if key not in expected or key not in actual:
                output.append(f"{path}: entrada ausente ou inesperada")
            else:
                output.extend(differences(expected[key], actual[key], path))
        return output
    if expected != actual:
        if isinstance(expected,list) and isinstance(actual,list):
            if len(expected)!=len(actual):
                return [f"{prefix}: esperado {len(expected)} entradas, encontrado {len(actual)}"]
            output=[]
            for index,(left,right) in enumerate(zip(expected,actual)):
                label="/".join(str(left[k]) for k in ("relname","attname","conname","index_name","proname") if isinstance(left,dict) and k in left)
                output.extend(differences(left,right,f"{prefix}[{label or index}]"))
            return output
        return [f"{prefix}: catálogo difere do baseline esperado"]
    return []


def _verify(connection, service):
    version=service
    if service == "app":
        with connection.cursor() as cur:
            cur.execute("SELECT to_regclass('app._prisma_migrations')")
            if cur.fetchone()[0] is not None:
                cur.execute("SELECT migration_name FROM app._prisma_migrations WHERE migration_name IN ('1_schedules','2_environment_settings') AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1")
                row=cur.fetchone()
                if row:version='app_'+row[0]
    path = Path(__file__).with_name("baselines") / f"{version}.json"
    if service == "engine":
        exists = connection.execute("SELECT to_regclass('engine.alembic_version')").fetchone()[0]
        if exists:
            versions = connection.execute("SELECT version_num FROM engine.alembic_version").fetchall()
            if versions == [("0004_quality_rules",)]:
                path = path.with_name("engine_0004_quality_rules.json")
            elif versions == [("0003_databricks",)]:
                path = path.with_name("engine_0003_databricks.json")
            elif versions == [("0002_comparison_options",)]:
                path = path.with_name("engine_0002_comparison_options.json")
    expected = json.loads(path.read_text())
    actual = snapshot(connection, service)
    problems = differences(expected, actual)
    if service == "engine":
        with connection.cursor() as cur:
            cur.execute("""SELECT c.relname, pg_get_userbyid(c.relowner),
                pg_get_expr(c.relpartbound,c.oid) FROM pg_class c JOIN pg_inherits i ON i.inhrelid=c.oid
                WHERE i.inhparent='engine.metrics'::regclass ORDER BY c.relname""")
            partitions = cur.fetchall()
            if not partitions:
                problems.append("metrics: nenhuma partição mensal encontrada")
            for name, owner, bounds in partitions:
                try:
                    match=re.fullmatch(r"metrics_(\d{4})_(\d{2})",name)
                    if not match:
                        raise ValueError("nome inválido")
                    year,month=map(int,match.groups())
                    start=datetime(year,month,1,tzinfo=timezone.utc)
                    end=datetime(year+1,1,1,tzinfo=timezone.utc) if month==12 else datetime(year,month+1,1,tzinfo=timezone.utc)
                    limits=[datetime.fromisoformat(value) for value in re.findall(r"'([^']+)'",bounds)]
                    if owner != "dataqore_engine_owner" or limits != [start,end]:
                        raise ValueError("limites/proprietário inválidos")
                except ValueError:
                    problems.append(f"metrics.{name}: proprietário, nome ou intervalo mensal inesperado")
    if problems:
        raise ValueError("Baseline recusado:\n" + "\n".join(problems))
    return actual


def verify(connection, service):
    # Uma visão consistente do catálogo, sem nenhuma alteração de produto.
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return _verify(connection,service)
