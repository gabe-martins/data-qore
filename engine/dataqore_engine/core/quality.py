"""Pure, bounded calculations for sampled data; no database or terminal access.

Rates describe the rows observed. They are not estimates of whole-table equality
or confidence intervals. Missing/unsupported values never become matching values.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, DecimalException, MAX_EMAX, MIN_EMIN, localcontext
import json
import math
import re
from uuid import UUID


@dataclass(frozen=True)
class UnavailableValue:
    """A cell deliberately not materialized (for example, a bounded LOB read)."""

    reason: str


NUMERIC_FAMILIES = {"integer", "decimal", "float"}
SUMMARY_PRECISION = 128
_UNKNOWN_TAGS = {"unsupported", "unavailable", "nonfinite"}
_TEMPORAL_RE = re.compile(
    r"^(?:(?P<day>\d{4}-\d{2}-\d{2})[T ])?"
    r"(?P<clock>\d{2}:\d{2}:\d{2})(?:\.(?P<fraction>\d+))?"
    r"(?P<offset>Z|[+-]\d{2}:?\d{2})?$", re.IGNORECASE
)


def type_family(declared):
    raw = re.sub(r"\s+", " ", (declared or "").strip().lower())
    if raw.endswith("[]"):
        return "array"
    raw = re.sub(r"\s+(unsigned|zerofill)\b", "", raw)
    kind = raw.split("(")[0].strip()
    if kind.startswith("interval"):
        return "interval"
    if kind in {"bool", "boolean", "bit"}:
        return "boolean"
    if kind in {"tinyint", "smallint", "mediumint", "int", "integer", "bigint", "int2", "int4", "int8", "serial", "bigserial", "smallserial"}:
        return "integer"
    if kind in {"numeric", "decimal", "number", "money", "smallmoney"}:
        return "decimal"
    if kind in {"real", "float", "double", "double precision", "binary_float", "binary_double"}:
        return "float"
    if kind == "date":
        return "date"
    if kind.startswith(("timestamp", "datetime")) or kind == "smalldatetime":
        return "datetime"
    if kind.startswith("time"):
        return "time"
    if kind in {"char", "character", "varchar", "character varying", "nvarchar", "nchar", "text", "ntext", "tinytext", "mediumtext", "longtext", "clob", "nclob", "varchar2", "nvarchar2"}:
        return "text"
    if kind in {"bytea", "binary", "varbinary", "blob", "image", "raw", "long raw", "rowversion"}:
        return "binary"
    if kind in {"uniqueidentifier", "uuid"}:
        return "uuid"
    if kind in {"json", "jsonb"}:
        return "json"
    return kind or "unknown"


def metadata_family(metadata):
    info = metadata or {}
    return info.get("family") or type_family(info.get("type"))


def name_map(names):
    """Accept case differences only when column matching is unambiguous."""
    result = {}
    for name in names:
        normalized = name.casefold()
        if normalized in result:
            raise ValueError(f"Ambiguous column names: {result[normalized]!r} / {name!r}")
        result[normalized] = name
    return result


def _number(value, allow_string=False):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal, str)):
        return None
    if isinstance(value, str) and not allow_string:
        return None
    try:
        return value if isinstance(value, Decimal) else Decimal(str(value))
    except (ValueError, DecimalException):
        return None


def _temporal_token(value, family):
    # Parse seconds and fractions independently. datetime.fromisoformat alone
    # truncates database nanoseconds to Python's six fractional digits.
    if family == "date":
        if isinstance(value, datetime):
            return ("unsupported", "datetime_in_date")
        text = value.isoformat() if isinstance(value, date) else value
        try:
            if not isinstance(text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
                raise ValueError
            return ("date", date.fromisoformat(text).isoformat())
        except ValueError:
            return ("unsupported", "invalid_date")
    text = value.isoformat() if isinstance(value, (datetime, time)) else value
    match = _TEMPORAL_RE.fullmatch(text) if isinstance(text, str) else None
    if not match or bool(match["day"]) != (family == "datetime"):
        return ("unsupported", "invalid_temporal")
    try:
        base = datetime.fromisoformat((match["day"] or "2000-01-01") + "T" + match["clock"])
        offset = match["offset"]
        if offset:
            if offset.upper() == "Z":
                delta = timedelta(0)
            else:
                parts = offset[1:].replace(":", "")
                hours, minutes = int(parts[:2]), int(parts[2:])
                if hours > 23 or minutes > 59:
                    raise ValueError
                delta = timedelta(minutes=(hours * 60 + minutes) * (1 if offset[0] == "+" else -1))
            base -= delta
        canonical = base.isoformat(timespec="seconds") if family == "datetime" else base.time().isoformat(timespec="seconds")
        fraction = (match["fraction"] or "").rstrip("0")
        if fraction:
            canonical += "." + fraction
        return (family, "aware" if offset else "naive", canonical)
    except (ValueError, OverflowError):
        return ("unsupported", "invalid_temporal")


def _token(value, metadata=None, depth=0):
    if isinstance(value, UnavailableValue):
        return ("unavailable", value.reason)
    if value is None:
        return ("null",)
    if depth > 32:
        return ("unsupported", "nested_value_depth")
    family = metadata_family(metadata)
    if family in NUMERIC_FAMILIES:
        number = _number(value, allow_string=True)
        if number is None:
            return ("unsupported", "invalid_numeric")
        return ("number", number) if number.is_finite() else ("nonfinite", str(number))
    if family == "boolean":
        if isinstance(value, bool):
            return ("boolean", value)
        if isinstance(value, (int, Decimal)) and value in (0, 1):
            return ("boolean", bool(value))
        return ("unsupported", "invalid_boolean")
    if family in {"date", "datetime", "time"}:
        return _temporal_token(value, family)
    if family == "uuid":
        try:
            return ("uuid", str(value if isinstance(value, UUID) else UUID(str(value))))
        except (ValueError, TypeError, AttributeError):
            return ("unsupported", "invalid_uuid")
    if family == "json" and isinstance(value, (str, bytes, bytearray)):
        try:
            def reject_constant(constant):
                raise ValueError("nonfinite JSON number")
            value = json.loads(value, parse_float=Decimal, parse_int=Decimal, parse_constant=reject_constant)
        except (ValueError, TypeError, RecursionError):
            return ("unsupported", "invalid_json")
        return _token(value, depth=depth + 1)
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, (int, float, Decimal)):
        number = _number(value)
        if number is None:
            return ("unsupported", "invalid_numeric")
        return ("number", number) if number.is_finite() else ("nonfinite", str(number))
    if isinstance(value, str):
        return ("text", value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return ("binary", bytes(value))
    if isinstance(value, datetime):
        return _temporal_token(value, "datetime")
    if isinstance(value, date):
        return _temporal_token(value, "date")
    if isinstance(value, time):
        return _temporal_token(value, "time")
    if isinstance(value, UUID):
        return ("uuid", str(value))
    if isinstance(value, dict):
        pairs = [(_token(k, depth=depth + 1), _token(v, depth=depth + 1)) for k, v in value.items()]
        for key, item in pairs:
            if key[0] in _UNKNOWN_TAGS or item[0] in _UNKNOWN_TAGS:
                return ("unsupported", "nested_unknown")
        return ("dict", frozenset(pairs))
    if isinstance(value, (list, tuple)):
        tokens = tuple(_token(v, depth=depth + 1) for v in value)
        if any(v[0] in _UNKNOWN_TAGS for v in tokens):
            return ("unsupported", "nested_unknown")
        return ("sequence", tokens)
    return ("unsupported", type(value).__name__)


def value_token(value, metadata=None):
    """Hashable typed identity; unknown tokens must never establish equality."""
    return _token(value, metadata)


def _decimal_context(context):
    context.prec = SUMMARY_PRECISION
    context.Emax = MAX_EMAX
    context.Emin = MIN_EMIN


def values_equal(a, b, metadata_a=None, metadata_b=None,
                 absolute_tolerance=Decimal("0"), relative_tolerance=Decimal("0")):
    """Return True/False, or None when either cell cannot safely be compared.

    Text is never trimmed, case folded or parsed as a number without numeric
    metadata. Numeric tolerances apply only to numeric cells. Temporal offsets
    are normalized, but timezone information is never inferred for naive values.
    """
    absolute, relative = _number(absolute_tolerance, True), _number(relative_tolerance, True)
    if any(v is None or not v.is_finite() or v < 0 for v in (absolute, relative)):
        raise ValueError("Numeric tolerances must be finite and non-negative")
    left, right = _token(a, metadata_a), _token(b, metadata_b)
    if left[0] in _UNKNOWN_TAGS or right[0] in _UNKNOWN_TAGS:
        return None
    if left[0] == right[0] and left[0] in {"datetime", "time"} and left[1] != right[1]:
        return None
    if left[0] == right[0] == "number":
        if left[1] == right[1]:
            return True
        if not absolute and not relative:
            return False
        try:
            with localcontext() as context:
                _decimal_context(context)
                difference = (left[1] - right[1]).copy_abs()
                allowed = max(absolute, relative * max(left[1].copy_abs(), right[1].copy_abs()))
                return difference <= allowed
        except DecimalException:
            return None
    return left == right


def primary_key_profile(metadata, names, rows):
    keys = [name for name, info in metadata.items() if info.get("primary_key")]
    positions = {name: index for index, name in enumerate(names)}
    result = {"columns": keys, "sample_unique": None, "null_key_rows": 0,
              "duplicate_key_rows": 0, "unavailable_key_rows": 0, "observed_key_rows": 0}
    if not keys or not rows or any(name not in positions for name in keys):
        return result
    tokens = []
    for row in rows:
        values = [row[positions[name]] for name in keys]
        if any(value is None for value in values):
            result["null_key_rows"] += 1
            continue
        key = tuple(_token(value, metadata[name]) for name, value in zip(keys, values))
        if any(token[0] in _UNKNOWN_TAGS for token in key):
            result["unavailable_key_rows"] += 1
        else:
            tokens.append(key)
    result["observed_key_rows"] = len(tokens)
    result["duplicate_key_rows"] = len(tokens) - len(set(tokens))
    if result["null_key_rows"] or result["duplicate_key_rows"]:
        result["sample_unique"] = False
    elif not result["unavailable_key_rows"]:
        result["sample_unique"] = True
    return result


def _numeric_summary(values):
    finite = sorted(values)
    if not finite:
        return {}
    result = {"min": finite[0], "max": finite[-1], "summary_precision": SUMMARY_PRECISION,
              "quantile_method": "linear_interpolation", "stddev_kind": "population"}
    try:
        with localcontext() as context:
            _decimal_context(context)
            def quantile(numerator, denominator):
                quotient, remainder = divmod((len(finite) - 1) * numerator, denominator)
                if not remainder:
                    return finite[quotient]
                return finite[quotient] + (finite[quotient + 1] - finite[quotient]) * Decimal(remainder) / denominator
            anchor = finite[len(finite) // 2]
            offsets = [value - anchor for value in finite]
            offset_mean = sum(offsets, Decimal(0)) / len(offsets)
            variance = sum(((value - offset_mean) ** 2 for value in offsets), Decimal(0)) / len(offsets)
            mean = anchor + offset_mean
            # Context rounding must not put the reported mean outside extrema.
            result.update(mean=min(finite[-1], max(finite[0], mean)), median=quantile(1, 2),
                          q25=quantile(1, 4), q75=quantile(3, 4), stddev=variance.sqrt(),
                          numeric_summary_status="available")
    except DecimalException:
        result["numeric_summary_status"] = "inconclusive"
    return result


def profile_rows(metadata, names, rows):
    names, rows = list(names), list(rows)
    name_map(names)
    if any(len(row) != len(names) for row in rows):
        raise ValueError("Every sampled row must match the projected columns")
    metrics = {}
    pk = primary_key_profile(metadata, names, rows)
    for index, name in enumerate(names):
        values = [row[index] for row in rows]
        non_null = [value for value in values if value is not None]
        info = metadata.get(name, {})
        family = metadata_family(info)
        tokens = [_token(value, info) for value in non_null]
        observed = [token for token in tokens if token[0] not in _UNKNOWN_TAGS]
        distinct = len(set(observed))
        nulls = len(values) - len(non_null)
        metric = {
            "type": info.get("type", ""), "family": family, "nullable": info.get("nullable"),
            "primary_key": info.get("primary_key", False),
            "sample_count": len(values), "non_null_count": len(non_null),
            "null_count": nulls, "null_rate": nulls / len(values) if values else None,
            "null_denominator": len(values), "observed_count": len(observed),
            "unavailable_count": sum(token[0] == "unavailable" for token in tokens),
            "unsupported_count": sum(token[0] == "unsupported" for token in tokens),
            "non_finite_count": sum(token[0] == "nonfinite" for token in tokens),
            "distinct_count": distinct, "distinct_denominator": len(observed),
            "distinct_rate": distinct / len(observed) if observed else None,
            "duplicate_count": len(observed) - distinct,
            "duplicate_rate": (len(observed) - distinct) / len(observed) if observed else None,
            "blank_count": sum(isinstance(value, str) and not value.strip() for value in non_null),
        }
        text_values = [value for value in non_null if isinstance(value, str)]
        metric["blank_denominator"] = len(text_values)
        metric["blank_rate"] = metric["blank_count"] / len(text_values) if text_values else None
        if family in NUMERIC_FAMILIES:
            numeric = [token[1] for token in observed if token[0] == "number"]
            metric.update(numeric_count=len(numeric), numeric_denominator=len(numeric),
                          invalid_numeric_count=sum(token[0] == "unsupported" for token in tokens))
            metric.update(_numeric_summary(numeric))
        if family == "text" and text_values:
            lengths = list(map(len, text_values))
            metric.update(text_length_count=len(lengths), text_length_min=min(lengths),
                          text_length_max=max(lengths), text_length_mean=sum(lengths) / len(lengths))
        if family in {"date", "datetime", "time"}:
            temporal = [token for token in observed if token[0] == family]
            metric["temporal_count"] = len(temporal)
            if temporal and (family == "date" or len({token[1] for token in temporal}) == 1):
                ordered = sorted(token[-1] for token in temporal)
                metric.update(temporal_min=ordered[0], temporal_max=ordered[-1],
                              temporal_timezone="date_only" if family == "date" else temporal[0][1])
        if info.get("primary_key") and len(pk["columns"]) == 1:
            metric["sample_unique"] = pk["sample_unique"]
        metrics[name] = metric
    return {"columns": metadata, "metrics": metrics, "primary_key": pk,
            "sample_size": len(rows), "sample_columns": names, "sample_rows": rows}


def _delta(first, second):
    if first is None or second is None:
        return None
    a, b = _number(first), _number(second)
    if a is None or b is None or not a.is_finite() or not b.is_finite():
        return None
    try:
        with localcontext() as context:
            _decimal_context(context)
            return b - a
    except DecimalException:
        return None


def compare_profiles(first_public_profile, second_public_profile):
    """Describe profile deltas; sampled aggregates never prove record equality."""
    first = first_public_profile.get("metrics", {})
    second = second_public_profile.get("metrics", {})
    first_names, second_names = name_map(first), name_map(second)
    results = []
    fields = ("null_rate", "distinct_rate", "blank_rate", "duplicate_rate", "min", "max", "mean", "median", "q25", "q75", "stddev", "text_length_mean")
    for name in sorted(first_names.keys() | second_names.keys()):
        a_name, b_name = first_names.get(name), second_names.get(name)
        a, b = first.get(a_name, {}), second.get(b_name, {})
        result = {"column": name, "reference_column": a_name, "target_column": b_name,
                  "status": "descriptive", "scope": "observed samples only",
                  "sample_counts": {"reference": a.get("sample_count", 0), "target": b.get("sample_count", 0)},
                  "denominators": {}, "deltas": {}, "standardized_mean_shift": None}
        if a_name is None or b_name is None:
            result.update(status="not_applicable", reason="column_missing")
            results.append(result)
            continue
        for role, metric in (("reference", a), ("target", b)):
            result["denominators"][role] = {
                "null_rate": metric.get("null_denominator", metric.get("sample_count", 0)),
                "distinct_rate": metric.get("distinct_denominator", metric.get("non_null_count", 0)),
                "duplicate_rate": metric.get("distinct_denominator", metric.get("non_null_count", 0)),
                "blank_rate": metric.get("blank_denominator", 0),
                "numeric": metric.get("numeric_count", 0),
            }
        result["deltas"] = {field: _delta(a.get(field), b.get(field)) for field in fields}
        result["delta_direction"] = "target_minus_reference"
        if not a.get("sample_count") or not b.get("sample_count"):
            result.update(status="inconclusive", reason="empty_sample")
        else:
            families = {a.get("family") or type_family(a.get("type")), b.get("family") or type_family(b.get("type"))}
            if len(families) != 1 and not families <= NUMERIC_FAMILIES:
                result.update(status="not_applicable", reason="incompatible_type_families")
                result["deltas"] = {field: value for field, value in result["deltas"].items() if field == "null_rate"}
            elif any(metric.get("unavailable_count", 0) or metric.get("unsupported_count", 0) or metric.get("non_finite_count", 0) for metric in (a, b)):
                result.update(status="inconclusive", reason="unavailable_or_invalid_values")
            if families <= NUMERIC_FAMILIES and a.get("numeric_count", 0) and b.get("numeric_count", 0):
                try:
                    with localcontext() as context:
                        _decimal_context(context)
                        a_std, b_std = a.get("stddev"), b.get("stddev")
                        shift = result["deltas"].get("mean")
                        if a_std is not None and b_std is not None and shift is not None:
                            spread = ((Decimal(str(a_std)) ** 2 + Decimal(str(b_std)) ** 2) / 2).sqrt()
                            result["standardized_mean_shift"] = shift / spread if spread else Decimal(0) if not shift else None
                            result["standardized_mean_shift_status"] = "available" if spread or not shift else "zero_spread"
                except DecimalException:
                    result["standardized_mean_shift_status"] = "inconclusive"
        results.append(result)
    return results


def validate_saved_result(result):
    """Audita consistência interna; não reconstrói amostras que não foram salvas."""
    issues = []
    if "sources" not in result:
        for side in ("first", "second"):
            statistics = result.get(side, {}).get("statistics", {})
            if not statistics:
                issues.append(f"{side}: missing numeric statistics")
            for name, values in statistics.items():
                try:
                    low, mean, high = map(Decimal, values)
                    if not all(v.is_finite() for v in (low, mean, high)) or not low <= mean <= high:
                        issues.append(f"{side}.{name}: invalid min/mean/max")
                except (ValueError, TypeError, ArithmeticError):
                    issues.append(f"{side}.{name}: unreadable numeric statistics")
        issues.append("Legacy result has no sample counts, keys or method; equality cannot be validated")
    else:
        if len(result["sources"]) < 2:
            issues.append("Fewer than two sources")
        for index, source in enumerate(result["sources"], 1):
            n = source.get("sample_size")
            if not isinstance(n, int) or n < 0:
                issues.append(f"source {index}: invalid sample size")
                continue
            if n == 0:
                issues.append(f"source {index}: empty sample; data comparison inconclusive")
            missing = set(source.get("columns", {})) - set(source.get("metrics", {}))
            if missing:
                issues.append(f"source {index}: missing column metrics")
            for name, metric in source.get("metrics", {}).items():
                nulls = metric.get("null_count")
                if metric.get("sample_count") != n or not isinstance(nulls, int) or not 0 <= nulls <= n:
                    issues.append(f"source {index}.{name}: inconsistent counts")
                    continue
                rate = metric.get("null_rate")
                if (n == 0 and rate is not None) or (n > 0 and (not isinstance(rate, (int, float))
                        or not math.isclose(rate, nulls / n, abs_tol=1e-12))):
                    issues.append(f"source {index}.{name}: inconsistent null rate")
                distinct = metric.get("distinct_count")
                if not isinstance(distinct, int) or not 0 <= distinct <= n - nulls:
                    issues.append(f"source {index}.{name}: inconsistent distinct count")
                else:
                    rate = metric.get("distinct_rate")
                    denominator = metric.get("distinct_denominator", n - nulls)
                    if (not denominator and rate is not None) or (denominator and
                            (not isinstance(rate, (int, float)) or
                             not math.isclose(rate, distinct / denominator, abs_tol=1e-12))):
                        issues.append(f"source {index}.{name}: inconsistent distinct rate")
                if "mean" in metric:
                    try:
                        low, mean, high = (Decimal(str(metric[field])) for field in ("min", "mean", "max"))
                        if not all(v.is_finite() for v in (low, mean, high)) or not low <= mean <= high:
                            issues.append(f"source {index}.{name}: invalid min/mean/max")
                    except (ValueError, TypeError, ArithmeticError, KeyError):
                        issues.append(f"source {index}.{name}: unreadable numeric statistics")
    if 'indicators' in result:
        from .assessment import audit_indicators
        issues.extend(audit_indicators(result['indicators']))
    return {"status": "inconclusive" if issues else "internally_consistent",
            "issues": issues, "scope": "saved aggregates only; original rows unavailable"}
