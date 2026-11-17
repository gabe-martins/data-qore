"""Five critical comparison metrics; full-scope counts and reproducible key samples.

One execution runs as a short pipeline. Each stage owns one concern and is timed:

    open sources → resolve and validate the key → select and fetch the sample
    → evaluate aligned records → capture evidence → assemble the result

The five metrics keep their published formulas. `statistics` only explains
them (intervals, record outcomes, difference kinds) and holds aggregates only.
"""

from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from time import perf_counter
from uuid import uuid4
import secrets
from .db_adapters import get_adapter
from .quality import NUMERIC_FAMILIES, type_family, values_equal
from .sampling import SamplingOptions, canonical_key, select_keys, size_bytes
from .statistics import (
    ColumnStatistics,
    difference_totals,
    differing_columns_histogram,
    rate_interval,
    unavailable_column,
)
from .query_audit import RecordingConnection
from ..storage import DomainError

SIDES = ("left", "right")
FORMAT_VERSION = 8
ENGINE_VERSION = "8.0"
STATIC_WARNINGS = (
    "Sampled key and record metrics do not establish equality of entire tables.",
    "Key selection scans the full eligible scope. No synchronized snapshot across sources.",
    "Text-key grouping uses source collation and may conservatively reject a key.",
)


def _family(info):
    return info.get("family") or type_family(info.get("type"))


def _key_candidates(source):
    columns = source["columns"]
    reverse = {physical: logical for logical, physical in source["names"].items()}
    physical_primary = [
        name
        for name, info in sorted(
            columns.items(), key=lambda pair: pair[1].get("primary_key_order") or 10**6
        )
        if info.get("primary_key")
    ]
    primary = (
        [reverse[name] for name in physical_primary]
        if all(name in reverse for name in physical_primary)
        else []
    )
    result = [(primary, "primary_key")] if primary else []
    groups = {}
    for name, info in columns.items():
        for group in info.get("unique_groups", []):
            groups.setdefault(group, []).append(reverse.get(name))
    for names in sorted(
        groups.values(), key=lambda group: (len(group), sorted(str(x) for x in group))
    ):
        if None not in names and all(
            columns[source["names"][name]].get("nullable") is False for name in names
        ):
            result.append((names, "unique_constraint"))
    return result


def common_comparison_key(sources):
    if len(sources) != 2:
        return [], None
    right = _key_candidates(sources[1])
    supported = {"integer", "decimal", "text", "binary", "uuid", "uniqueidentifier"}
    for keys, kind in _key_candidates(sources[0]):
        if not any(set(keys) == set(candidate) for candidate, _ in right):
            continue
        compatible = True
        for key in keys:
            families = {
                _family(source["columns"][source["names"][key]]) for source in sources
            }
            compatible &= (
                families <= {"integer", "decimal"}
                or families <= {"uuid", "uniqueidentifier"}
                or len(families) == 1
                and families <= supported
            )
        if compatible:
            return keys, kind
    return [], None


def rate(numerator, denominator, total=None, *, scope="sample", reason=None):
    total = denominator if total is None else total
    if not 0 <= numerator <= denominator <= total:
        raise ValueError("Invalid metric counts")
    return {
        "numerator": numerator,
        "denominator": denominator,
        "total": total,
        "not_evaluated": total - denominator,
        "percentage": (
            (Decimal(numerator) * 100 / denominator).quantize(Decimal(".0001"))
            if denominator
            else None
        ),
        "coverage_percentage": (
            (Decimal(denominator) * 100 / total).quantize(Decimal(".0001"))
            if total
            else None
        ),
        "scope": scope,
        "status": (
            "partial"
            if denominator < total
            else "available" if denominator else "not_evaluated"
        ),
        "reason": reason
        or (
            "incomplete_evaluation"
            if denominator < total
            else "empty_denominator" if not denominator else None
        ),
    }


