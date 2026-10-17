"""Regressões do motor v3 sobre fontes SQLite independentes e controladas."""

import json
import sqlite3
import unittest

from dataqore_engine.core.comparison_engine import execute_comparison
from dataqore_engine.core.sampling import SamplingOptions


class EngineV3Tests(unittest.TestCase):
    def test_large_equal_cells_are_inconclusive_not_false_matches(self):
        ddl = 'CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)'
        rows = [(1, 'x' * 70000)]
        result = execute_comparison([self.source('a', rows, ddl=ddl),
                                     self.source('b', rows, ddl=ddl)], sample_size=30)
        self.assertEqual(result['summary']['status'], 'inconclusive')
        self.assertEqual(result['row_comparisons'][0]['incomparable_values']['value'], 1)
        self.assertEqual(result['sources'][0]['metrics']['value']['distinct_denominator'], 0)

    def test_equivalent_numeric_native_types_are_observations(self):
        a = self.source('a', [(1, 12)], ddl='CREATE TABLE records (id INTEGER PRIMARY KEY, amount INTEGER)')
        b = self.source('b', [(1, 12)], ddl='CREATE TABLE records (id INTEGER PRIMARY KEY, amount NUMERIC)')
        result = execute_comparison([a, b], sample_size=30)
        self.assertEqual(result['summary']['status'], 'compatible_in_sample')
        self.assertEqual(result['summary']['schema_differences'], 0)
        self.assertTrue(any(f['kind'] == 'compatible_native_types' for f in result['schema_findings']))

    def test_cell_budget_must_fit_one_projected_row(self):
        with self.assertRaisesRegex(ValueError, 'Cell budget'):
            execute_comparison([self.source('a'), self.source('b')], options=SamplingOptions(max_cells=1))

    def source(self, label, rows=(), *, ddl=None, uppercase=False):
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        ddl = ddl or (
            'CREATE TABLE records (Tenant TEXT NOT NULL, Id INTEGER NOT NULL, '
            'Value TEXT, Amount NUMERIC, PRIMARY KEY (Tenant, Id))'
            if uppercase else
            'CREATE TABLE records (tenant TEXT NOT NULL, id INTEGER NOT NULL, '
            'value TEXT, amount NUMERIC, PRIMARY KEY (tenant, id))'
        )
        conn.execute(ddl)
        if rows:
            placeholders = ", ".join("?" for _ in rows[0])
            conn.executemany(f"INSERT INTO records VALUES ({placeholders})", rows)
        return {
            "conn": conn, "creds": {"type": "sqlite"}, "schema": "",
            "table": "records", "connection": label,
        }

    def test_auto_aligns_composite_keys_and_case_insensitive_columns(self):
        rows = [("a", 1, "first", 10), ("a", 2, None, 4), ("b", 1, "third", 7)]
        result = execute_comparison([
            self.source("reference", rows),
            self.source("target", list(reversed(rows)), uppercase=True),
        ], sample_size=30)

        self.assertEqual(result["sampling_plan"]["mode"], "matched_keys")
        self.assertEqual(set(result["sampling_plan"]["key_columns"]), {"tenant", "id"})
        self.assertEqual(result["summary"]["status"], "compatible_in_sample")
        pair, = result["row_comparisons"]
        self.assertEqual(pair["common_keys"], 3)
        self.assertEqual(pair["different_rows"], 0)
        self.assertEqual(pair["missing_in_reference"], 0)
        self.assertEqual(pair["missing_in_target"], 0)
        self.assertTrue(all(count == 0 for count in pair["different_values"].values()))
        self.assertEqual(result["sources"][0]["sample_size"], 3)
        self.assertEqual(result["sources"][1]["sample_size"], 3)
        self.assertTrue(result["metric_comparisons"])

    def test_single_run_detects_extra_keys_on_both_sides_and_changed_values(self):
        left = [("a", 1, "same", 10), ("a", 2, "before", 20), ("left", 9, "only left", 9)]
        right = [("a", 1, "same", 10), ("a", 2, "after", 21), ("right", 8, "only right", 8)]
        result = execute_comparison([
            self.source("reference", left), self.source("target", right),
        ], sample_size=30)

        pair, = result["row_comparisons"]
        self.assertEqual(pair["common_keys"], 2)
        self.assertEqual(pair["missing_in_reference"], 1)
        self.assertEqual(pair["missing_in_target"], 1)
        self.assertEqual(pair["different_rows"], 1)
        self.assertEqual(pair["different_values"]["value"], 1)
        self.assertEqual(pair["different_values"]["amount"], 1)
        self.assertEqual(result["summary"]["status"], "difference_observed")

    def test_strings_in_composite_keys_are_bound_parameters(self):
        rows = [("x' OR 1=1 --", 7, "present", 4), ("regular", 8, "other", 9)]
        result = execute_comparison([
            self.source("reference", rows), self.source("target", list(reversed(rows))),
        ], sample_size=30)
        self.assertEqual(result["row_comparisons"][0]["common_keys"], 2)
        self.assertEqual(result["summary"]["status"], "compatible_in_sample")

    def test_primary_key_declaration_order_does_not_change_alignment(self):
        left = self.source("reference", [("a", 1, "same", 1), ("b", 1, "same", 2)])
        right = self.source(
            "target", [(1, "b", "same", 2), (1, "a", "same", 1)],
            ddl='CREATE TABLE records (Id INTEGER NOT NULL, Tenant TEXT NOT NULL, '
                'Value TEXT, Amount NUMERIC, PRIMARY KEY (Id, Tenant))',
        )
        result = execute_comparison([left, right], sample_size=30)
        self.assertEqual(result["summary"]["status"], "compatible_in_sample")
        self.assertEqual(result["row_comparisons"][0]["common_keys"], 2)

    def test_nonnullable_unique_key_is_usable_without_primary_key(self):
        ddl = 'CREATE TABLE records (code TEXT NOT NULL UNIQUE, value TEXT)'
        rows = [("a", "one"), ("b", "two")]
        result = execute_comparison([
            self.source("reference", rows, ddl=ddl),
            self.source("target", list(reversed(rows)), ddl=ddl),
        ], sample_size=30)
        self.assertEqual(result["sampling_plan"]["mode"], "matched_keys")
        self.assertEqual(result["sampling_plan"]["key_columns"], ["code"])
        self.assertEqual(result["summary"]["status"], "compatible_in_sample")

    def test_nullable_unique_key_does_not_claim_entity_equivalence(self):
        ddl = 'CREATE TABLE records (code TEXT UNIQUE, value TEXT)'
        result = execute_comparison([
            self.source("reference", [(None, "one"), (None, "two")], ddl=ddl),
            self.source("target", [(None, "one"), (None, "two")], ddl=ddl),
        ], sample_size=30)
        self.assertEqual(result["sampling_plan"]["mode"], "independent_random")
        self.assertEqual(result["row_comparisons"], [])
        self.assertEqual(result["summary"]["status"], "profile_only")

    def test_no_keys_yields_profiles_and_never_row_equality(self):
        ddl = 'CREATE TABLE records (value TEXT, amount NUMERIC)'
        result = execute_comparison([
            self.source("reference", [("a", 1), ("b", 2)], ddl=ddl),
            self.source("target", [("a", 1), ("b", 2)], ddl=ddl),
        ], sample_size=30)
        self.assertEqual(result["sampling_plan"]["mode"], "independent_random")
        self.assertEqual(result["summary"]["status"], "profile_only")
        self.assertEqual(result["row_comparisons"], [])
        self.assertTrue(result["metric_comparisons"])

    def test_explicit_alignment_requires_a_compatible_key(self):
        ddl = 'CREATE TABLE records (value TEXT)'
        left, right = self.source("a", [("same",)], ddl=ddl), self.source("b", [("same",)], ddl=ddl)
        with self.assertRaises(ValueError):
            execute_comparison([left, right], mode="matched_keys")

    def test_empty_tables_are_inconclusive_and_metrics_are_unavailable(self):
        result = execute_comparison([self.source("a"), self.source("b")], sample_size=30)
        self.assertEqual(result["summary"]["status"], "inconclusive")
        self.assertEqual(result["row_comparisons"][0]["common_keys"], 0)
        for source in result["sources"]:
            self.assertEqual(source["sample_size"], 0)
            self.assertIsNone(source["metrics"]["amount"]["null_rate"])

    def test_empty_reference_still_discovers_target_records(self):
        result = execute_comparison([
            self.source("empty"), self.source("populated", [("a", 1, "one", 1)]),
        ], sample_size=30)
        pair, = result["row_comparisons"]
        self.assertEqual(pair["common_keys"], 0)
        self.assertEqual(pair["missing_in_reference"], 1)
        self.assertEqual(pair["missing_in_target"], 0)
        self.assertEqual(result["summary"]["status"], "difference_observed")

    def test_incompatible_column_type_prevents_compatible_result(self):
        left = self.source("reference", [(1, 42)],
                           ddl='CREATE TABLE records (id INTEGER PRIMARY KEY, value INTEGER)')
        right = self.source("target", [(1, "42")],
                            ddl='CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)')
        result = execute_comparison([left, right], sample_size=30)
        self.assertNotEqual(result["summary"]["status"], "compatible_in_sample")
        self.assertTrue(any(f["kind"] == "type_family" for f in result["schema_findings"]))
        self.assertNotEqual(result["row_comparisons"][0]["status"], "compatible_in_sample")

    def test_unicode_column_name_collision_is_rejected(self):
        ddl = 'CREATE TABLE records (id INTEGER PRIMARY KEY, "ß" TEXT, "ss" TEXT)'
        sources = [self.source("a", [(1, "a", "b")], ddl=ddl),
                   self.source("b", [(1, "a", "b")], ddl=ddl)]
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            execute_comparison(sources)

    def test_dynamic_sampling_obeys_shared_row_budget(self):
        rows = [("tenant", index, None if index % 2 else "text", index ** 2)
                for index in range(300)]
        options = SamplingOptions(max_rows=96, seed=12345)
        result = execute_comparison([
            self.source("reference", rows), self.source("target", list(reversed(rows))),
        ], options=options)
        self.assertLessEqual(result["sampling_plan"]["target_rows"], 96)
        self.assertGreater(result["sampling_plan"]["target_rows"], 0)
        self.assertFalse(result["sampling_plan"]["repeatable_across_runs"])
        self.assertEqual(result["sources"][0]["sample_size"], result["sources"][1]["sample_size"])
        self.assertLessEqual(result["sources"][0]["sample_size"], 96)
        self.assertEqual(result["summary"]["status"], "compatible_in_sample")

    def test_result_contains_no_raw_rows_or_connection_details(self):
        source = self.source("reference", [("a", 1, "one", 1)])
        target = self.source("target", [("a", 1, "one", 1)])
        source["creds"]["password"] = "private-password-for-test"
        result = execute_comparison([source, target], sample_size=30)

        def check(value):
            if isinstance(value, dict):
                self.assertTrue({"sample_rows", "sample_columns", "conn", "creds"}.isdisjoint(value))
                for child in value.values():
                    check(child)
            elif isinstance(value, (list, tuple)):
                for child in value:
                    check(child)

        check(result)
        self.assertNotIn("private-password-for-test", json.dumps(result, default=str))

    def test_exactly_two_tables_are_required(self):
        one = self.source("a")
        for selected in ([], [one], [one, one, one]):
            with self.subTest(source_count=len(selected)):
                with self.assertRaises(ValueError):
                    execute_comparison(selected)


if __name__ == "__main__":
    unittest.main()
