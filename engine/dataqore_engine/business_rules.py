"""Versioned, declarative business rules over bounded samples; no source queries."""
from collections import Counter
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import re
from typing import Annotated, Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator
from sqlalchemy import select
from . import models as m
from .storage import DomainError, json_safe
from .core.assessment import score
from .core.quality import NUMERIC_FAMILIES, UnavailableValue, metadata_family, value_token

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

class RequiredRule(StrictModel):
    kind: Literal["required"]
    reject_blank: bool = True
    whitespace_blank: bool = False

class NullableRule(StrictModel):
    null_policy: Literal["fail", "skip"] = "fail"

class DomainRule(NullableRule):
    kind: Literal["domain"]
    values: list[StrictStr | StrictInt | StrictBool] = Field(min_length=1, max_length=200)
    timezone: str | None = Field(default=None, max_length=100)

class RangeRule(NullableRule):
    kind: Literal["range"]
    minimum: StrictStr | None = Field(default=None, max_length=1024)
    maximum: StrictStr | None = Field(default=None, max_length=1024)
    include_minimum: bool = True
    include_maximum: bool = True
    timezone: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def bounds(self):
        if self.minimum is None and self.maximum is None:
            raise ValueError("A range requires at least one bound.")
        return self

class TemporalOrderRule(NullableRule):
    kind: Literal["temporal_order"]
    other_column: str = Field(min_length=1, max_length=255)
    operator: Literal["lt", "lte", "gt", "gte"] = "lte"
    timezone: str | None = Field(default=None, max_length=100)

Definition = Annotated[RequiredRule | DomainRule | RangeRule | TemporalOrderRule, Field(discriminator="kind")]

class RuleInput(StrictModel):
    id: UUID | None = None
    name: str = Field(min_length=1, max_length=128, pattern=r"\S")
    column: str = Field(min_length=1, max_length=255)
    is_active: bool = True
    definition: Definition

class RuleSetUpdate(StrictModel):
    expected_revision: int = Field(ge=0, strict=True)
    rules: list[RuleInput] = Field(max_length=100)

class RuleOut(RuleInput):
    id: UUID
    version: int = Field(ge=1)

class RuleConfiguration(StrictModel):
    revision: int = 0
    rules: list[RuleOut] = Field(default_factory=list)

class RuleSetOut(StrictModel):
    dataset_id: UUID
    revision: int
    rules: list[RuleOut]


def invalid():
    return DomainError(422, "invalid_quality_rule", "Rule configuration is incompatible with dataset metadata or contains invalid typed values.")


def naive_timestamp(info):
    native = info.get("type", "").lower()
    return metadata_family(info) == "datetime" and info.get("timestamp_kind") != "aware" and not any(s in native for s in ("with time zone", "timestamptz", "datetimeoffset"))


def typed(value, info, zone=None, literal=False):
    family = metadata_family(info)
    if family in NUMERIC_FAMILIES:
        if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
            raise ValueError("numeric_type")
        if isinstance(value, str) and (not value or len(value) > 1024 or value.strip() != value):
            raise ValueError("numeric_type")
        if isinstance(value, str) and not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value):
            raise ValueError("numeric_type")
        number = Decimal(str(value))
        if not number.is_finite() or family == "integer" and number != number.to_integral_value():
            raise ValueError("numeric_type")
        return number
    if family == "text":
        if not isinstance(value, str) or literal and len(value) > 1024:
            raise ValueError("text_type")
        return value
    if family == "boolean":
        if literal and not isinstance(value, bool):
            raise ValueError("boolean_type")
        token = value_token(value, info)
        if token[0] != "boolean":
            raise ValueError("boolean_type")
        return token[1]
    if family == "date":
        if isinstance(value, datetime): raise ValueError("date_type")
        return value if isinstance(value, date) else date.fromisoformat(value)
    if family == "datetime":
        if literal and not isinstance(value, str): raise ValueError("timestamp_type")
        raw = value.isoformat() if isinstance(value, datetime) else value
        fraction = re.search(r"[T ]\d{2}:\d{2}:\d{2}[.,](\d+)", raw)
        subsecond = Decimal("0." + fraction[1]) if fraction else Decimal(0)
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            if not zone: raise ValueError("timezone_required")
            local = ZoneInfo(zone)
            candidates = {parsed.replace(tzinfo=local, fold=f).astimezone(timezone.utc) for f in (0, 1)
                if parsed.replace(tzinfo=local, fold=f).astimezone(timezone.utc).astimezone(local).replace(tzinfo=None) == parsed}
            if len(candidates) != 1: raise ValueError("ambiguous_or_nonexistent_local_time")
            return (candidates.pop().replace(microsecond=0), subsecond)
        return (parsed.astimezone(timezone.utc).replace(microsecond=0), subsecond)
    raise ValueError("unsupported_type")