class _Timings:
    """Wall-clock time per pipeline stage, including time spent in the sources."""

    def __init__(self):
        self.stages = []

    @contextmanager
    def stage(self, name):
        start = perf_counter()
        try:
            yield
        finally:
            self.stages.append(
                {"stage": name, "milliseconds": round((perf_counter() - start) * 1000, 3)}
            )


@dataclass(frozen=True)
class _Pair:
    """One mapped column pair, resolved once instead of per sampled record."""

    left: str
    right: str
    left_metadata: dict
    right_metadata: dict
    comparable: bool


@dataclass
class _Sample:
    """Keys selected from the union and the records fetched for them."""

    selection: list = field(default_factory=list)
    scanned: list = field(default_factory=lambda: [0, 0])
    records: list = field(default_factory=lambda: [{}, {}])
    valid: bool = False
    problem: str | None = None


@dataclass
class _Evaluation:
    equal_rows: int
    different_rows: int
    unknown_rows: int
    column_counts: list
    column_statistics: list
    differing_columns: Counter
    classifications: dict


def _open_source(item):
    from ..comparison_options import metadata_signature

    log = []
    source = {**item, "conn": RecordingConnection(item["conn"], log)}
    adapter = item.get("adapter") or get_adapter(
        item["creds"]["type"], item.get("catalog_name", "")
    )
    columns = adapter.metadata(source["conn"], item["schema"], item["table"])
    if not columns:
        raise DomainError(422, "metadata_unavailable", "Refresh source metadata.")
    if (
        "expected_columns" in item
        and metadata_signature(columns) != item["expected_columns"]
    ):
        raise DomainError(
            409, "source_schema_changed", "Source metadata changed after enqueue."
        )
    source.update(adapter=adapter, columns=columns, query_log=log)
    # MySQL's prepared snapshot is only stable for InnoDB tables.
    if source.get("read_consistency") == "transactional_snapshot_pending":
        cursor = source["conn"].cursor()
        try:
            cursor.execute(
                "SELECT ENGINE FROM information_schema.tables WHERE table_schema = COALESCE(NULLIF(%s, ''), DATABASE()) AND table_name = %s",
                (source["schema"], source["table"]),
            )
            row = cursor.fetchone()
            source["read_consistency"] = (
                "stable_snapshot"
                if row and str(row[0]).lower() == "innodb"
                else "best_effort"
            )
        finally:
            cursor.close()
    return source


def _resolve_key(sources, context):
    business = context["business_key"]
    if business:
        return [[p[side] for p in business] for side in SIDES], "business_key"
    logical, kind = common_comparison_key(sources)
    return [[s["names"][k] for k in logical] for s in sources], kind


def _validate_keys(sources, key_columns):
    diagnostics = []
    for source, names in zip(sources, key_columns):
        if names:
            d = source["adapter"].validate_key(
                source["conn"],
                source["schema"],
                source["table"],
                names,
                source["scope"],
            )
        else:
            d = {
                "total_rows": source["adapter"].count_rows(
                    source["conn"], source["schema"], source["table"], source["scope"]
                ),
                "null_key_rows": None,
                "duplicate_groups": None,
                "duplicate_excess_rows": None,
                "valid": False,
                "reason": "comparison_key_unavailable",
            }
        d.update(
            columns=names,
            scope="entire_selected_scope",
            read_consistency=source.get("read_consistency", "best_effort"),
        )
        diagnostics.append(d)
    return diagnostics


def _row_count_match(counts):
    delta = counts[1] - counts[0]
    return {
        "reference_count": counts[0],
        "target_count": counts[1],
        "equal": delta == 0,
        "signed_difference": delta,
        "absolute_difference": abs(delta),
        "percentage_difference": (
            (Decimal(abs(delta)) * 100 / counts[0]).quantize(Decimal(".0001"))
            if counts[0]
            else Decimal(0) if not delta else None
        ),
        "reason": "zero_reference_count" if not counts[0] and delta else None,
        "scope": "entire_selected_scope",
    }


