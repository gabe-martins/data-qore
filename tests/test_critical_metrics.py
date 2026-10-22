"""Critical metrics and reproducible sampling against disposable SQLite sources."""

import json
import sqlite3
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch
from dataqore_engine.core.comparison_engine import execute_comparison
from dataqore_engine.core.sampling import SamplingOptions, canonical_key, select_keys
from dataqore_engine.core.db_adapters import get_adapter
from dataqore_engine.comparison_options import resolve_scope, validate_options
from dataqore_engine.storage import DomainError, json_safe
from dataqore_engine.schemas import Sampling
from dataqore_engine.core.quality import values_equal
from pydantic import ValidationError


class CriticalMetricsTests(unittest.TestCase):
    def source(self, rows=(), ddl="id integer primary key, value text", name="records"):
        c = sqlite3.connect(":memory:")
        self.addCleanup(c.close)
        c.execute(f"CREATE TABLE {name}({ddl})")
        if rows:
            c.executemany(
                f"INSERT INTO {name} VALUES(" + ",".join("?" for _ in rows[0]) + ")",
                rows,
            )
        return dict(
            conn=c,
            creds={"type": "sqlite"},
            schema="",
            table=name,
            read_consistency="stable_snapshot",
        )

    def compare(self, a, b, **kw):
        return execute_comparison([a, b], **kw)

    def test_count_mismatch_overrides_perfect_common_sample(self):
        a = self.source([(1, "same")])
        b = self.source([(1, "same"), (2, "extra")])
        found = False
        for seed in range(20):
            r = self.compare(a, b, options=SamplingOptions(rows=1, seed=seed))
            if r["metrics"]["row_match_rate"]["percentage"] == 100:
                found = True
                self.assertEqual(r["summary"]["status"], "difference_observed")
                self.assertEqual(
                    r["metrics"]["row_count_match"]["absolute_difference"], 1
                )
                break
        self.assertTrue(found)

    def test_five_metrics_only_and_no_raw_data(self):
        r = self.compare(
            self.source([(1, "PRIVATE_ROW")]), self.source([(1, "PRIVATE_ROW")])
        )
        self.assertEqual(
            set(r["metrics"]),
            {
                "row_count_match",
                "key_coverage",
                "duplicate_key_rate",
                "row_match_rate",
                "column_match_rate",
            },
        )
        self.assertEqual(r["summary"]["status"], "compatible_in_sample")
        self.assertNotIn("PRIVATE_ROW", json.dumps(json_safe(r)))
        for name in (
            "indicators",
            "metric_comparisons",
            "value_distributions",
            "quality_findings",
        ):
            self.assertNotIn(name, r)

    def test_bidirectional_absences(self):
        r = self.compare(
            self.source([(1, "x"), (2, "x")]), self.source([(1, "x"), (3, "x")])
        )["metrics"]
        k = r["key_coverage"]
        self.assertEqual((k["missing_in_reference"], k["missing_in_target"]), (1, 1))
        self.assertEqual(k["reference_to_target"]["percentage"], 50)
        self.assertEqual(k["target_to_reference"]["percentage"], 50)
        self.assertEqual(r["row_match_rate"]["denominator"], 3)
        self.assertEqual(r["row_match_rate"]["different_rows"], 2)

    def test_row_and_column_rates_are_different(self):
        r = self.compare(
            self.source([(1, "a"), (2, "b")]), self.source([(1, "wrong"), (2, "b")])
        )["metrics"]
        self.assertEqual(r["row_match_rate"]["percentage"], 50)
        self.assertEqual([v["percentage"] for v in r["column_match_rate"]], [100, 50])

    def test_duplicate_and_null_keys_are_full_scope_violations(self):
        ddl = "id integer,value text"
        opts = {"business_key": [{"left": "id", "right": "id"}]}
        r = self.compare(
            self.source([(1, "x"), (1, "x"), (None, "x")], ddl),
            self.source([(1, "x")], ddl),
            comparison_options=opts,
            options=SamplingOptions(rows=1),
        )
        d = r["metrics"]["duplicate_key_rate"][0]
        self.assertEqual(
            (d["numerator"], d["denominator"], d["percentage"], d["null_key_rows"]),
            (1, 2, 50, 1),
        )
        self.assertEqual(r["summary"]["status"], "difference_observed")
        self.assertIsNone(r["metrics"]["row_match_rate"]["percentage"])

    def test_unknown_rows_do_not_become_matches(self):
        rows = [(1, "x" * 70000)]
        r = self.compare(self.source(rows), self.source(rows))
        m = r["metrics"]["row_match_rate"]
        self.assertEqual((m["denominator"], m["not_evaluated"]), (0, 1))
        self.assertEqual(r["summary"]["status"], "inconclusive")

    def test_proven_difference_wins_over_unknown_in_same_row(self):
        ddl = "id integer primary key, a text,b text"
        r = self.compare(
            self.source([(1, "a", "z" * 70000)], ddl),
            self.source([(1, "b", "z" * 70000)], ddl),
        )
        self.assertEqual(r["metrics"]["row_match_rate"]["different_rows"], 1)
        self.assertEqual(r["metrics"]["row_match_rate"]["denominator"], 1)
        self.assertEqual(r["summary"]["status"], "difference_observed")

    def test_empty_and_zero_reference(self):
        r = self.compare(self.source(), self.source())
        self.assertTrue(r["metrics"]["row_count_match"]["equal"])
        self.assertEqual(r["summary"]["status"], "inconclusive")
        self.assertIsNone(r["metrics"]["row_match_rate"]["percentage"])
        r = self.compare(self.source(), self.source([(1, "x")]))
        self.assertIsNone(r["metrics"]["row_count_match"]["percentage_difference"])
        self.assertEqual(
            r["metrics"]["key_coverage"]["target_to_reference"]["percentage"], 0
        )
        self.assertEqual(r["summary"]["status"], "difference_observed")

    def test_missing_identity_keeps_counts_without_inventing_alignment(self):
        r = self.compare(
            self.source([(1, "x")], "id integer,value text"),
            self.source([(1, "x")], "id integer,value text"),
        )
        self.assertEqual(r["summary"]["status"], "inconclusive")
        self.assertEqual(r["metrics"]["row_count_match"]["reference_count"], 1)
        self.assertEqual(
            r["metrics"]["duplicate_key_rate"][0]["reason"],
            "comparison_key_unavailable",
        )

    def test_unpaired_and_incompatible_columns_are_technical_blockers(self):
        a = self.source([(1, "a")])
        b = self.source(
            [(1, "a", 2)], "id integer primary key,value text,extra integer"
        )
        r = self.compare(a, b)
        self.assertEqual(r["summary"]["status"], "inconclusive")
        self.assertEqual(r["metrics"]["row_match_rate"]["not_evaluated"], 1)
        r = self.compare(
            a, self.source([(1, 10)], "id integer primary key,value integer")
        )
        self.assertEqual(r["summary"]["status"], "inconclusive")

    def test_exact_values_tolerance_and_composite_key_mapping(self):
        a = self.source([("A", 1, 10)], "account text,item integer,amount numeric")
        b = self.source([("A", 1, 10.01)], "customer text,line integer,total numeric")
        pairs = [
            {"left": "account", "right": "customer"},
            {"left": "item", "right": "line"},
            {"left": "amount", "right": "total"},
        ]
        r = self.compare(
            a,
            b,
            comparison_options={"mapping": pairs, "business_key": pairs[:2]},
            absolute_tolerance=Decimal(".02"),
        )
        self.assertEqual(r["metrics"]["row_match_rate"]["percentage"], 100)
        self.assertEqual(r["summary"]["status"], "compatible_in_sample")

    def test_percentage_rounds_up_uses_larger_scope_and_does_not_cap(self):
        o = SamplingOptions(method="percentage", percentage="1.01")
        self.assertEqual(o.target([100, 120], 2), 2)
        with self.assertRaises(DomainError) as e:
            SamplingOptions(method="percentage", percentage="100").target([10001, 1], 1)
        self.assertEqual(e.exception.code, "sample_limit_exceeded")
        with self.assertRaises(DomainError):
            SamplingOptions(rows=10, max_cells=1).target([100, 100], 2)
        for value in ("0", "101", "NaN"):
            with self.assertRaises(ValueError):
                SamplingOptions(method="percentage", percentage=value)
        for value in (0, 10001, True):
            with self.assertRaises(ValueError):
                SamplingOptions(rows=value)

    def test_capture_budget_rejects_instead_of_shrinking(self):
        with self.assertRaises(DomainError):
            self.compare(
                self.source([(1, "x" * 40000)]),
                self.source([(1, "x" * 40000)]),
                options=SamplingOptions(rows=1, max_sample_bytes=1000),
            )

    def test_canonical_keys_preserve_exact_numeric_identity_and_text(self):
        self.assertEqual(
            canonical_key(
                [Decimal("100000000000000000000000000000000000000.00")],
                [{"type": "numeric"}],
            ),
            canonical_key([10**38], [{"type": "integer"}]),
        )
        self.assertEqual(
            canonical_key([Decimal("-0.00")], [{"type": "numeric"}]),
            canonical_key([0], [{"type": "integer"}]),
        )
        self.assertNotEqual(
            canonical_key(["A "], [{"type": "text"}]),
            canonical_key(["A"], [{"type": "text"}]),
        )

    def test_selection_is_order_independent_bottom_k_of_union(self):
        a = self.source([(i, str(i)) for i in range(50)])
        b = self.source([(i, str(i)) for i in reversed(range(25, 75))])
        ss = []
        for source in (a, b):
            adapter = get_adapter("sqlite")
            ss.append(
                {
                    **source,
                    "adapter": adapter,
                    "columns": adapter.metadata(source["conn"], "", "records"),
                    "scope": [],
                }
            )
        keys, _ = select_keys(ss, [["id"], ["id"]], 10, 123, 100000)
        swapped, _ = select_keys(list(reversed(ss)), [["id"], ["id"]], 10, 123, 100000)
        self.assertEqual(keys, swapped)
        import hashlib

        expected = sorted(
            range(75),
            key=lambda i: hashlib.sha256(
                b"123:" + canonical_key([i], [{"type": "integer"}])
            ).digest(),
        )[:10]
        self.assertEqual([v[0] for _, v in keys], expected)
        self.assertEqual(
            self.compare(a, b, options=SamplingOptions(seed=123))["sampling_plan"][
                "seed"
            ],
            "123",
        )

    def test_seed_public_contract_is_lossless(self):
        self.assertEqual(Sampling(seed=str(2**64 - 1)).seed, str(2**64 - 1))
        with self.assertRaises(ValidationError):
            Sampling(seed=str(2**64))

    def test_changed_key_during_lookup_is_not_replaced(self):
        a = self.source([(1, "x")])
        b = self.source([(1, "x")])
        adapter = get_adapter("sqlite")
        original = adapter.fetch_keys

        def changed(*args, **kw):
            return ["id", "value"], [(999, "x")]

        with patch.object(adapter, "fetch_keys", side_effect=changed):
            r = self.compare(a, b)
        self.assertEqual(r["summary"]["status"], "inconclusive")
        self.assertFalse(r["summary"]["alignment_available"])

    def test_scope_applies_counts_scan_and_lookup(self):
        ddl = "id integer primary key,value text,day date,batch text"
        a = self.source(
            [
                (1, "ok", "2026-10-01", "B"),
                (2, "left", "2026-10-02", "B"),
                (3, "left", "2026-10-01", "X"),
            ],
            ddl,
        )
        b = self.source(
            [
                (1, "ok", "2026-10-01", "B"),
                (2, "right", "2026-10-02", "B"),
                (3, "right", "2026-10-01", "X"),
            ],
            ddl,
        )
        opts = {
            "scope": {
                "period": {
                    "left": "day",
                    "right": "day",
                    "kind": "fixed",
                    "start": "2026-10-01",
                    "end": "2026-10-02",
                },
                "filters": [
                    {"left": "batch", "right": "batch", "operator": "eq", "value": "B"}
                ],
            }
        }
        r = self.compare(a, b, comparison_options=opts)
        self.assertEqual(r["metrics"]["row_count_match"]["reference_count"], 1)
        self.assertEqual(r["metrics"]["row_match_rate"]["percentage"], 100)
        self.assertEqual(r["sampling_plan"]["scanned_key_rows"], [1, 1])

    def test_explicit_exclusion_removes_blocker_and_capture(self):
        a = self.source([(1, "same")])
        b = self.source([(1, "same", "x" * 70000)], "id integer primary key,value text,ingestion_datetime text")
        opts = {"excluded_columns": {"right": ["ingestion_datetime"]}}
        r = self.compare(a, b, comparison_options=opts, options=SamplingOptions(rows=1, max_cells=4, max_sample_bytes=1000))
        self.assertEqual(r["summary"]["status"], "compatible_in_sample")
        self.assertEqual(r["metrics"]["row_match_rate"]["percentage"], 100)
        self.assertEqual(r["comparison_options"], opts)
        self.assertEqual(r["unmatched_columns"], {"left": [], "right": []})
        self.assertNotIn("ingestion_datetime", [m["right_column"] for m in r["metrics"]["column_match_rate"]])
        self.assertFalse(any("ingestion_datetime" in e.get("sql", "") for e in r["query_log"] if e.get("rows_fetched") == 1 and "SELECT" in e.get("sql", "")))

    def test_one_sided_exclusion_is_not_silent_approval(self):
        r = self.compare(self.source([(1, "same")]), self.source([(1, "same")]), comparison_options={"excluded_columns": {"right": ["value"]}})
        self.assertEqual(r["summary"]["status"], "inconclusive")
        self.assertEqual(r["unmatched_columns"]["left"], ["value"])

    def test_excluded_filter_columns_still_restrict_all_queries(self):
        a = self.source([(1, "same"), (2, "outside")])
        b = self.source([(1, "same"), (3, "outside")])
        opts = {"excluded_columns": {"left": ["value"], "right": ["value"]}, "scope": {"filters": [{"left": "value", "right": "value", "operator": "eq", "value": "same"}]}}
        r = self.compare(a, b, comparison_options=opts)
        self.assertEqual(r["metrics"]["row_count_match"]["reference_count"], 1)
        self.assertEqual(r["sampling_plan"]["scanned_key_rows"], [1, 1])
        self.assertEqual(r["metrics"]["row_match_rate"]["percentage"], 100)

    def test_exclusion_validation_protects_identity_and_mapping(self):
        cols = [{"id": {"type": "integer", "primary_key": True}, "value": {"type": "text"}}] * 2
        invalid_options = [
            {"excluded_columns": {"left": ["missing"]}},
            {"excluded_columns": {"left": ["value", "value"]}},
            {"excluded_columns": {"left": ["id"]}},
            {"excluded_columns": {"left": ["value"]}, "mapping": [{"left": "value", "right": "value"}]},
            {"excluded_columns": {"left": ["value"]}, "business_key": [{"left": "value", "right": "value"}]},
        ]
        for opts in invalid_options:
            with self.subTest(opts=opts), self.assertRaises(DomainError):
                validate_options(opts, cols)

    def test_timezone_and_exclusion_restore_evaluation_without_hiding_difference(self):
        a = self.source([(1, "same", "2026-10-20T12:00:00"), (2, "left", "2026-10-20T13:00:00")], "id integer primary key,value text,sold timestamp")
        b = self.source([(1, "same", "2026-10-20T15:00:00+00:00", "extra"), (2, "right", "2026-10-20T16:00:00+00:00", "extra")], "id integer primary key,value text,sold timestamp,ingested text")
        before = self.compare(a, b)
        self.assertEqual(before["metrics"]["row_match_rate"]["not_evaluated"], 1)
        opts = {"excluded_columns": {"right": ["ingested"]}, "timestamp_timezones": {"left": {"sold": "America/Sao_Paulo"}}}
        after = self.compare(a, b, comparison_options=opts)
        m = after["metrics"]["row_match_rate"]
        self.assertEqual((m["percentage"], m["denominator"], m["not_evaluated"]), (50, 2, 0))
        self.assertEqual(after["summary"]["status"], "difference_observed")

    def test_timezone_preserves_precision_and_rejects_dst_ambiguity(self):
        left = {"type": "datetime2", "naive_timezone": "America/Sao_Paulo"}
        right = {"type": "timestamp"}
        self.assertTrue(values_equal("2026-10-20T12:00:00.1234567", "2026-10-20T15:00:00.1234567Z", left, right))
        self.assertFalse(values_equal("2026-10-20T12:00:00.1234567", "2026-10-20T15:00:00.1234568Z", left, right))
        self.assertIsNone(values_equal("2026-10-20T12:00:00", "2026-10-20T15:00:00Z", {"type": "datetime2"}, right))
        ny = {"type": "timestamp", "naive_timezone": "America/New_York"}
        for value in ("2026-11-01T01:30:00", "2026-03-08T02:30:00"):
            self.assertIsNone(values_equal(value, "2026-11-01T05:30:00Z", ny, right))
        # A stored offset is authoritative even if a naive interpretation is configured.
        self.assertTrue(values_equal("2026-10-20T12:00:00Z", "2026-10-20T12:00:00Z", left, right))

    def test_timezone_configuration_is_validated_and_frozen_in_period(self):
        cols = [{"sold": {"type": "timestamp"}, "value": {"type": "text"}}] * 2
        for name in ("missing", "value"):
            with self.assertRaises(DomainError):
                validate_options({"timestamp_timezones": {"left": {name: "UTC"}}}, cols)
        with self.assertRaises(ValidationError):
            validate_options({"timestamp_timezones": {"left": {"sold": "Invalid/Timezone"}}}, cols)
        opts = {"timestamp_timezones": {"left": {"sold": "UTC"}, "right": {"sold": "UTC"}}, "scope": {"period": {"left": "sold", "right": "sold", "kind": "fixed", "start": "2026-10-01", "end": "2026-10-02"}}}
        frozen = resolve_scope(opts)
        self.assertEqual(frozen["period"]["left_naive_timezone"], "UTC")
        self.assertEqual(validate_options(opts, cols, resolved=frozen)["resolved_scope"], frozen)
        opts["scope"]["period"]["left_naive_timezone"] = "America/Sao_Paulo"
        with self.assertRaises(DomainError):
            resolve_scope(opts)


class RelativeWindowTests(unittest.TestCase):
    def resolve(self, unit, n, at):
        return resolve_scope(
            {
                "scope": {
                    "period": {
                        "left": "d",
                        "right": "d",
                        "kind": "relative",
                        "unit": unit,
                        "quantity": n,
                    }
                }
            },
            datetime.fromisoformat(at),
        )["period"]

    def test_closed_hours(self):
        p = self.resolve("hours", 2, "2026-10-21T14:35:00-03:00")
        self.assertEqual(
            (p["start"], p["end"]),
            ("2026-10-21T15:00:00+00:00", "2026-10-21T17:00:00+00:00"),
        )

    def test_calendar_months_across_year(self):
        p = self.resolve("months", 2, "2026-01-21T14:35:00-03:00")
        self.assertEqual((p["start_day"], p["end_day"]), ("2025-11-01", "2026-01-01"))

    def test_date_columns_reject_hour_unit(self):
        with self.assertRaises(DomainError):
            validate_options(
                {
                    "scope": {
                        "period": {
                            "left": "d",
                            "right": "d",
                            "kind": "relative",
                            "unit": "hours",
                        }
                    }
                },
                [{"d": {"type": "date"}}] * 2,
            )
