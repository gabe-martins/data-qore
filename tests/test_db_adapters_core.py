"""Contratos SQL dos cinco adaptadores e integração SQLite com schemas."""

from decimal import Decimal
import sqlite3
import unittest
from unittest.mock import MagicMock

from dataqore_engine.connectors import PLUGINS
DB_TYPES = tuple(PLUGINS)
from dataqore_engine.core.db_adapters import MAX_CELL_BYTES, SUPPORTED_DATABASES, get_adapter
from dataqore_engine.core.quality import UnavailableValue


class AdapterTests(unittest.TestCase):
    def mock_connection(self, fetches=()):
        conn = MagicMock()
        cursor = conn.cursor.return_value
        cursor.fetchall.side_effect = list(fetches)
        cursor.fetchmany.return_value = []
        return conn, cursor

    def test_registry_contains_all_five_sources(self):
        self.assertEqual(set(SUPPORTED_DATABASES), {'postgresql', 'mysql', 'sqlite', 'mssql', 'oracle'})
        self.assertTrue(set(SUPPORTED_DATABASES) <= set(DB_TYPES))
        with self.assertRaises(ValueError):
            get_adapter('missing')

    def test_random_queries_bind_limits_for_every_dialect(self):
        for kind in SUPPORTED_DATABASES:
            with self.subTest(kind=kind):
                conn, cursor = self.mock_connection()
                get_adapter(kind).fetch_random(conn, 'schema', 'table', ['Id'], 64,
                                               metadata={'Id': {'type': 'integer'}})
                sql, params = cursor.execute.call_args.args
                self.assertEqual(params, (64,))
                self.assertNotIn('LIMIT 64', sql)
                self.assertIn({'postgresql': 'RANDOM()', 'mysql': 'RAND()', 'sqlite': 'RANDOM()',
                               'mssql': 'NEWID()', 'oracle': 'DBMS_RANDOM.VALUE'}[kind], sql)
                self.assertEqual(cursor.fetchmany.call_args.args, (64,))
                cursor.close.assert_called_once()

    def test_key_queries_quote_percent_and_parameterize_values(self):
        for kind in SUPPORTED_DATABASES:
            with self.subTest(kind=kind):
                conn, cursor = self.mock_connection()
                get_adapter(kind).fetch_keys(conn, 's', 'odd%table', ['key%name'], ['key%name'],
                                             [("a' OR 1=1 --",)], metadata={'key%name': {'type': 'varchar'}})
                sql, params = cursor.execute.call_args.args
                self.assertNotIn("a' OR", sql)
                self.assertEqual(params, ("a' OR 1=1 --",))
                self.assertIn('key%%name' if kind in {'postgresql', 'mysql'} else 'key%name', sql)

    def test_metadata_for_information_schema_dialects(self):
        for kind in ('postgresql', 'mysql', 'mssql'):
            with self.subTest(kind=kind):
                rows = [('Id', 'bigint', 'NO', None, 19, 0, None, 10, None),
                        ('Code', 'varchar', 'NO', 30, None, None, None, None, None)]
                batches = [rows, [('pk', 'PRIMARY KEY', 'Id', 1), ('uq', 'UNIQUE', 'Code', 1)]]
                if kind == 'mssql':
                    batches.append([])
                conn, cursor = self.mock_connection(batches)
                meta = get_adapter(kind).metadata(conn, 's', 't')
                self.assertTrue(meta['Id']['primary_key'])
                self.assertEqual(meta['Id']['primary_key_order'], 1)
                self.assertEqual(meta['Code']['unique_groups'], ['uq'])
                self.assertFalse(meta['Code']['nullable'])
                self.assertEqual(cursor.execute.call_args_list[0].args[1], ('s', 't'))

    def test_oracle_owner_constraints_and_date_semantics(self):
        conn, cursor = self.mock_connection([
            [('Id', 'NUMBER', 'N', 0, 12, 0, None),
             ('Occurred', 'DATE', 'Y', 0, None, None, None)], [('PK', 'P', 'Id', 1)]])
        metadata = get_adapter('oracle').metadata(conn, 'OtherOwner', 'MixedTable')
        self.assertEqual(metadata['Occurred']['family'], 'datetime')
        self.assertTrue(metadata['Id']['primary_key'])
        self.assertIn('all_tab_columns', cursor.execute.call_args_list[0].args[0])
        self.assertEqual(cursor.execute.call_args_list[0].args[1], ('OtherOwner', 'MixedTable'))
        self.assertIn("c.validated = 'VALIDATED'", cursor.execute.call_args_list[1].args[0])

    def test_native_temporal_and_binary_projection(self):
        for kind, typename, expected in [('mssql', 'datetime2', 'CONVERT(varchar(48)'),
                                          ('oracle', 'TIMESTAMP(9) WITH TIME ZONE', '.FF9TZH:TZM')]:
            with self.subTest(kind=kind):
                sql, guards, _ = get_adapter(kind)._projection(['Occurred'], {'Occurred': {'type': typename}})
                self.assertIn(expected, sql)
        conn, _ = self.mock_connection([[('Version', 'timestamp', 'NO', 8, None, None, None, None, None)], [], []])
        self.assertEqual(get_adapter('mssql').metadata(conn, 'dbo', 't')['Version']['family'], 'binary')

    def test_postgres_xml_and_sqlserver_legacy_text_are_bounded(self):
        projection, _, _ = get_adapter('postgresql')._projection(['x'], {'x': {'type': 'xml'}})
        self.assertIn('OCTET_LENGTH(CAST(', projection)
        projection, _, _ = get_adapter('mssql')._projection(['x'], {'x': {'type': 'ntext'}})
        self.assertIn('CONVERT(nvarchar(max)', projection)
        self.assertIn('DATALENGTH(', projection)

    def test_sqlite_attached_schema_and_bounded_values(self):
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute("ATTACH ':memory:' AS other")
        conn.execute('CREATE TABLE records (id INTEGER PRIMARY KEY)')
        conn.execute('CREATE TABLE other.records (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, data BLOB)')
        conn.execute('INSERT INTO other.records VALUES (?, ?, ?)', (1, 'x', b'z' * (MAX_CELL_BYTES + 1)))
        adapter = get_adapter('sqlite')
        metadata = adapter.metadata(conn, 'other', 'records')
        self.assertIn('code', metadata)
        self.assertTrue(metadata['code']['unique_groups'])
        self.assertIn(('other', 'records'), adapter.list_tables(conn))
        names, rows = adapter.fetch_keys(conn, 'other', 'records', list(metadata), ['id'], [(Decimal(1),)], metadata=metadata)
        self.assertEqual(names, ['id', 'code', 'data'])
        self.assertEqual(rows[0][:2], (1, 'x'))
        self.assertIsInstance(rows[0][2], UnavailableValue)