def _duplicate_key_rates(diagnostics):
    duplicates = []
    for i, d in enumerate(diagnostics):
        known = d["null_key_rows"] is not None
        denominator = d["total_rows"] - d["null_key_rows"] if known else 0
        duplicates.append(
            {
                "source": i + 1,
                **rate(
                    d["duplicate_excess_rows"] or 0,
                    denominator,
                    scope="entire_selected_scope",
                    reason=None if known else "comparison_key_unavailable",
                ),
                "duplicate_groups": d["duplicate_groups"],
                "null_key_rows": d["null_key_rows"],
                "columns": d["columns"],
                "formula": "100 * duplicate_excess_rows / non_null_key_rows",
            }
        )
    return duplicates


def _select_sample(sources, key_columns, counts, target, seed, byte_budget):
    """Bottom-k keys of the union; a scope that moved during the scan is not aligned."""
    sample = _Sample(valid=True)
    try:
        sample.selection, sample.scanned = select_keys(
            sources, key_columns, target, seed, byte_budget
        )
    except ValueError:
        sample.valid, sample.problem = False, "key_unavailable_or_changed"
        return sample
    if sample.scanned != counts:
        sample.valid, sample.problem = False, "source_changed_during_read"
    return sample


def _fetch_sample(sample, sources, key_columns, capture_columns, byte_budget):
    """Read the selected keys from both sources; any changed key voids alignment."""
    allowed = {token for token, _ in sample.selection}
    values = [v for _, v in sample.selection]
    records = [{}, {}]
    used_bytes = 0
    try:
        for i, (source, names) in enumerate(zip(sources, key_columns)):
            columns = list(capture_columns[i])
            _, rows = source["adapter"].fetch_keys(
                source["conn"],
                source["schema"],
                source["table"],
                columns,
                names,
                values,
                metadata=source["columns"],
                scope=source["scope"],
            )
            used_bytes += size_bytes(rows)
            if used_bytes > byte_budget:
                raise DomainError(
                    422,
                    "sample_byte_budget_exceeded",
                    "Captured records exceed the byte budget; reduce the sample.",
                )
            positions = [columns.index(k) for k in names]
            infos = [source["columns"][k] for k in names]
            for row in rows:
                token = canonical_key([row[j] for j in positions], infos)
                if token in records[i] or token not in allowed:
                    raise ValueError("Source key changed")
                records[i][token] = dict(zip(columns, row))
    except ValueError:
        sample.valid, sample.problem = False, "key_unavailable_or_changed"
        return
    sample.records = records


def _pair_plan(sources, context):
    pairs = []
    for mapped in context["mapping"]:
        metadata = [
            {
                **source["columns"][mapped[side]],
                "naive_timezone": context["timestamp_timezones"][side].get(mapped[side]),
            }
            for source, side in zip(sources, SIDES)
        ]
        families = {_family(metadata[0]), _family(metadata[1])}
        pairs.append(
            _Pair(
                mapped["left"],
                mapped["right"],
                metadata[0],
                metadata[1],
                len(families) == 1
                or families <= NUMERIC_FAMILIES
                or families <= {"uuid", "uniqueidentifier"},
            )
        )
    return pairs


def _evaluate(sample, pairs, has_unpaired, abs_tol, rel_tol, keep_classifications):
    """Classify every aligned record and column position of the sample."""
    a, b = sample.records
    missing = len(a.keys() ^ b.keys())
    unavailable = (
        len(sample.selection) - len(a.keys() | b.keys())
        if sample.valid
        else len(sample.selection)
    )
    column_counts = [[0, missing, unavailable] for _ in pairs]  # equal, different, unknown
    column_statistics = [ColumnStatistics() for _ in pairs]
    equal_rows, different_rows, unknown_rows = 0, missing, unavailable
    differing_columns = Counter()
    classifications = {}
    for token in a.keys() & b.keys():
        left_row, right_row = a[token], b[token]
        differing = 0
        unknown = has_unpaired
        outcomes = []
        for i, pair in enumerate(pairs):
            left, right = left_row[pair.left], right_row[pair.right]
            value = (
                values_equal(left, right, pair.left_metadata, pair.right_metadata, abs_tol, rel_tol)
                if pair.comparable
                else None
            )
            column_counts[i][0 if value is True else 1 if value is False else 2] += 1
            column_statistics[i].observe(left, right, value, pair.left_metadata, pair.right_metadata)
            differing += value is False
            unknown |= value is None
            outcomes.append(value)
        if differing:
            different_rows += 1
            differing_columns[differing] += 1
        elif unknown:
            unknown_rows += 1
        else:
            equal_rows += 1
        if keep_classifications:
            classifications[token] = (
                "different" if differing else "unknown" if unknown else "equal",
                outcomes,
            )
    return _Evaluation(
        equal_rows, different_rows, unknown_rows, column_counts,
        column_statistics, differing_columns, classifications,
    )