def validate_rule(rule, columns):
    definition = rule.definition
    if rule.column not in columns: raise invalid()
    info = columns[rule.column]
    family = metadata_family(info)
    try:
        zone = getattr(definition, "timezone", None)
        if zone: ZoneInfo(zone)
        if isinstance(definition, RequiredRule): return
        if info.get("unsupported_reason"): raise ValueError()
        if isinstance(definition, DomainRule):
            if family not in NUMERIC_FAMILIES | {"text", "boolean", "date", "datetime"}: raise ValueError()
            if naive_timestamp(info) and not zone: raise ValueError()
            for value in definition.values: typed(value, info, zone, literal=True)
        elif isinstance(definition, RangeRule):
            if family not in NUMERIC_FAMILIES | {"date", "datetime"}: raise ValueError()
            if naive_timestamp(info) and not zone: raise ValueError()
            bounds = [typed(v, info, zone, literal=True) for v in (definition.minimum, definition.maximum) if v is not None]
            if len(bounds) == 2 and (bounds[0] > bounds[1] or bounds[0] == bounds[1] and not (definition.include_minimum and definition.include_maximum)): raise ValueError()
        else:
            other = columns.get(definition.other_column)
            if other is None or rule.column == definition.other_column or family not in {"date", "datetime"} or metadata_family(other) != family or other.get("unsupported_reason"): raise ValueError()
            if (naive_timestamp(info) or naive_timestamp(other)) and not zone: raise ValueError()
    except (ValueError, TypeError, InvalidOperation, ZoneInfoNotFoundError, OverflowError):
        raise invalid() from None


class BusinessRules:
    def __init__(self, engine): self.engine = engine

    def get(self, identifier):
        with self.engine.connect() as conn:
            row = conn.execute(select(m.datasets.c.quality_rules).where(m.datasets.c.id == identifier)).first()
            if row is None: raise DomainError(404, "not_found", "Dataset not found.")
            return {"dataset_id": identifier, **row[0]}

    def replace(self, identifier, payload):
        with self.engine.begin() as conn:
            row = conn.execute(select(m.datasets).where(m.datasets.c.id == identifier).with_for_update()).mappings().first()
            if row is None: raise DomainError(404, "not_found", "Dataset not found.")
            previous = row["quality_rules"]
            if previous["revision"] != payload.expected_revision:
                raise DomainError(409, "quality_rules_conflict", "Rules changed. Reload the rules before saving.")
            old = {r["id"]: r for r in previous["rules"]}
            seen, rules = set(), []
            for item in payload.rules:
                validate_rule(item, row["metadata"].get("columns", {}))
                identifier_rule = str(item.id or uuid4())
                if identifier_rule in seen or item.id is not None and identifier_rule not in old: raise invalid()
                seen.add(identifier_rule)
                saved = {**item.model_dump(mode="json"), "id": identifier_rule}
                before = old.get(identifier_rule)
                saved["version"] = 1 if before is None else before["version"] + int(saved != {k: v for k, v in before.items() if k != "version"})
                rules.append(saved)
            frozen = {"revision": previous["revision"] + 1, "rules": rules}
            conn.execute(m.datasets.update().where(m.datasets.c.id == identifier).values(quality_rules=frozen))
            return {"dataset_id": identifier, **frozen}


