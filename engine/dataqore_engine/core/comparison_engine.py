"""Five critical comparison metrics; full-scope counts and reproducible key samples."""

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4
import secrets
from .db_adapters import get_adapter
from .quality import NUMERIC_FAMILIES, type_family, values_equal
from .sampling import SamplingOptions, canonical_key, select_keys, size_bytes
from .query_audit import RecordingConnection
from ..storage import DomainError


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


def execute_comparison(
    selected,
    options=None,
    absolute_tolerance=Decimal(0),
    relative_tolerance=Decimal(0),
    comparison_options=None,
    resolved_scope=None,
    execution_id=None,
):
    from ..comparison_options import validate_options, metadata_signature

    if len(selected) != 2:
        raise ValueError("Select exactly two sources")
    options = options or SamplingOptions()
    abs_tol, rel_tol = Decimal(str(absolute_tolerance)), Decimal(
        str(relative_tolerance)
    )
    if any(not v.is_finite() or v < 0 for v in (abs_tol, rel_tol)):
        raise ValueError("Invalid tolerances")
    started = datetime.now(timezone.utc).isoformat()
    sources = []
    events = []
    for item in selected:
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
        sources.append(source)
    context = validate_options(
        comparison_options or {},
        [s["columns"] for s in sources],
        resolved=resolved_scope,
    )
    for i, side in enumerate(("left", "right")):
        sources[i].update(
            scope=context["predicates"][i],
            names={f"pair_{j}": p[side] for j, p in enumerate(context["mapping"])},
        )
    business = context["business_key"]
    if business:
        key_columns = [[p[side] for p in business] for side in ("left", "right")]
        key_kind = "business_key"
    else:
        logical, key_kind = common_comparison_key(sources)
        key_columns = [[s["names"][k] for k in logical] for s in sources]
    diagnostics = []
    valid = bool(key_columns[0])
    warnings = []
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
        valid &= bool(d["valid"])
    counts = [d["total_rows"] for d in diagnostics]
    delta = counts[1] - counts[0]
    row_count = {
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
    target = options.target(counts, max(len(s["columns"]) for s in sources))
    seed = options.seed if options.seed is not None else secrets.randbits(64)
    selection = []
    scanned = [0, 0]
    capture_problem = None
    if valid:
        try:
            selection, scanned = select_keys(
                sources, key_columns, target, seed, options.max_sample_bytes
            )
            if scanned != counts:
                capture_problem = "source_changed_during_read"
                valid = False
        except ValueError:
            capture_problem = "key_unavailable_or_changed"
            valid = False
    indexes = [{}, {}]
    used_bytes = 0
    if valid:
        allowed = {token for token, _ in selection}
        try:
            for i, (source, names) in enumerate(zip(sources, key_columns)):
                columns = list(source["columns"])
                _, rows = source["adapter"].fetch_keys(
                    source["conn"],
                    source["schema"],
                    source["table"],
                    columns,
                    names,
                    [v for _, v in selection],
                    metadata=source["columns"],
                    scope=source["scope"],
                )
                used_bytes += size_bytes(rows)
                if used_bytes > options.max_sample_bytes:
                    raise DomainError(
                        422,
                        "sample_byte_budget_exceeded",
                        "Captured records exceed the byte budget; reduce the sample.",
                    )
                positions = [columns.index(k) for k in names]
                infos = [source["columns"][k] for k in names]
                for row in rows:
                    token = canonical_key([row[j] for j in positions], infos)
                    if token in indexes[i] or token not in allowed:
                        raise ValueError("Source key changed")
                    indexes[i][token] = dict(zip(columns, row))
        except ValueError:
            valid = False
            capture_problem = "key_unavailable_or_changed"
    if not valid:
        indexes = [{}, {}]
    a, b = indexes
    common = a.keys() & b.keys()
    missing_left = len(b.keys() - a.keys())
    missing_right = len(a.keys() - b.keys())
    vanished = len(selection) - len(a.keys() | b.keys()) if valid else 0
    missing = missing_left + missing_right
    key_coverage = {
        "reference_to_target": rate(
            len(common),
            len(a),
            len(a) + vanished if valid else len(selection),
            reason=None if valid else capture_problem or "invalid_key",
        ),
        "target_to_reference": rate(
            len(common),
            len(b),
            len(b) + vanished if valid else len(selection),
            reason=None if valid else capture_problem or "invalid_key",
        ),
        "selected_keys": len(selection),
        "common_keys": len(common),
        "missing_in_reference": missing_left,
        "missing_in_target": missing_right,
        "unavailable_in_both": vanished,
        "scope": "sampled_union_of_keys",
    }
    unpaired = context["unmatched_columns"]
    pairs = context["mapping"]
    column_counts = [
        [0, missing, vanished if valid else len(selection)] for _ in pairs
    ]  # equal, different, unknown
    equal_rows = 0
    different_rows = missing
    unknown_rows = vanished if valid else len(selection)
    for token in common:
        changed = False
        unknown = bool(unpaired["left"] or unpaired["right"])
        for i, pair in enumerate(pairs):
            lm, rm = (
                sources[j]["columns"][pair[side]]
                for j, side in enumerate(("left", "right"))
            )
            lf, rf = _family(lm), _family(rm)
            compatible = (
                lf == rf
                or {lf, rf} <= NUMERIC_FAMILIES
                or {lf, rf} <= {"uuid", "uniqueidentifier"}
            )
            value = (
                values_equal(
                    a[token][pair["left"]],
                    b[token][pair["right"]],
                    lm,
                    rm,
                    abs_tol,
                    rel_tol,
                )
                if compatible
                else None
            )
            column_counts[i][0 if value is True else 1 if value is False else 2] += 1
            changed |= value is False
            unknown |= value is None
        if changed:
            different_rows += 1
        elif unknown:
            unknown_rows += 1
        else:
            equal_rows += 1
    reason = None if valid else capture_problem or "invalid_key"
    row_rate = {
        **rate(equal_rows, equal_rows + different_rows, len(selection), reason=reason),
        "different_rows": different_rows,
        "unknown_rows": unknown_rows,
        "missing_rows": missing,
        "formula": "100 * equal_rows / evaluated_row_positions",
    }
    column_rates = []
    for pair, (equal, different, unknown) in zip(pairs, column_counts):
        column_rates.append(
            {
                "left_column": pair["left"],
                "right_column": pair["right"],
                **rate(equal, equal + different, len(selection), reason=reason),
                "different_values": different,
                "unknown_values": unknown,
                "formula": "100 * equal_values / evaluated_column_positions",
            }
        )
    for side in ("left", "right"):
        for name in unpaired[side]:
            column_rates.append(
                {
                    "left_column": name if side == "left" else None,
                    "right_column": name if side == "right" else None,
                    **rate(0, 0, len(selection), reason="column_missing"),
                    "different_values": 0,
                    "unknown_values": len(selection),
                }
            )
    violation = bool(
        delta
        or missing
        or different_rows
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
            or not selection
            or unknown_rows
            or unpaired["left"]
            or unpaired["right"]
            else "compatible_in_sample"
        )
    )
    if capture_problem:
        warnings.append(capture_problem)
    for i, s in enumerate(sources):
        if s.get("read_consistency") != "stable_snapshot":
            warnings.append(
                f"Source {i+1}: reads use best effort; separate queries may observe different states."
            )
        events.extend({"source": i + 1, **e} for e in s["query_log"])
    warnings.extend(
        [
            "Sampled key and record metrics do not establish equality of entire tables.",
            "Key selection scans the full eligible scope. No synchronized snapshot across sources.",
            "Text-key grouping uses source collation and may conservatively reject a key.",
        ]
    )
    return {
        "format_version": 6,
        "engine_version": "6.0",
        "execution_id": str(execution_id or uuid4()),
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "sources": [
            {
                "dataset_id": s.get("dataset_id"),
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
        "column_mapping": pairs,
        "unmatched_columns": unpaired,
        "key_validation": diagnostics,
        "sampling_plan": {
            "algorithm": "sha256_bottom_k_union_v1",
            "canonicalization_version": 1,
            "seed": str(seed),
            "method": options.method,
            "percentage": options.percentage,
            "percentage_base": max(counts),
            "requested_keys": target,
            "selected_keys": len(selection),
            "scanned_key_rows": scanned,
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
        "summary": {"status": status, "scope": "sample", "alignment_available": valid},
        "warnings": warnings,
        "query_log": events,
    }