def _capture_evidence(capture, sample, evaluation, sources, pairs, unpaired, key_columns):
    """Hand sampled records to the encrypted store, divergences first."""
    from ..evidence import cell

    a, b = sample.records

    def record_state(token):
        if token in evaluation.classifications:
            return evaluation.classifications[token][0]
        return "only_source" if token in a else "only_target" if token in b else "unknown"

    priority = {"different": 0, "only_source": 1, "only_target": 2, "unknown": 3, "equal": 4}
    states = {token: record_state(token) for token, _ in sample.selection}
    key_metadata = [sources[0]["columns"][name] for name in key_columns[0]]
    for token, values in sorted(sample.selection, key=lambda entry: priority[states[entry[0]]]):
        present = (token in a, token in b)
        rows = (a.get(token, {}), b.get(token, {}))
        outcomes = evaluation.classifications.get(token, (None, []))[1]
        cells = []
        for j, pair in enumerate(pairs):
            value = outcomes[j] if outcomes else False if any(present) else None
            cells.append({
                "id": f"pair_{j}", "left_column": pair.left, "right_column": pair.right,
                "status": "equal" if value is True else "different" if value is False else "unknown",
                "left": cell(rows[0].get(pair.left), pair.left_metadata, present[0]),
                "right": cell(rows[1].get(pair.right), pair.right_metadata, present[1]),
            })
        for i, side in enumerate(SIDES):
            for name in unpaired[side]:
                cells.append({
                    "id": side + ":" + name,
                    "left_column": name if i == 0 else None,
                    "right_column": name if i == 1 else None,
                    "status": "unknown",
                    side: cell(rows[i].get(name), sources[i]["columns"][name], present[i]),
                    SIDES[1 - i]: {"kind": "missing", "raw": None},
                })
        capture.capture(values, key_metadata, states[token], cells)


def _statistics(sample, evaluation, column_rates, key_coverage, row_rate, requested, timings):
    a, b = sample.records
    # Fewer keys than requested means the sample already holds the whole union.
    complete = sample.valid and len(sample.selection) < requested
    missing = len(a.keys() ^ b.keys())
    columns = [
        {
            "left_column": metric["left_column"],
            "right_column": metric["right_column"],
            **(
                evaluation.column_statistics[i].summary(metric, missing, complete)
                if i < len(evaluation.column_statistics)
                else unavailable_column()
            ),
        }
        for i, metric in enumerate(column_rates)
    ]
    return {
        "scope": "sampled_union_of_keys",
        "sample_is_complete_scope": complete,
        "record_outcomes": {
            "equal": evaluation.equal_rows,
            "different": evaluation.different_rows - missing,
            "only_reference": len(a.keys() - b.keys()),
            "only_target": len(b.keys() - a.keys()),
            "unknown": evaluation.unknown_rows,
            "total": len(sample.selection),
        },
        "intervals": {
            "row_match_rate": rate_interval(row_rate["numerator"], row_rate["denominator"], complete),
            "key_coverage": {
                direction: rate_interval(
                    key_coverage[direction]["numerator"],
                    key_coverage[direction]["denominator"],
                    complete,
                )
                for direction in ("reference_to_target", "target_to_reference")
            },
        },
        "differing_columns_per_record": differing_columns_histogram(evaluation.differing_columns),
        "difference_kinds": difference_totals(columns),
        "columns": columns,
        "stage_timings": timings.stages,
    }


