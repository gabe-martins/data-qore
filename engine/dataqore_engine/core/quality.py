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
TOLERANCE_PRECISION = 128
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
    context.prec = TOLERANCE_PRECISION
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
