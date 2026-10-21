"""Availability is derived from saved evidence, without rewriting history."""
from copy import deepcopy
from decimal import Decimal
import unittest

from dataqore_engine.evaluation import metric_evaluation, profile_evaluations, result_evaluation
from dataqore_engine.schemas import ResultEvaluationOut
from dataqore_engine.core.quality import profile_rows, UnavailableValue


class EvaluationTests(unittest.TestCase):
    def metric(self, family="text", rows=None):
        return profile_rows({"v": {"type": family, "family": family}}, ["v"],
                            rows if rows is not None else [(None,), (None,)])["metrics"]["v"]

    def test_all_null_keeps_null_percentage_and_zero_counts(self):
        m = self.metric()
        self.assertEqual(metric_evaluation(m, "null_rate")["status"], "available")
        self.assertEqual(metric_evaluation(m, "distinct_count")["status"], "available")
        self.assertEqual(metric_evaluation(m, "distinct_rate")["reason"], "all_values_null")
        self.assertEqual(metric_evaluation(m, "mean")["status"], "not_applicable")
        self.assertEqual(m["null_rate"], 1)

    def test_empty_is_not_all_null_or_approval(self):
        m = self.metric(rows=[])
        self.assertEqual(metric_evaluation(m, "null_rate")["reason"], "empty_sample")
        self.assertEqual(metric_evaluation(m, "sample_count")["status"], "available")

    def test_zero_false_and_blank_remain_values(self):
        for value in (0, Decimal("0"), False, ""):
            self.assertEqual(metric_evaluation({"custom": value}, "custom")["status"], "available")
        m = self.metric(rows=[("",), (" ",)])
        self.assertEqual(m["blank_count"], 2)
        self.assertEqual(metric_evaluation(m, "text_length_min")["status"], "available")

    def test_text_is_not_parsed_as_numeric(self):
        m = self.metric(rows=[("123",)])
        self.assertEqual(metric_evaluation(m, "mean")["reason"], "metric_not_applicable_to_type")

    def test_capture_unsupported_and_non_finite_reasons(self):
        for field, reason in (("unavailable_count", "capture_unavailable"),
                              ("unsupported_count", "unsupported_type_or_values"),
                              ("non_finite_count", "non_finite_values")):
            m = {"family": "integer", "sample_count": 2, "null_count": 0, field: 2}
            self.assertEqual(metric_evaluation(m, "mean")["reason"], reason)
        m = self.metric("integer", [(1,), (UnavailableValue("limit"),)])
        self.assertEqual(metric_evaluation(m, "mean")["status"], "partial")
        self.assertEqual(metric_evaluation(m, "unavailable_count")["status"], "available")

    def test_unknown_historical_evidence_has_no_invented_reason(self):
        self.assertEqual(metric_evaluation({}, "mean")["reason"], "historical_reason_unavailable")
        self.assertEqual(result_evaluation({}, "comparison")["analysis_kind"], "unknown")

    def test_modes_and_invalid_key_are_distinct(self):
        cases = [({}, "profile", "profile", "single_source_profile"),
            ({"sampling_plan": {"mode": "independent_random"}}, "comparison", "independent", "historical_reason_unavailable"),
            ({"sampling_plan": {"mode": "key_validation_failed"}}, "comparison", "invalid_key", "invalid_key")]
        for result, kind, mode, reason in cases:
            evaluation = result_evaluation(result, kind)
            ResultEvaluationOut.model_validate(evaluation)
            self.assertEqual(evaluation["analysis_kind"], mode)
            self.assertEqual(evaluation["agreement"]["reason"], reason)
        result = {"sampling_plan": {"mode": "independent_random"}}
        self.assertEqual(result_evaluation(result, "comparison", {"mode": "independent_random"})["agreement"]["reason"], "independent_sampling")
        self.assertEqual(result_evaluation(result, "comparison", {"mode": "auto"})["agreement"]["reason"], "no_safe_key_alignment")

    def test_aligned_partial_and_empty(self):
        result = {"row_comparisons": [{}], "indicators": {"agreement": {
            "percentage": "0.0000", "evaluated": 1, "total": 2, "pending": 1}}}
        self.assertEqual(result_evaluation(result, "comparison")["agreement"]["status"], "partial")
        result["sources"] = [{"sample_size": 0}]
        result["indicators"]["agreement"] = {"evaluated": 0}
        self.assertEqual(result_evaluation(result, "comparison")["agreement"]["reason"], "empty_sample")

    def test_deltas_use_physical_names_and_do_not_mutate_saved_json(self):
        a, b = self.metric(), self.metric()
        result = {"format_version": 5, "sampling_plan": {"mode": "independent_random"},
            "sources": [{"metrics": {"original": a}}, {"metrics": {"mapped": b}}],
            "metric_comparisons": [{"column": "original", "reference_column": "original", "target_column": "mapped",
                "deltas": {"null_rate": Decimal("0"), "mean": None, "distinct_rate": None}}]}
        before = deepcopy(result)
        evaluation = result_evaluation(result, "comparison")
        ResultEvaluationOut.model_validate(evaluation)
        self.assertEqual(evaluation["comparisons"][0]["metrics"]["null_rate"]["status"], "available")
        self.assertEqual(evaluation["comparisons"][0]["metrics"]["mean"]["status"], "not_applicable")
        self.assertEqual(evaluation["comparisons"][0]["metrics"]["distinct_rate"]["reason"], "all_values_null")
        self.assertEqual(result, before)

    def test_column_missing_and_incompatible_remain_explicit(self):
        for reason in ("column_missing", "incompatible_type_families"):
            result = {"metric_comparisons": [{"column": "v", "reason": reason, "deltas": {"mean": None}}]}
            self.assertEqual(result_evaluation(result, "comparison")["comparisons"][0]["metrics"]["mean"]["reason"], reason)

    def test_temporal_statistics_follow_declared_type(self):
        self.assertEqual(metric_evaluation({"family": "datetime", "sample_count": 2, "temporal_min": "2026-10-01"}, "temporal_min")["status"], "available")
        self.assertEqual(metric_evaluation({"family": "text", "sample_count": 2}, "temporal_min")["status"], "not_applicable")

    def test_profiles_preserve_all_existing_fields(self):
        profile = {"metadata": {"type": "integer"}, "metrics": self.metric("integer", [(0,)])}
        before = deepcopy(profile)
        self.assertEqual(profile_evaluations(profile)["mean"]["status"], "available")
        self.assertEqual(profile, before)
