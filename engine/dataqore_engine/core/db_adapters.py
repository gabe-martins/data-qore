"""Read-only DB-API adapters for metadata, bounded samples and key lookups.

Key selection scans eligible keys in batches; only selected records are materialized.
"""

from decimal import Decimal
from datetime import date, datetime, timezone
from dataclasses import dataclass
import re
from uuid import UUID


SUPPORTED_DATABASES = ("postgresql", "mysql", "sqlite", "mssql", "oracle")
MAX_CELL_BYTES = 65_536
MAX_SAMPLE_ROWS = 10_000
KEY_BATCH_ROWS = 100
KEY_BATCH_PARAMETERS = 900


@dataclass(frozen=True)
class TextCriterion:
    value: str
    fixed_width: bool = False


def _column(kind, nullable, **attributes):
    return {"type": kind or "", "nullable": nullable, "primary_key": False,
            "primary_key_order": None, "unique_groups": [], "unique_orders": {},
            **attributes}


class DatabaseAdapter:
    def __init__(self, db_type):
        self.db_type = db_type

    def quote_identifier(self, identifier):
        value = str(identifier)
        if not value or "\x00" in value:
            raise ValueError("Identifiers must be nonempty and cannot contain NUL")
        if self.db_type == "mysql":
            return "`" + value.replace("`", "``") + "`"
        if self.db_type == "mssql":
            return "[" + value.replace("]", "]]") + "]"
        return '"' + value.replace('"', '""') + '"'

    def qualified_name(self, schema, table):
        return ".".join(self.quote_identifier(part) for part in (schema, table) if part)

    # SQL percent signs in identifiers must be doubled only for execute(sql, params).
    def _bound_identifier(self, identifier):
        value = self.quote_identifier(identifier)
        return value.replace("%", "%%") if self.db_type in {"postgresql", "mysql"} else value

    def _bound_table(self, schema, table):
        return ".".join(self._bound_identifier(part) for part in (schema, table) if part)

    def _placeholder(self, position):
        if self.db_type == "oracle":
            return f":{position}"
        return "%s" if self.db_type in {"postgresql", "mysql"} else "?"

    def list_tables(self, conn):
        cursor = conn.cursor()
        try:
            if self.db_type == "sqlite":
                cursor.execute("PRAGMA database_list")
                schemas = [row[1] for row in cursor.fetchall()]
                tables = []
                for schema in schemas:
                    cursor.execute(f"SELECT name FROM {self.quote_identifier(schema)}.sqlite_master "
                                   "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                    tables.extend(("" if schema == "main" else schema, row[0])
                                  for row in cursor.fetchall())
                return tables
            if self.db_type == "oracle":
                query = "SELECT owner, table_name FROM all_tables ORDER BY owner, table_name"
            else:
                condition = (" AND table_schema NOT IN ('pg_catalog', 'information_schema')"
                             if self.db_type == "postgresql" else
                             " AND table_schema = DATABASE()" if self.db_type == "mysql" else "")
                query = ("SELECT table_schema, table_name FROM information_schema.tables "
                         "WHERE table_type = 'BASE TABLE'" + condition + " ORDER BY table_schema, table_name")
            cursor.execute(query)
            return [(row[0], row[1]) for row in cursor.fetchall()]
        finally:
            cursor.close()

    def metadata(self, conn, schema, table):
        if self.db_type == "sqlite":
            return self._sqlite_metadata(conn, schema or "main", table)
        if self.db_type == "oracle":
            return self._oracle_metadata(conn, schema, table)
        cursor = conn.cursor()
        try:
            placeholder = self._placeholder(1)
            default_schema = {"postgresql": "current_schema()", "mysql": "DATABASE()",
                              "mssql": "SCHEMA_NAME()"}[self.db_type]
            schema_sql = f"COALESCE(NULLIF({placeholder}, ''), {default_schema})"
            type_sql = "c.column_type" if self.db_type == "mysql" else "c.data_type"
            radix_sql = ("CASE WHEN c.data_type IN ('float', 'double', 'real') THEN 2 ELSE 10 END"
                         if self.db_type == "mysql" else "c.numeric_precision_radix")
            cursor.execute(f"""SELECT c.column_name, {type_sql}, c.is_nullable,
                c.character_maximum_length, c.numeric_precision, c.numeric_scale,
                c.datetime_precision, {radix_sql}, c.collation_name
                FROM information_schema.columns c
                WHERE c.table_schema = {schema_sql} AND c.table_name = {placeholder}
                ORDER BY c.ordinal_position""", (schema, table))
            metadata = {row[0]: _column(row[1], row[2] == "YES", length=row[3],
                                      precision=row[4], scale=row[5], datetime_precision=row[6],
                                      precision_radix=row[7], collation=row[8])
                        for row in cursor.fetchall()}
            cursor.execute(f"""SELECT tc.constraint_name, tc.constraint_type,
                ku.column_name, ku.ordinal_position
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage ku
                  ON tc.constraint_catalog = ku.constraint_catalog
                 AND tc.constraint_schema = ku.constraint_schema
                 AND tc.constraint_name = ku.constraint_name
                 AND tc.table_schema = ku.table_schema AND tc.table_name = ku.table_name
                WHERE tc.table_schema = {schema_sql} AND tc.table_name = {placeholder}
                  AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
                ORDER BY tc.constraint_name, ku.ordinal_position""", (schema, table))
            self._apply_constraints(metadata, cursor.fetchall())
            if self.db_type == "postgresql":
                # information_schema hides constraints from SELECT-only roles.
                # pg_index exposes actual validated identities without write grants.
                cursor.execute("""SELECT indexrel.relname,
                    CASE WHEN i.indisprimary THEN 'PRIMARY KEY' ELSE 'UNIQUE' END,
                    a.attname, k.ordinality
                    FROM pg_catalog.pg_index i
                    JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
                    JOIN pg_catalog.pg_class indexrel ON indexrel.oid=i.indexrelid
                    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
                    WHERE n.nspname=COALESCE(NULLIF(%s,''),current_schema()) AND t.relname=%s
                      AND i.indisunique AND i.indisvalid AND i.indisready
                      AND i.indpred IS NULL AND i.indexprs IS NULL AND k.ordinality<=i.indnkeyatts
                    ORDER BY indexrel.relname,k.ordinality""", (schema,table))
                self._apply_constraints(metadata,cursor.fetchall())
            if self.db_type == "mssql":
                # Unique indexes are also useful keys when they cover every row.
                cursor.execute("""SELECT i.name, 'UNIQUE', c.name, ic.key_ordinal
                    FROM sys.indexes i
                    JOIN sys.tables t ON t.object_id = i.object_id
                    JOIN sys.schemas s ON s.schema_id = t.schema_id
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                    WHERE s.name = COALESCE(NULLIF(?, ''), SCHEMA_NAME()) AND t.name = ?
                      AND i.is_unique = 1 AND i.is_disabled = 0 AND i.has_filter = 0
                      AND i.is_hypothetical = 0 AND ic.key_ordinal > 0
                    ORDER BY i.name, ic.key_ordinal""", (schema, table))
                self._apply_constraints(metadata, cursor.fetchall())
            for info in metadata.values():
                kind = info["type"].lower()
                if self.db_type == "mssql" and kind in {"timestamp", "rowversion"}:
                    info["family"] = "binary"
                elif self.db_type == "mssql" and kind == "uniqueidentifier":
                    info["family"] = "uuid"
                elif self.db_type == "mysql" and kind.startswith("bit"):
                    info["family"] = "binary"  # PyMySQL returns raw bytes for BIT.
                elif self.db_type == "mysql" and kind.startswith("timestamp"):
                    info["comparison_timezone"] = "UTC"
            return metadata
        finally:
            cursor.close()

    @staticmethod
    def _apply_constraints(metadata, rows):
        for constraint, kind, name, position in rows:
            if name not in metadata:
                continue
            info = metadata[name]
            if kind in {"PRIMARY KEY", "P"}:
                info.update(primary_key=True, primary_key_order=int(position))
            elif kind in {"UNIQUE", "U"}:
                group = str(constraint)
                if group not in info["unique_groups"]:
                    info["unique_groups"].append(group)
                info["unique_orders"][group] = int(position)

    def _oracle_metadata(self, conn, schema, table):
        cursor = conn.cursor()
        try:
            cursor.execute("""SELECT column_name, data_type, nullable,
                char_length, data_precision, data_scale, data_type_owner
                FROM all_tab_columns
                WHERE owner = COALESCE(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
                  AND table_name = :2 ORDER BY column_id""", (schema or None, table))
            metadata = {}
            for name, kind, nullable, length, precision, scale, type_owner in cursor.fetchall():
                upper = kind.upper()
                info = _column(kind, nullable == "Y", length=length or None, precision=precision,
                               scale=scale, precision_radix=2 if upper in {"FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE"} else 10,
                               datetime_precision=scale if upper.startswith("TIMESTAMP") else None)
                if upper == "DATE":
                    info["family"] = "datetime"  # Oracle DATE includes time of day.
                if type_owner:
                    info["unsupported_reason"] = f"Oracle object type {type_owner}.{kind}"
                metadata[name] = info
            cursor.execute("""SELECT c.constraint_name, c.constraint_type, cc.column_name, cc.position
                FROM all_constraints c JOIN all_cons_columns cc
                  ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
                 AND cc.table_name = c.table_name
                WHERE c.owner = COALESCE(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
                  AND c.table_name = :2 AND c.constraint_type IN ('P', 'U')
                  AND c.status = 'ENABLED' AND c.validated = 'VALIDATED'
                ORDER BY c.constraint_name, cc.position""", (schema or None, table))
            self._apply_constraints(metadata, cursor.fetchall())
            return metadata
        finally:
            cursor.close()

    def _sqlite_metadata(self, conn, schema, table):
        cursor = conn.cursor()
        try:
            quoted_schema, quoted_table = self.quote_identifier(schema), self.quote_identifier(table)
            cursor.execute(f"PRAGMA {quoted_schema}.table_xinfo({quoted_table})")
            columns = cursor.fetchall()
            if not columns:  # Compatibility with older SQLite lacking table_xinfo.
                cursor.execute(f"PRAGMA {quoted_schema}.table_info({quoted_table})")
                columns = cursor.fetchall()
            cursor.execute(f"PRAGMA {quoted_schema}.index_list({quoted_table})")
            indexes = cursor.fetchall()
            has_pk_index = any(row[3] == "pk" for row in indexes)
            cursor.execute(f"PRAGMA {quoted_schema}.table_list")
            enforced_pk = any(row[1] == table and row[0] == schema and (row[4] or row[5])
                              for row in cursor.fetchall())
            single_pk = sum(bool(row[5]) for row in columns) == 1
            metadata = {}
            for row in columns:
                # Hidden virtual table internals are excluded; generated columns are included.
                if len(row) > 6 and row[6] == 1:
                    continue
                name, kind, not_null, pk = row[1], row[2] or "", bool(row[3]), int(row[5])
                rowid_alias = single_pk and not has_pk_index and kind.upper() == "INTEGER"
                metadata[name] = _column(kind, not (not_null or pk and (enforced_pk or rowid_alias)),
                                         primary_key=bool(pk), primary_key_order=pk or None,
                                         generated=bool(len(row) > 6 and row[6] in {2, 3}))
            for index in indexes:
                if not index[2] or (len(index) > 4 and index[4]) or index[3] == "pk":
                    continue
                cursor.execute(f"PRAGMA {quoted_schema}.index_xinfo({self.quote_identifier(index[1])})")
                parts = [row for row in cursor.fetchall() if len(row) < 6 or row[5]]
                # Expression indexes cannot be looked up through ordinary column tuples.
                if not parts or any(row[1] < 0 or row[2] not in metadata for row in parts):
                    continue
                self._apply_constraints(metadata, [(index[1], "UNIQUE", part[2], part[0] + 1)
                                                   for part in parts])
            return metadata
        finally:
            cursor.close()

    def estimate_rows(self, conn, schema, table):
        if self.db_type == "sqlite":
            return None
        cursor = conn.cursor()
        savepoint = False
        try:
            if self.db_type == "postgresql" and not getattr(conn, "autocommit", False):
                cursor.execute("SAVEPOINT adq_estimate")
                savepoint = True
            if self.db_type == "postgresql":
                query = """SELECT c.reltuples::bigint FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = COALESCE(NULLIF(%s, ''), current_schema()) AND c.relname = %s"""
            elif self.db_type == "mysql":
                query = """SELECT table_rows FROM information_schema.tables
                    WHERE table_schema = COALESCE(NULLIF(%s, ''), DATABASE()) AND table_name = %s"""
            elif self.db_type == "mssql":
                query = """SELECT SUM(p.rows) FROM sys.tables t
                    JOIN sys.schemas s ON s.schema_id = t.schema_id
                    JOIN sys.partitions p ON p.object_id = t.object_id
                    WHERE s.name = COALESCE(NULLIF(?, ''), SCHEMA_NAME()) AND t.name = ?
                      AND p.index_id IN (0, 1)"""
            else:
                query = """SELECT num_rows FROM all_tables
                    WHERE owner = COALESCE(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')) AND table_name = :2"""
            cursor.execute(query, (schema or None, table))
            row = cursor.fetchone()
            if savepoint:
                cursor.execute("RELEASE SAVEPOINT adq_estimate")
                savepoint = False
            count = row[0] if row else None
            return int(count) if count is not None and int(count) >= 0 else None
        except Exception:
            if savepoint:
                cursor.execute("ROLLBACK TO SAVEPOINT adq_estimate")
                cursor.execute("RELEASE SAVEPOINT adq_estimate")
            return None
        finally:
            cursor.close()

    def _projection(self, columns, metadata):
        if not columns:
            raise ValueError("Sampling requires an explicit nonempty column projection")
        expressions, guards, unavailable = [], [], {}
        for index, name in enumerate(columns):
            info = (metadata or {}).get(name, {})
            kind = re.sub(r"\([^)]*\)", "", info.get("type", "").lower()).strip()
            quoted = self._bound_identifier(name)
            expression = quoted
            if self.db_type == "mssql" and kind in {"text", "ntext", "image", "xml"}:
                storage = {"text": "varchar(max)", "ntext": "nvarchar(max)",
                           "image": "varbinary(max)", "xml": "nvarchar(max)"}[kind]
                expression = f"CONVERT({storage}, {quoted})"
            reason = info.get("unsupported_reason")
            if self.db_type == "oracle" and kind in {"long", "long raw", "bfile", "xmltype"}:
                reason = f"Oracle {kind} is not supported for bounded capture"
            if self.db_type == "mssql" and kind in {"geography", "geometry", "hierarchyid", "sql_variant"}:
                reason = f"SQL Server {kind} is not supported for bounded capture"
            if reason:
                expression = "NULL"
                unavailable[index] = reason
            elif self.db_type == "databricks" and kind in {"timestamp","timestamp_ltz","timestamp_ntz"}:
                expression = f"date_format({quoted}, 'yyyy-MM-dd HH:mm:ss.SSSSSS')"
                if kind != 'timestamp_ntz':
                    expression = f"concat({expression}, '+00:00')"
            elif self.db_type == "mssql" and kind in {"datetime2", "datetimeoffset", "datetime", "smalldatetime", "time"}:
                expression = f"CONVERT(varchar(48), {quoted}, 126)"
            elif self.db_type == "oracle" and (kind == "date" or kind.startswith("timestamp")):
                fmt = 'YYYY-MM-DD"T"HH24:MI:SS'
                if kind.startswith("timestamp"):
                    fmt += ".FF9"
                if "time zone" in kind:
                    fmt += "TZH:TZM"
                    # LOCAL TIME ZONE is represented in session time, with its actual offset.
                    if "local" in kind:
                        expression = f"CAST({quoted} AS TIMESTAMP WITH TIME ZONE)"
                expression = f"TO_CHAR({expression}, '{fmt}')"
            else:
                length = self._size_expression(expression, kind, info)
                if length:
                    expression = f"CASE WHEN {length} > {MAX_CELL_BYTES} THEN NULL ELSE {expression} END"
                    guards.append((index, f"CASE WHEN {length} > {MAX_CELL_BYTES} THEN 1 ELSE 0 END"))
            expressions.append(f"{expression} AS {quoted}")
        taken = {name.casefold() for name in columns}
        for index, flag in guards:
            alias = '__adq_size_' + str(index)
            while alias.casefold() in taken:
                alias += '_'
            taken.add(alias.casefold())
            expressions.append(f"{flag} AS {self._bound_identifier(alias)}")
        return ", ".join(expressions), guards, unavailable

    def _size_expression(self, quoted, kind, info):
        text_binary = {"char", "character", "varchar", "character varying", "nvarchar", "nchar",
                       "text", "ntext", "tinytext", "mediumtext", "longtext", "binary", "varbinary",
                       "bytea", "blob", "tinyblob", "mediumblob", "longblob", "image", "bit", "xml"}
        if self.db_type == "sqlite":
            # SQLite can store a large text or BLOB value even in an INTEGER column.
            return f"length(CAST({quoted} AS BLOB))"
        if self.db_type == "postgresql" and (kind in {"json", "jsonb"} or kind.endswith("[]")):
            return f"pg_column_size({quoted})"
        if self.db_type == "postgresql" and kind == "xml":
            return f"OCTET_LENGTH(CAST({quoted} AS text))"
        if kind not in text_binary and info.get("family") not in {"text", "binary"}:
            return None
        if self.db_type in {"postgresql", "mysql"}:
            return f"OCTET_LENGTH({quoted})"
        if self.db_type == "mssql":
            return f"DATALENGTH({quoted})"
        return None

    @staticmethod
    def _materialize(rows, columns, guards, unavailable):
        from .quality import UnavailableValue

        materialized = []
        for raw in rows:
            values = list(raw[:len(columns)])
            for index, reason in unavailable.items():
                values[index] = UnavailableValue(reason)
            for position, (index, _) in enumerate(guards, len(columns)):
                if raw[position]:
                    values[index] = UnavailableValue(f"cell exceeds {MAX_CELL_BYTES} bytes")
            for index, value in enumerate(values):
                # Oracle LOB locators must be consumed while their connection is open.
                if callable(getattr(value, "read", None)):
                    try:
                        size = value.size() if callable(getattr(value, "size", None)) else None
                        if size is not None and size > MAX_CELL_BYTES:
                            values[index] = UnavailableValue(f"LOB exceeds {MAX_CELL_BYTES} units")
                            continue
                        value = value.read(1, MAX_CELL_BYTES + 1)
                    except Exception:
                        values[index] = UnavailableValue("LOB could not be read within the capture limit")
                        continue
                if isinstance(value, memoryview):
                    value = value.tobytes()
                if isinstance(value, (str, bytes, bytearray)) and len(value) > MAX_CELL_BYTES:
                    values[index] = UnavailableValue(f"cell exceeds {MAX_CELL_BYTES} units")
                else:
                    values[index] = value
            materialized.append(tuple(values))
        return materialized

    def _scope_sql(self, scope, start=1):
        terms, params = [], []
        for name, operator, values in scope or []:
            column = self._bound_identifier(name)
            sqlite_decimal = self.db_type == "sqlite" and any(isinstance(v, Decimal) for v in values)
            markers = []
            for value in values:
                if isinstance(value, TextCriterion):
                    params.append(value.value)
                    marker = self._placeholder(start + len(params) - 1)
                    if self.db_type == "sqlite":
                        marker = f"dataqore_scope_text({column}, {marker}) = 1"
                    elif self.db_type == "postgresql":
                        # Casting bpchar to text trims padding; its output
                        # function retains the value seen by the source driver.
                        expression = f"pg_catalog.textin(pg_catalog.bpcharout({column}))" if value.fixed_width else f"CAST({column} AS text)"
                        marker = f"pg_catalog.convert_to({expression}, 'UTF8') = pg_catalog.convert_to(CAST({marker} AS text), 'UTF8')"
                    elif self.db_type == "mysql":
                        marker = f"CAST(CONVERT({column} USING utf8mb4) AS BINARY) = CAST(CONVERT({marker} USING utf8mb4) AS BINARY)"
                    elif self.db_type == "mssql":
                        # BIN2 preserves code points; a final sentinel prevents
                        # SQL Server from ignoring trailing spaces at equality.
                        marker = f"((CONVERT(nvarchar(max), {column}) + NCHAR(1)) COLLATE Latin1_General_100_BIN2) = ((CONVERT(nvarchar(max), {marker}) + NCHAR(1)) COLLATE Latin1_General_100_BIN2)"
                    elif self.db_type == "databricks":
                        marker = f"encode({column}, 'UTF-8') = encode({marker}, 'UTF-8')"
                    else:
                        marker = f"DBMS_LOB.COMPARE(TO_NCLOB({column}), TO_NCLOB({marker})) = 0"
                    markers.append(marker)
                    continue
                oracle_aware = self.db_type == "oracle" and isinstance(value, datetime) and value.tzinfo is not None
                if self.db_type == "sqlite":
                    if isinstance(value, Decimal):
                        value = str(value)
                    elif isinstance(value, (date, datetime)):
                        if isinstance(value, datetime):
                            aware = value.tzinfo is not None
                            column = f"dataqore_scope_timestamp_{'aware' if aware else 'naive'}({self._bound_identifier(name)})"
                            if aware:
                                value = value.astimezone(timezone.utc).replace(tzinfo=None)
                            value = value.isoformat(sep=" ", timespec="microseconds")
                        else:
                            column = f"dataqore_scope_date({self._bound_identifier(name)})"
                            value = value.isoformat()
                elif self.db_type == "oracle" and isinstance(value, datetime) and value.tzinfo is not None:
                    value = value.isoformat(timespec="microseconds")
                elif self.db_type in {"mysql", "mssql"} and isinstance(value, datetime) and value.tzinfo is not None:
                    value = value.astimezone(timezone.utc).isoformat() if self.db_type == "mssql" else value.astimezone(timezone.utc).replace(tzinfo=None)
                params.append(value)
                marker = self._placeholder(start + len(params) - 1)
                if oracle_aware:
                    marker = f"TO_TIMESTAMP_TZ({marker}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF6TZH:TZM')"
                markers.append(marker)
            if values and isinstance(values[0], TextCriterion):
                term = "(" + " OR ".join(markers) + ")"
            elif sqlite_decimal:
                comparison = 'eq' if operator == 'in' else operator
                term = "(" + " OR ".join(f"dataqore_scope_decimal({column}, {marker}, '{comparison}') = 1" for marker in markers) + ")"
            elif operator in {"is_null", "is_not_null"}:
                term = column + (" IS NULL" if operator == "is_null" else " IS NOT NULL")
            elif operator == "in":
                term = column + " IN (" + ", ".join(markers) + ")"
            else:
                op = {"eq": "=", "gte": ">=", "lt": "<"}[operator]
                term = f"{column} {op} {markers[0]}"
            terms.append(term)
        if len(params) > 800:
            raise ValueError("Scope parameter budget exceeded")
        return " AND ".join(terms), params

    def _prepare_scope(self, conn, scope):
        if self.db_type != "sqlite" or not any(isinstance(v, (date, datetime, Decimal, TextCriterion)) for _, _, values in scope or [] for v in values):
            return

        def canonical_date(value):
            if value is None:
                return None
            if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError("Noncanonical source date")
            return date.fromisoformat(value).isoformat()

        def canonical_timestamp(value, aware):
            if value is None:
                return None
            if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?", value):
                raise ValueError("Noncanonical source timestamp")
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if (parsed.tzinfo is not None) != aware:
                raise ValueError("Source timestamp timezone conflicts with declared type")
            if aware:
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
            return parsed.isoformat(sep=" ", timespec="microseconds")

        def exact_decimal(value, threshold, operator):
            if value is None:
                return None
            if not isinstance(value, (int, float)):
                raise ValueError("Source numeric value conflicts with declared type")
            actual, limit = Decimal(str(value)), Decimal(threshold)
            if not actual.is_finite():
                raise ValueError("Nonfinite source numeric value")
            return int({'eq': actual == limit, 'gte': actual >= limit, 'lt': actual < limit}[operator])

        def exact_text(value, threshold):
            if value is None:
                return None
            if not isinstance(value, str):
                raise ValueError("Source text value conflicts with declared type")
            return int(value == threshold)

        conn.create_function("dataqore_scope_date", 1, canonical_date, deterministic=True)
        conn.create_function("dataqore_scope_timestamp_naive", 1, lambda v: canonical_timestamp(v, False), deterministic=True)
        conn.create_function("dataqore_scope_timestamp_aware", 1, lambda v: canonical_timestamp(v, True), deterministic=True)
        conn.create_function("dataqore_scope_decimal", 3, exact_decimal, deterministic=True)
        conn.create_function("dataqore_scope_text", 2, exact_text, deterministic=True)

    def validate_key(self, conn, schema, table, key_columns, scope=None):
        """Only aggregates leave the source; the entire eligible set is checked."""
        self._prepare_scope(conn, scope)
        table_sql = self._bound_table(schema, table)
        scope_sql, params = self._scope_sql(scope)
        where = " WHERE " + scope_sql if scope_sql else ""
        keys = [self._bound_identifier(k) for k in key_columns]
        nulls = " OR ".join(k + " IS NULL" for k in keys)
        count = "COUNT_BIG(*)" if self.db_type == "mssql" else "COUNT(*)"
        cursor = conn.cursor()
        try:
            null_count = ("COUNT_BIG" if self.db_type == "mssql" else "COUNT") + f"(CASE WHEN {nulls} THEN 1 END)"
            cursor.execute(f"SELECT {count}, {null_count} FROM {table_sql}{where}", tuple(params))
            total, null_rows = cursor.fetchone()
            # Nulls are diagnosed separately; duplicates among non-null keys.
            nonnull = " AND ".join(k + " IS NOT NULL" for k in keys)
            predicate = (scope_sql + " AND " if scope_sql else "") + nonnull
            cursor.execute(f"SELECT {count}, COALESCE(SUM(adq_n - 1), 0) FROM "
                f"(SELECT {count} AS adq_n FROM {table_sql} WHERE {predicate} "
                f"GROUP BY {', '.join(keys)} HAVING {count} > 1) adq_duplicates", tuple(params))
            groups, excess = cursor.fetchone()
            return dict(total_rows=int(total), null_key_rows=int(null_rows), duplicate_groups=int(groups),
                duplicate_excess_rows=int(excess), valid=not (null_rows or groups), scope="entire selected scope")
        finally:
            cursor.close()

    def count_rows(self, conn, schema, table, scope=None):
        self._prepare_scope(conn, scope)
        predicate, params = self._scope_sql(scope)
        aggregate = "COUNT_BIG(*)" if self.db_type == "mssql" else "COUNT(*)"
        cursor = conn.cursor()
        try:
            cursor.execute(f"SELECT {aggregate} FROM {self._bound_table(schema, table)}" +
                           (" WHERE " + predicate if predicate else ""), tuple(params))
            return int(cursor.fetchone()[0])
        finally:
            cursor.close()

    def iter_keys(self, conn, schema, table, columns, metadata, scope=None):
        self._prepare_scope(conn, scope)
        projection, guards, unavailable = self._projection(columns, metadata)
        predicate, params = self._scope_sql(scope)
        # Server-side cursor prevents a driver buffering the complete key scan.
        if self.db_type == "postgresql":
            from uuid import uuid4
            cursor = conn.cursor(name="adq_keys_" + uuid4().hex)
        elif self.db_type == "mysql":
            from pymysql.cursors import SSCursor
            cursor = conn.cursor(SSCursor)
        else:
            cursor = conn.cursor()
        try:
            cursor.execute(f"SELECT {projection} FROM {self._bound_table(schema, table)}" +
                           (" WHERE " + predicate if predicate else ""), tuple(params))
            while True:
                rows = cursor.fetchmany(256)
                if not rows:break
                yield from self._materialize(rows, columns, guards, unavailable)
        finally:
            cursor.close()

    def _bind_key(self, value, info):
        if value is None:
            raise ValueError("Null key values cannot be used for aligned sampling")
        kind = info.get("type", "").lower()
        if (kind.startswith(("date", "time", "smalldatetime"))
                and info.get("family") != "binary"):
            raise ValueError("Temporal keys require a configured cross-database conversion; select a supported business key")
        if isinstance(value, UUID):
            return str(value)
        if isinstance(value, (memoryview, bytearray)):
            return bytes(value)
        if self.db_type == "sqlite" and isinstance(value, Decimal):
            # sqlite3 cannot bind Decimal; text retains precision for SQLite's affinity rules.
            return str(value)
        if self.db_type == "oracle" and isinstance(value, bool):
            return int(value)
        return value

    def fetch_keys(self, conn, schema, table, columns, key_columns, values, metadata=None, scope=None):
        columns, key_columns, values = list(columns), list(key_columns), list(values)
        self._prepare_scope(conn, scope)
        from .quality import metadata_family
        exact_text_keys = {name for name in key_columns if scope is not None and metadata_family((metadata or {}).get(name, {})) == 'text'}
        if exact_text_keys:
            self._prepare_scope(conn, [(next(iter(exact_text_keys)), 'eq', [TextCriterion('')])])
        if not key_columns or any(key not in columns for key in key_columns):
            raise ValueError("Every key column must be present in the explicit projection")
        if len(key_columns) > KEY_BATCH_PARAMETERS:
            raise ValueError("Too many columns in the comparison key")
        if any(len(key) != len(key_columns) for key in values):
            raise ValueError("Key values must have exactly one value per key column")
        projection, guards, unavailable = self._projection(columns, metadata)
        if not values:
            return columns, []
        scope_sql, scope_params = self._scope_sql(scope)
        capacity = KEY_BATCH_PARAMETERS - len(scope_params)
        if len(key_columns) > capacity:
            raise ValueError("Scope and key exceed parameter budget")
        batch_size = max(1, min(KEY_BATCH_ROWS, capacity // len(key_columns)))
        table_sql = self._bound_table(schema, table)
        rows = []
        cursor = conn.cursor()
        try:
            for offset in range(0, len(values), batch_size):
                batch = values[offset:offset + batch_size]
                params, predicates = list(scope_params), []
                for key_values in batch:
                    terms = []
                    for name, value in zip(key_columns, key_values):
                        if name in exact_text_keys:
                            native = (metadata or {}).get(name, {}).get('type', '').lower().split('(')[0].strip()
                            exact, bound = self._scope_sql([(name, 'eq', [TextCriterion(value, native in {'char', 'character', 'nchar', 'bpchar'})])], start=len(params)+1)
                            params.extend(bound)
                            terms.append(exact)
                            continue
                        params.append(self._bind_key(value, (metadata or {}).get(name, {})))
                        terms.append(f"{self._bound_identifier(name)} = {self._placeholder(len(params))}")
                    predicates.append("(" + " AND ".join(terms) + ")")
                sql = f"SELECT {projection} FROM {table_sql} WHERE " + (scope_sql + " AND " if scope_sql else "") + "(" + " OR ".join(predicates) + ")"
                cursor.execute(sql, tuple(params))
                found = cursor.fetchmany(len(batch) + 1)
                if len(found) > len(batch):
                    raise ValueError("Declared comparison key returned duplicate rows")
                rows.extend(self._materialize(found, columns, guards, unavailable))
            return columns, rows
        finally:
            cursor.close()


_ADAPTERS = {kind: DatabaseAdapter(kind) for kind in SUPPORTED_DATABASES}


def get_adapter(db_type, catalog_name=""):
    if db_type == "databricks":
        from ..databricks import DatabricksAdapter
        return DatabricksAdapter(catalog_name)
    try:
        return _ADAPTERS[db_type]
    except (KeyError, TypeError):
        raise ValueError(f"Unsupported database type: {db_type!r}") from None
