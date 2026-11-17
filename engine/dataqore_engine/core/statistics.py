"""Descriptive statistics over one evaluated key sample; no database access.

These figures explain the five critical metrics; they never replace them.
Everything here is an aggregate: no key, row or cell value is retained.
"""

from collections import Counter
from decimal import Decimal, DecimalException, localcontext
from math import sqrt

from .quality import value_token

_Z_95 = 1.959963984540054
_QUANTUM = Decimal(".0001")
_TEMPORAL = {"date", "datetime", "time"}
DIFFERENCE_KINDS = (
    "missing_record",
    "reference_null",
    "target_null",
    "whitespace",
    "letter_case",
    "numeric",
    "temporal",
    "value",
)


def _percentage(fraction):
    return Decimal(str(min(1.0, max(0.0, fraction)) * 100)).quantize(_QUANTUM)


def rate_interval(successes, trials, complete=False):
    """95% Wilson score interval for a rate observed in the key sample.

    Bottom-k selection over a seeded SHA-256 ranking is a uniform sample of the
    union of keys, so the interval bounds the rate over that union. It ignores
    the finite-population correction (conservative) and positions that could
    not be evaluated. `complete` marks a sample that already holds every key:
    the observed rate is then exact for the scanned scope.
    """
    if not trials:
        return None
    observed = successes / trials
    if complete:
        return {"method": "complete_scope", "confidence_level": None,
                "lower": _percentage(observed), "upper": _percentage(observed)}
    z2 = _Z_95 * _Z_95
    denominator = 1 + z2 / trials
    center = (observed + z2 / (2 * trials)) / denominator
    half = _Z_95 * sqrt(observed * (1 - observed) / trials + z2 / (4 * trials * trials)) / denominator
    return {"method": "wilson", "confidence_level": 95,
            "lower": _percentage(0.0 if not successes else center - half),
            "upper": _percentage(1.0 if successes == trials else center + half)}


def difference_kind(left, right, left_metadata=None, right_metadata=None):
    """Classify a proven difference between two aligned cells.

    Returns (kind, signed numeric difference or None). The numeric difference
    is target − reference and is only available for two finite numbers.
    """
    a, b = value_token(left, left_metadata), value_token(right, right_metadata)
    if a[0] == "null":
        return "reference_null", None
    if b[0] == "null":
        return "target_null", None
    if a[0] == b[0] == "number":
        try:
            with localcontext() as context:
                context.prec = 60
                return "numeric", b[1] - a[1]
        except DecimalException:
            return "numeric", None
    if a[0] == b[0] == "text":
        if a[1].strip() == b[1].strip():
            return "whitespace", None
        if a[1].casefold() == b[1].casefold():
            return "letter_case", None
    if a[0] in _TEMPORAL and b[0] in _TEMPORAL:
        return "temporal", None
    return "value", None


def _decimal_text(value):
    """Plain, bounded text; JSON numbers would lose precision in the browser."""
    with localcontext() as context:
        context.prec = 18
        return format((+value).normalize() if value else Decimal(0), "f")


class ColumnStatistics:
    """Counts for one column pair over the records present in both sources."""

    def __init__(self):
        self.kinds = Counter()
        self.reference_nulls = self.target_nulls = 0
        self.numeric_count = self.target_greater = self.reference_greater = 0
        self.signed_sum = self.absolute_sum = Decimal(0)
        self.absolute_max = None

    def observe(self, left, right, outcome, left_metadata, right_metadata):
        self.reference_nulls += left is None
        self.target_nulls += right is None
        if outcome is not False:
            return
        kind, delta = difference_kind(left, right, left_metadata, right_metadata)
        self.kinds[kind] += 1
        if delta is None:
            return
        try:
            with localcontext() as context:
                context.prec = 60
                magnitude = delta.copy_abs()
                self.signed_sum += delta
                self.absolute_sum += magnitude
        except DecimalException:
            return
        self.numeric_count += 1
        self.target_greater += delta > 0
        self.reference_greater += delta < 0
        if self.absolute_max is None or magnitude > self.absolute_max:
            self.absolute_max = magnitude

    def summary(self, metric, missing, complete):
        kinds = {kind: self.kinds.get(kind, 0) for kind in DIFFERENCE_KINDS}
        kinds["missing_record"] = missing
        numeric = None
        if self.numeric_count:
            with localcontext() as context:
                context.prec = 60
                numeric = {
                    "compared_differences": self.numeric_count,
                    "mean_signed_difference": _decimal_text(self.signed_sum / self.numeric_count),
                    "mean_absolute_difference": _decimal_text(self.absolute_sum / self.numeric_count),
                    "max_absolute_difference": _decimal_text(self.absolute_max),
                    "target_greater": self.target_greater,
                    "reference_greater": self.reference_greater,
                }
        return {
            "interval": rate_interval(metric["numerator"], metric["denominator"], complete),
            "difference_kinds": kinds,
            "null_values": {"reference": self.reference_nulls, "target": self.target_nulls},
            "numeric_difference": numeric,
        }


def unavailable_column():
    return {"interval": None, "difference_kinds": dict.fromkeys(DIFFERENCE_KINDS, 0),
            "null_values": {"reference": 0, "target": 0}, "numeric_difference": None}


def differing_columns_histogram(counter):
    return [{"columns": columns, "records": records} for columns, records in sorted(counter.items())]


def difference_totals(columns):
    totals = Counter()
    for column in columns:
        totals.update(column["difference_kinds"])
    # A missing record affects every pair; do not multiply it by the column count.
    totals.pop("missing_record", None)
    return {kind: totals.get(kind, 0) for kind in DIFFERENCE_KINDS if kind != "missing_record"}