def execute_comparison(
    selected,
    options=None,
    absolute_tolerance=Decimal(0),
    relative_tolerance=Decimal(0),
    comparison_options=None,
    resolved_scope=None,
    execution_id=None,
    evidence_capture=None,
):
    from ..comparison_options import validate_options

    if len(selected) != 2:
        raise ValueError("Select exactly two sources")
    options = options or SamplingOptions()
    abs_tol, rel_tol = Decimal(str(absolute_tolerance)), Decimal(
        str(relative_tolerance)
    )
    if any(not v.is_finite() or v < 0 for v in (abs_tol, rel_tol)):
        raise ValueError("Invalid tolerances")
    started = datetime.now(timezone.utc).isoformat()
    timings = _Timings()

    with timings.stage("metadata"):
        sources = [_open_source(item) for item in selected]
        context = validate_options(
            comparison_options or {},
            [s["columns"] for s in sources],
            resolved=resolved_scope,
        )
        for i, side in enumerate(SIDES):
            sources[i].update(
                scope=context["predicates"][i],
                names={f"pair_{j}": p[side] for j, p in enumerate(context["mapping"])},
            )
        key_columns, key_kind = _resolve_key(sources, context)
        pairs = _pair_plan(sources, context)
        unpaired = context["unmatched_columns"]

    with timings.stage("key_validation"):
        diagnostics = _validate_keys(sources, key_columns)
    key_usable = bool(key_columns[0]) and all(d["valid"] for d in diagnostics)
    counts = [d["total_rows"] for d in diagnostics]
    row_count = _row_count_match(counts)
    duplicates = _duplicate_key_rates(diagnostics)

    capture_columns = [
        {n: v for n, v in s["columns"].items() if n not in context["excluded_columns"][side]}
        for s, side in zip(sources, SIDES)
    ]
    target = options.target(counts, max(map(len, capture_columns)))
    seed = options.seed if options.seed is not None else secrets.randbits(64)
    sample = _Sample()
    if key_usable:
        with timings.stage("key_selection"):
            sample = _select_sample(
                sources, key_columns, counts, target, seed, options.max_sample_bytes
            )
        if sample.valid:
            with timings.stage("record_fetch"):
                _fetch_sample(
                    sample, sources, key_columns, capture_columns, options.max_sample_bytes
                )
    valid = sample.valid
    selected_keys = len(sample.selection)

    with timings.stage("evaluation"):
        evaluation = _evaluate(
            sample,
            pairs,
            bool(unpaired["left"] or unpaired["right"]),
            abs_tol,
            rel_tol,
            evidence_capture is not None,
        )
    a, b = sample.records
    common = len(a.keys() & b.keys())
    missing_left = len(b.keys() - a.keys())
    missing_right = len(a.keys() - b.keys())
    missing = missing_left + missing_right
    vanished = selected_keys - len(a.keys() | b.keys()) if valid else 0
    reason = None if valid else sample.problem or "invalid_key"
    key_coverage = {
        "reference_to_target": rate(
            common, len(a), len(a) + vanished if valid else selected_keys, reason=reason
        ),
        "target_to_reference": rate(
            common, len(b), len(b) + vanished if valid else selected_keys, reason=reason
        ),
        "selected_keys": selected_keys,
        "common_keys": common,
        "missing_in_reference": missing_left,
        "missing_in_target": missing_right,
        "unavailable_in_both": vanished,
        "scope": "sampled_union_of_keys",
    }
    row_rate = {
        **rate(
            evaluation.equal_rows,
            evaluation.equal_rows + evaluation.different_rows,
            selected_keys,
            reason=reason,
        ),
        "different_rows": evaluation.different_rows,
        "unknown_rows": evaluation.unknown_rows,
        "missing_rows": missing,
        "formula": "100 * equal_rows / evaluated_row_positions",
    }
    column_rates = [
        {
            "left_column": pair.left,
            "right_column": pair.right,
            **rate(equal, equal + different, selected_keys, reason=reason),
            "different_values": different,
            "unknown_values": unknown,
            "formula": "100 * equal_values / evaluated_column_positions",
        }
        for pair, (equal, different, unknown) in zip(pairs, evaluation.column_counts)
    ]
    for side in SIDES:
        for name in unpaired[side]:
            column_rates.append(
                {
                    "left_column": name if side == "left" else None,
                    "right_column": name if side == "right" else None,
                    **rate(0, 0, selected_keys, reason="column_missing"),
                    "different_values": 0,
                    "unknown_values": selected_keys,
                }
            )

    violation = bool(
        row_count["signed_difference"]
        or missing
        or evaluation.different_rows
        or any(
            (d["null_key_rows"] or 0) or (d["duplicate_excess_rows"] or 0)
            for d in diagnostics
        )
    )
    status = (
        "difference_observed"
        if violation
        else (
            "inconclusive"
            if not valid
            or not sample.selection
            or evaluation.unknown_rows
            or unpaired["left"]
            or unpaired["right"]
            else "compatible_in_sample"
        )
    )
    warnings = [sample.problem] if sample.problem else []
    events = []
    for i, s in enumerate(sources):
        if s.get("read_consistency") != "stable_snapshot":
            warnings.append(
                f"Source {i+1}: reads use best effort; separate queries may observe different states."
            )
        events.extend({"source": i + 1, **e} for e in s["query_log"])
    warnings.extend(STATIC_WARNINGS)
    finished_at = datetime.now(timezone.utc).isoformat()
    if evidence_capture is not None and valid:
        with timings.stage("evidence_capture"):
            _capture_evidence(
                evidence_capture, sample, evaluation, sources, pairs, unpaired, key_columns
            )
    result = {
        "format_version": FORMAT_VERSION,
        "engine_version": ENGINE_VERSION,
        "execution_id": str(execution_id or uuid4()),
        "started_at": started,
        "finished_at": finished_at,
        "sources": [
            {
                "dataset_id": s.get("dataset_id"),
                "connection_name": s.get("connection"),
                "connector": s["creds"]["type"],
                "catalog_name": s.get("catalog_name", ""),
                "table_name": s["table"],
                "table": ".".join(
                    p for p in (s.get("catalog_name", ""), s["schema"], s["table"]) if p
                ),
                "schema": s["schema"],
                "columns": s["columns"],
            }
            for s in sources
        ],
        "resolved_scope": context["resolved_scope"],
        "column_mapping": context["mapping"],
        "unmatched_columns": unpaired,
        "comparison_options": comparison_options or {},
        "key_validation": diagnostics,
        "sampling_plan": {
            "algorithm": "sha256_bottom_k_union_v1",
            "canonicalization_version": 1,
            "seed": str(seed),
            "method": options.method,
            "percentage": options.percentage,
            "percentage_base": max(counts),
            "requested_keys": target,
            "selected_keys": selected_keys,
            "scanned_key_rows": sample.scanned,
            "key_kind": key_kind,
            "repeatability": "same seed, configuration and eligible key set; values may change",
            "absolute_tolerance": str(abs_tol),
            "relative_tolerance": str(rel_tol),
        },
        "metrics": {
            "row_count_match": row_count,
            "key_coverage": key_coverage,
            "duplicate_key_rate": duplicates,
            "row_match_rate": row_rate,
            "column_match_rate": column_rates,
        },
        "statistics": _statistics(
            sample, evaluation, column_rates, key_coverage, row_rate, target, timings
        ),
        "summary": {"status": status, "scope": "sample", "alignment_available": valid},
        "warnings": warnings,
        "query_log": events,
    }
    if evidence_capture is not None:
        result["evidence"] = evidence_capture.manifest(selected_keys, valid, finished_at)
        result["_evidence_rows"] = evidence_capture.rows
    return result
