"""Explanatory statistics: aggregates only, consistent with the five metrics."""

import json
import sqlite3
import unittest
from decimal import Decimal
from dataqore_engine.core.comparison_engine import execute_comparison
from dataqore_engine.core.sampling import SamplingOptions
from dataqore_engine.core.statistics import difference_kind, rate_interval
from dataqore_engine.schemas import ComparisonResult
from dataqore_engine.storage import json_safe

DDL = "id integer primary key, amount numeric, label text, note text"


class StatisticsTests(unittest.TestCase):
    def source(self, rows, ddl=DDL):
        c = sqlite3.connect(":memory:")
        self.addCleanup(c.close)
        c.execute(f"CREATE TABLE records({ddl})")
        c.executemany("INSERT INTO records VALUES(" + ",".join("?" for _ in rows[0]) + ")", rows)
        return dict(conn=c, creds={"type": "sqlite"}, schema="", table="records", read_consistency="stable_snapshot")

    def compare(self, **kw):
        a = self.source([(1, 10, "Paid", "x"), (2, 20, "open", None), (3, 30, "SECRET_LABEL", "y"), (4, 40, "same", "z"), (5, 50, "only a", "z")])
        b = self.source([(1, 12.5, "paid", "x"), (2, 19, "open ", "n"), (3, 30, "other", "y"), (4, 40, "same", "z"), (6, 60, "only b", "z")])
        return execute_comparison([a, b], **kw)

    def test_outcomes_and_difference_kinds_reconcile_with_metrics(self):
        r = self.compare()
        s, m = r["statistics"], r["metrics"]
        self.assertEqual(s["record_outcomes"], {"equal": 1, "different": 3, "only_reference": 1, "only_target": 1, "unknown": 0, "total": 6})
        row = m["row_match_rate"]
        outcomes = s["record_outcomes"]
        self.assertEqual(outcomes["equal"], row["numerator"])
        self.assertEqual(outcomes["different"] + outcomes["only_reference"] + outcomes["only_target"], row["different_rows"])
        self.assertEqual(s["differing_columns_per_record"], [{"columns": 1, "records": 1}, {"columns": 2, "records": 1}, {"columns": 3, "records": 1}])
        by_name = {c["left_column"]: c for c in s["columns"]}
        for metric, column in zip(m["column_match_rate"], s["columns"]):
            self.assertEqual(sum(column["difference_kinds"].values()), metric["different_values"])
        self.assertEqual(by_name["label"]["difference_kinds"],
                         {"missing_record": 2, "reference_null": 0, "target_null": 0, "whitespace": 1, "letter_case": 1, "numeric": 0, "temporal": 0, "value": 1})
        self.assertEqual(by_name["note"]["difference_kinds"]["reference_null"], 1)
        self.assertEqual(by_name["note"]["null_values"], {"reference": 1, "target": 0})
        self.assertEqual(s["difference_kinds"], {"reference_null": 1, "target_null": 0, "whitespace": 1, "letter_case": 1, "numeric": 2, "temporal": 0, "value": 1})

    def test_numeric_differences_keep_direction_and_precision(self):
        numeric = next(c for c in self.compare()["statistics"]["columns"] if c["left_column"] == "amount")["numeric_difference"]
        self.assertEqual(numeric, {"compared_differences": 2, "mean_signed_difference": "0.75", "mean_absolute_difference": "1.75",
                                   "max_absolute_difference": "2.5", "target_greater": 1, "reference_greater": 1})

    def test_tolerated_values_are_not_reported_as_differences(self):
        r = self.compare(absolute_tolerance=Decimal("3"))
        amount = next(c for c in r["statistics"]["columns"] if c["left_column"] == "amount")
        self.assertEqual(amount["difference_kinds"]["numeric"], 0)
        self.assertIsNone(amount["numeric_difference"])

    def test_interval_is_exact_for_a_complete_scope_and_wilson_for_a_sample(self):
        full = self.compare()["statistics"]
        self.assertTrue(full["sample_is_complete_scope"])
        self.assertEqual(full["intervals"]["row_match_rate"], {"method": "complete_scope", "confidence_level": None,
                                                                "lower": Decimal("16.6667"), "upper": Decimal("16.6667")})
        sampled = self.compare(options=SamplingOptions(rows=3, seed=7))["statistics"]
        self.assertFalse(sampled["sample_is_complete_scope"])
        interval = sampled["intervals"]["row_match_rate"]
        self.assertEqual((interval["method"], interval["confidence_level"]), ("wilson", 95))
        self.assertLess(interval["lower"], interval["upper"])
        # Reference values for 8/10 from the published Wilson score formula.
        self.assertEqual(rate_interval(8, 10), {"method": "wilson", "confidence_level": 95, "lower": Decimal("49.0162"), "upper": Decimal("94.3318")})
        self.assertEqual((rate_interval(10, 10)["upper"], rate_interval(0, 10)["lower"]), (Decimal("100.0000"), Decimal("0.0000")))
        self.assertIsNone(rate_interval(0, 0))

    def test_statistics_hold_no_keys_or_values_and_match_the_public_schema(self):
        r = self.compare()
        text = json.dumps(json_safe(r["statistics"]))
        for private in ("SECRET_LABEL", "only a", "only b"):
            self.assertNotIn(private, text)
        self.assertEqual(len(r["metrics"]), 5)
        self.assertEqual(ComparisonResult.model_validate(r).statistics.record_outcomes.total, 6)
        self.assertEqual([t["stage"] for t in r["statistics"]["stage_timings"]],
                         ["metadata", "key_validation", "key_selection", "record_fetch", "evaluation"])

    def test_missing_alignment_reports_no_invented_outcome(self):
        ddl = "id integer, value text"
        a, b = self.source([(1, "x"), (1, "y")], ddl), self.source([(1, "x")], ddl)
        s = execute_comparison([a, b], comparison_options={"business_key": [{"left": "id", "right": "id"}]})["statistics"]
        self.assertEqual(s["record_outcomes"], {"equal": 0, "different": 0, "only_reference": 0, "only_target": 0, "unknown": 0, "total": 0})
        self.assertIsNone(s["intervals"]["row_match_rate"])
        self.assertFalse(s["sample_is_complete_scope"])

    def test_difference_kind_never_treats_unequal_text_as_numeric(self):
        self.assertEqual(difference_kind("1", "1.0"), ("value", None))
        self.assertEqual(difference_kind(None, 0)[0], "reference_null")
        self.assertEqual(difference_kind(1, Decimal("1.5")), ("numeric", Decimal("0.5")))


if __name__ == "__main__":
    unittest.main()
