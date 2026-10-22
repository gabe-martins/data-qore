"""Typed comparison configuration and pure, deterministic scope resolution.

Only this module converts public criteria to driver values. SQL is compiled by
the adapters, never supplied by the caller. No sampled keys are configuration.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
import re
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator

from .core.quality import NUMERIC_FAMILIES, type_family
from .core.db_adapters import TextCriterion
from .storage import DomainError


class OptionModel(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


ColumnName = Annotated[str, Field(min_length=1, max_length=255, pattern=r"^[^\x00]+$")]
Scalar = Annotated[StrictStr, Field(max_length=4096)] | StrictInt | StrictBool


class ColumnPair(OptionModel):
    left: ColumnName
    right: ColumnName


class ScopeFilter(ColumnPair):
    operator: Literal["eq", "in", "gte", "lt", "is_null", "is_not_null"]
    value: Scalar | list[Scalar] | None = None

    @model_validator(mode="after")
    def operand(self):
        if self.operator in {"is_null", "is_not_null"}:
            if self.value is not None:
                raise ValueError("Null predicates do not accept a value")
        elif self.operator == "in":
            if not isinstance(self.value, list) or not 1 <= len(self.value) <= 100:
                raise ValueError("IN requires between 1 and 100 values")
        elif self.value is None or isinstance(self.value, list):
            raise ValueError("This predicate requires one non-null value")
        return self


class Period(ColumnPair):
    kind: Literal["fixed", "relative"]
    timezone: str = "America/Sao_Paulo"
    start: str | None = None
    end: str | None = None
    unit: Literal["hours", "days", "months"] = "days"
    quantity: Annotated[int, Field(strict=True, ge=1, le=100000)] = 1
    safety_delay_minutes: Annotated[int, Field(strict=True, ge=0, le=525600)] = 0
    left_naive_timezone: str | None = None
    right_naive_timezone: str | None = None

    @model_validator(mode="after")
    def valid_period(self):
        for zone in (self.timezone, self.left_naive_timezone, self.right_naive_timezone):
            if zone is not None:
                try:
                    ZoneInfo(zone)
                except (ZoneInfoNotFoundError, ValueError):
                    raise ValueError("Use a valid IANA timezone") from None
        if self.kind == "fixed" and (not self.start or not self.end):
            raise ValueError("Fixed periods require start and end")
        if self.kind == "relative" and (self.start is not None or self.end is not None):
            raise ValueError("Relative periods do not accept fixed bounds")
        return self


class Scope(OptionModel):
    period: Period | None = None
    filters: Annotated[list[ScopeFilter], Field(max_length=20)] = Field(default_factory=list)


class ComparisonOptions(OptionModel):
    scope: Scope | None = None
    mapping: Annotated[list[ColumnPair], Field(max_length=500)] = Field(default_factory=list)
    business_key: Annotated[list[ColumnPair], Field(max_length=32)] = Field(default_factory=list)


def compact_options(value):
    model = ComparisonOptions.model_validate(value or {})
    return model.model_dump(exclude_defaults=True)


def invalid(code="invalid_comparison_options"):
    return DomainError(422, code, "Review the scope, column mapping and business key against current metadata.")


def family(info):
    return info.get("family") or type_family(info.get("type"))


def compatible(a, b):
    families = {family(a), family(b)}
    return len(families) == 1 or families <= NUMERIC_FAMILIES or families <= {"uuid", "uniqueidentifier"}


def effective_mapping(columns, options):
    """Manual exact names first; only unique casefold names are auto-paired."""
    result, used = [], [set(), set()]
    for pair in options.mapping:
        for i, name in enumerate((pair.left, pair.right)):
            if name not in columns[i] or name in used[i]:
                raise invalid("invalid_column_mapping")
            used[i].add(name)
        if not compatible(columns[0][pair.left], columns[1][pair.right]):
            raise invalid("incompatible_column_mapping")
        result.append({**pair.model_dump(), "method": "manual"})
    groups = [defaultdict(list), defaultdict(list)]
    for i in (0, 1):
        for name in columns[i]:
            if name not in used[i]:
                groups[i][name.casefold()].append(name)
    for key in sorted(groups[0].keys() & groups[1].keys()):
        if len(groups[0][key]) == len(groups[1][key]) == 1:
            names = [groups[i][key][0] for i in (0, 1)]
            result.append(dict(left=names[0], right=names[1], method="name"))
            for i in (0, 1):
                used[i].add(names[i])
    unmatched = {side: [n for n in columns[i] if n not in used[i]] for i, side in enumerate(("left", "right"))}
    return result, unmatched


def _local_boundary(day, zone):
    # Some IANA zones change clocks at midnight. Round-trip to the first real
    # instant of that date; reject a date skipped completely by a zone change.
    naive = datetime.combine(day, time.min)
    candidates = []
    for fold in (0, 1):
        instant = naive.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
        local = instant.astimezone(zone)
        if local.date() == day:
            candidates.append(instant)
    if not candidates:
        raise invalid("invalid_scope_period")
    return min(candidates)


def _fixed_bound(value, zone):
    try:
        if len(value) == 10:
            return _local_boundary(date.fromisoformat(value), zone)
        fraction = re.search(r"\d{2}:\d{2}:\d{2}[.,](\d+)", value)
        if fraction and len(fraction.group(1)) > 6:
            raise ValueError
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        raise invalid("invalid_scope_period") from None


def resolve_scope(value, at=None):
    options = ComparisonOptions.model_validate(value or {})
    scope = options.scope
    result = {"filters": [f.model_dump() for f in scope.filters]} if scope else {"filters": []}
    if not scope or scope.period is None:
        return result
    p = scope.period
    zone = ZoneInfo(p.timezone)
    at = at or datetime.now(timezone.utc)
    if at.tzinfo is None:
        raise invalid("invalid_scope_period")
    at = at.astimezone(timezone.utc)
    if p.kind == "relative":
        local = (at - timedelta(minutes=p.safety_delay_minutes)).astimezone(zone)
        if p.unit == "hours":
            end = local.replace(minute=0, second=0, microsecond=0).astimezone(timezone.utc)
            start = end - timedelta(hours=p.quantity)
        elif p.unit == "days":
            end = _local_boundary(local.date(), zone)
            start = _local_boundary(local.date() - timedelta(days=p.quantity), zone)
        else:
            end = _local_boundary(local.date().replace(day=1), zone)
            month_index = local.year * 12 + local.month - 1 - p.quantity
            year, month = divmod(month_index, 12)
            if year < 1:raise invalid("invalid_scope_period")
            start = _local_boundary(date(year, month + 1, 1), zone)
    else:
        start, end = _fixed_bound(p.start, zone), _fixed_bound(p.end, zone)
    if start >= end:
        raise invalid("invalid_scope_period")
    result["period"] = {**p.model_dump(), "start": start.isoformat(), "end": end.isoformat(),
        "start_day": start.astimezone(zone).date().isoformat(), "end_day": end.astimezone(zone).date().isoformat(),
        "resolved_at": at.isoformat(), "bounds": "[start, end)"}
    return result


def _temporal_kind(info):
    native = info.get("type", "").lower()
    f = family(info)
    if f == "binary":
        raise invalid("invalid_scope_type")
    if f == "date" or native == "date" and f != "datetime":
        return "date"
    if f not in {"datetime", "timestamp"} and not native.startswith(("timestamp", "datetime", "smalldatetime")):
        raise invalid("invalid_scope_type")
    return "aware" if info.get("timestamp_kind")=="aware" or "with time zone" in native or "timestamptz" in native or "datetimeoffset" in native else "naive"


def typed_value(value, info, operator):
    f = family(info)
    try:
        if f in {"integer", "decimal"}:
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                raise ValueError
            number = Decimal(str(value))
            if not number.is_finite() or abs(number.adjusted()) > 4096 or len(number.as_tuple().digits) > 4096 or f == "integer" and number != number.to_integral_value():
                raise ValueError
            if f == "integer":
                if not -(2**63) <= number < 2**63:
                    raise ValueError
                return int(number)
            return number
        if f == "text" and isinstance(value, str) and len(value) <= 4096 and "\x00" not in value:
            if operator not in {"eq", "in"}:
                raise ValueError
            native = info.get("type", "").lower().split("(")[0].strip()
            value.encode('utf-8')
            return TextCriterion(value, native in {"char", "character", "nchar", "bpchar"})
        if f in {"uuid", "uniqueidentifier"} and isinstance(value, str) and operator in {"eq", "in"}:
            return str(UUID(value))
        if f == "boolean" and isinstance(value, bool) and operator in {"eq", "in"}:
            return value
        if f == "date" and isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return date.fromisoformat(value)
        # Timestamps belong in the period, where timezone semantics are
        # explicit. Floating point/binary/LOB filter casts are unsupported.
    except (ValueError, InvalidOperation):
        pass
    raise invalid("invalid_scope_value")


def validate_options(value, columns, resolved=None):
    options = ComparisonOptions.model_validate(value or {})
    pairs, unmatched = effective_mapping(columns, options)
    effective = {(p["left"], p["right"]) for p in pairs}
    seen = [set(), set()]
    for key in options.business_key:
        if (key.left, key.right) not in effective:
            raise invalid("invalid_business_key")
        for i, name in enumerate((key.left, key.right)):
            if name in seen[i] or family(columns[i][name]) not in {"integer", "decimal", "text", "binary", "uuid", "uniqueidentifier"}:
                raise invalid("invalid_business_key")
            seen[i].add(name)
    resolved = resolved if resolved is not None else resolve_scope(value)
    predicates = [[], []]
    for condition in resolved.get("filters", []):
        f = ScopeFilter.model_validate(condition)
        infos = []
        for i, name in enumerate((f.left, f.right)):
            if name not in columns[i]:
                raise invalid("scope_column_not_found")
            infos.append(columns[i][name])
        if not compatible(*infos) or {family(x) for x in infos} == {"integer", "float"}:
            raise invalid("invalid_scope_type")
        for i, name in enumerate((f.left, f.right)):
            values = [] if f.operator in {"is_null", "is_not_null"} else f.value if f.operator == "in" else [f.value]
            bound = [typed_value(v, infos[i], f.operator) for v in values]
            predicates[i].append((name, f.operator, bound))
    period = resolved.get("period")
    if period:
        start, end = (datetime.fromisoformat(period[k]) for k in ("start", "end"))
        zone = ZoneInfo(period["timezone"])
        kinds = []
        for i, side in enumerate(("left", "right")):
            name = period[side]
            if name not in columns[i]:
                raise invalid("scope_column_not_found")
            kind = _temporal_kind(columns[i][name])
            kinds.append(kind)
            bounds = [start, end]
            if kind == "date":
                if period.get("unit") == "hours":raise invalid("invalid_scope_type")
                days = [x.astimezone(zone).date() for x in bounds]
                if any(_local_boundary(d, zone) != x for d, x in zip(days, bounds)):
                    raise invalid("invalid_scope_period")
                bounds = days
            elif kind == "naive":
                naive_zone = period.get(side + "_naive_timezone")
                if not naive_zone:
                    raise invalid("naive_timezone_required")
                if columns[i][name].get("comparison_timezone") == "UTC" and naive_zone not in {"UTC", "Etc/UTC"}:
                    raise invalid("source_timezone_required")
                tz = ZoneInfo(naive_zone)
                bounds = [x.astimezone(tz).replace(tzinfo=None) for x in bounds]
                # A naive interval cannot distinguish the two occurrences of
                # a clock value at a DST rollback. Require unambiguous bounds
                # and equivalent instant intervals (not an arbitrary fold).
                for local, instant in zip(bounds, (start, end)):
                    possibilities = {local.replace(tzinfo=tz, fold=f).astimezone(timezone.utc) for f in (0, 1)}
                    if possibilities != {instant}:
                        raise invalid("ambiguous_scope_period")
            predicates[i].extend([(name, "gte", [bounds[0]]), (name, "lt", [bounds[1]])])
        if "date" in kinds:
            # Date values denote calendar days in the scope zone. A naive
            # timestamp interpreted in a different zone is not equivalent.
            for side, kind in zip(("left", "right"), kinds):
                if kind == "naive" and period[side + "_naive_timezone"] != period["timezone"]:
                    raise invalid("invalid_scope_type")
    if any(sum(len(term[2]) for term in terms) > 800 for terms in predicates):
        raise invalid("scope_parameter_budget_exceeded")
    return {"mapping": pairs, "unmatched_columns": unmatched, "business_key": [p.model_dump() for p in options.business_key],
        "resolved_scope": resolved, "predicates": predicates,
        "key_validation": "Full-scope null and duplicate validation runs during execution, not preview."}


def metadata_signature(columns):
    return {name: {k: info.get(k) for k in ("type", "family", "precision", "scale", "datetime_precision", "length", "collation", "comparison_timezone", "nullable", "primary_key", "primary_key_order", "unique_groups", "unique_orders")}
            for name, info in columns.items()}