def assess_business(profile, config):
    columns, names, rows = profile["columns"], profile["sample_columns"], profile["sample_rows"]
    results = []
    for saved in config.get("rules", []):
        rule = RuleInput.model_validate({k: v for k, v in saved.items() if k != "version"})
        result = {"rule": saved, "scope": "observed sample only", "observed_rows": len(rows)}
        if not rule.is_active:
            results.append({**result, **score(0, 0, 0), "not_evaluated": 0, "state": "disabled", "reasons": {"rule_disabled": len(rows)}})
            continue
        passed = evaluated = 0
        reasons = Counter()
        try: validate_rule(rule, columns)
        except DomainError:
            results.append({**result, **score(0, 0, len(rows)), "not_evaluated": len(rows), "state": "inconclusive", "reasons": {"schema_incompatible": len(rows)}})
            continue
        definition, info = rule.definition, columns[rule.column]
        index = names.index(rule.column)
        choices = {typed(v, info, definition.timezone, literal=True) for v in definition.values} if isinstance(definition, DomainRule) else None
        low = typed(definition.minimum, info, definition.timezone, True) if isinstance(definition, RangeRule) and definition.minimum is not None else None
        high = typed(definition.maximum, info, definition.timezone, True) if isinstance(definition, RangeRule) and definition.maximum is not None else None
        for row in rows:
            values = [row[index]]
            if isinstance(definition, TemporalOrderRule): values.append(row[names.index(definition.other_column)])
            if any(isinstance(v, UnavailableValue) for v in values):
                reasons["capture_unavailable"] += 1; continue
            if any(v is None for v in values):
                if isinstance(definition, RequiredRule) or definition.null_policy == "fail": evaluated += 1
                else: reasons["null_skipped"] += 1
                continue
            try:
                if isinstance(definition, RequiredRule):
                    valid = not (isinstance(values[0], str) and (definition.reject_blank and values[0] == "" or definition.whitespace_blank and values[0].isspace()))
                    if info.get("unsupported_reason"): raise ValueError("unsupported_type")
                elif isinstance(definition, DomainRule):
                    valid = typed(values[0], info, definition.timezone) in choices
                elif isinstance(definition, RangeRule):
                    current = typed(values[0], info, definition.timezone)
                    valid = (low is None or current > low or definition.include_minimum and current == low) and (high is None or current < high or definition.include_maximum and current == high)
                else:
                    left = typed(values[0], info, definition.timezone)
                    right = typed(values[1], columns[definition.other_column], definition.timezone)
                    valid = {"lt": left < right, "lte": left <= right, "gt": left > right, "gte": left >= right}[definition.operator]
                evaluated += 1; passed += int(valid)
            except (ValueError, TypeError, InvalidOperation, OverflowError, AttributeError):
                reasons["invalid_or_unsupported_value"] += 1
        result.update(score(passed, evaluated, len(rows)), not_evaluated=len(rows)-evaluated,
            reasons=dict(reasons), state="failed" if passed < evaluated else "inconclusive" if evaluated < len(rows) or not rows else "passed")
        if not rows: result["reasons"] = {"empty_sample": 0}
        results.append(result)
    active = [r for r in results if r["state"] != "disabled"]
    overall = score(*(sum(r[k] for r in active) for k in ("passed", "evaluated", "total")))
    return {"rules_revision": config.get("revision", 0), "rules": results, "overall": overall, "scope": "observed sample only; not whole-table business correctness"}


def business_quality(sources, profiles):
    evaluated = [{"source": i, "dataset_id": source.get("dataset_id"), **assess_business(profile, source.get("quality_rules", {}))}
        for i, (source, profile) in enumerate(zip(sources, profiles), 1)]
    overall = score(*(sum(s["overall"][k] for s in evaluated) for k in ("passed", "evaluated", "total")))
    return {"method_version": 1, "sources": evaluated, "overall": overall, "scope": "observed sample only"}


def attach_business_quality(result, sources, profiles):
    business = business_quality(sources, profiles)
    result["indicators"]["business_quality"] = business
    active = [r for source in business["sources"] for r in source["rules"] if r["state"] != "disabled"]
    state = "not_evaluated" if not active else "failed" if business["overall"]["failed"] else "inconclusive" if any(r["state"] == "inconclusive" for r in active) else "passed"
    result["summary"]["business_quality_state"] = state
    for source in business["sources"]:
        for rule in source["rules"]:
            if rule["state"] in {"failed", "inconclusive"}:
                result["quality_findings"].append({"source":source["source"], "column":rule["rule"]["column"],
                    "kind":"business_rule", "rule_id":rule["rule"]["id"], "rule_version":rule["rule"]["version"],
                    "severity":"violation" if rule["failed"] else "inconclusive", "failed":rule["failed"],
                    "evaluated":rule["evaluated"], "not_evaluated":rule["not_evaluated"]})
    if state == "failed" and result["summary"]["status"] != "inconclusive":
        result["summary"]["status"] = "difference_observed"
    elif state == "inconclusive" and result["summary"]["status"] not in {"difference_observed", "inconclusive"}:
        result["summary"]["status"] = "inconclusive"
    return result
