"""Read-only interpretation of saved evidence; never changes analytical formulas."""

from .core.quality import NUMERIC_FAMILIES, metadata_family

METRICS = ("sample_count", "null_count", "null_rate", "non_null_count",
           "blank_count", "blank_rate", "distinct_count", "distinct_rate",
           "duplicate_count", "duplicate_rate", "text_length_min", "text_length_max",
           "text_length_mean", "temporal_count", "temporal_min", "temporal_max",
           "min", "max", "mean", "median", "stddev", "q25", "q75")
NUMERIC = {"min", "max", "mean", "median", "stddev", "q25", "q75", "numeric_count"}
TEXT = {"blank_count", "blank_rate", "text_length_min", "text_length_max", "text_length_mean"}
TEMPORAL = {"temporal_count", "temporal_min", "temporal_max", "temporal_timezone"}


def state(status, reason=None, **counts):
    return {"status": status, "reason": reason,
            "counts": {k: v for k, v in counts.items() if isinstance(v, int) and not isinstance(v, bool)}}


def metric_evaluation(metric, name, metadata=None):
    metric = metric or {}
    family = metric.get("family") or metadata_family(metadata or {"type": metric.get("type", "")})
    counts = {k: metric.get(k) for k in ("sample_count", "non_null_count", "null_count", "observed_count",
                                        "unavailable_count", "unsupported_count", "non_finite_count")}
    # An incompatible statistic is inapplicable even if the sample is empty.
    if (name in NUMERIC and family not in NUMERIC_FAMILIES or
        name in TEXT and family != "text" or
        name in TEMPORAL and family not in {"date", "datetime", "time"}):
        if family not in {"", "unknown"}:
            return state("not_applicable", "metric_not_applicable_to_type", **counts)
    value = metric.get(name)
    if value is not None:
        partial = name not in {"sample_count", "null_count", "null_rate", "non_null_count",
                              "unavailable_count", "unsupported_count", "non_finite_count"} and not name.endswith("_denominator") and any(
            metric.get(k, 0) for k in ("unavailable_count", "unsupported_count", "non_finite_count"))
        return state("partial" if partial else "available", "unavailable_or_invalid_values" if partial else None, **counts)
    if metric.get("sample_count") == 0:
        return state("not_evaluated", "empty_sample", **counts)
    if metric.get("sample_count", 0) > 0 and metric.get("null_count") == metric["sample_count"]:
        return state("not_evaluated", "all_values_null", **counts)
    if metric.get("unavailable_count", 0):
        return state("not_evaluated", "capture_unavailable", **counts)
    if metric.get("unsupported_count", 0) or (metadata or {}).get("unsupported_reason"):
        return state("not_evaluated", "unsupported_type_or_values", **counts)
    if metric.get("non_finite_count", 0):
        return state("not_evaluated", "non_finite_values", **counts)
    if metric.get("numeric_summary_status") == "inconclusive":
        return state("not_evaluated", "calculation_unavailable", **counts)
    return state("not_evaluated", "historical_reason_unavailable", **counts)


def profile_evaluations(profile):
    metrics = profile.get("metrics") or {}
    return {name: metric_evaluation(metrics, name, profile.get("metadata")) for name in METRICS}


def indicator_evaluation(indicator, empty_reason="no_applicable_checks"):
    indicator = indicator or {}
    counts = {k: indicator.get(k) for k in ("passed", "evaluated", "total", "pending")}
    if indicator.get("percentage") is not None:
        partial = indicator.get("pending", 0) > 0
        return state("partial" if partial else "available", "incomplete_evaluation" if partial else None, **counts)
    return state("not_evaluated", empty_reason if indicator.get("evaluated") == 0 else "historical_reason_unavailable", **counts)


def result_evaluation(result, kind, parameters=None):
    parameters = parameters or {}
    plan = result.get("sampling_plan") or {}
    rows = result.get("row_comparisons") or []
    validation = result.get("key_validation") or []
    invalid = plan.get("mode") == "key_validation_failed" or any(v.get("valid") is False for v in validation)
    if kind == "profile":
        analysis = "profile"
        agreement = state("not_applicable", "single_source_profile")
    elif invalid:
        analysis = "invalid_key"
        agreement = state("not_evaluated", "invalid_key")
    elif rows:
        analysis = "aligned"
        reason = "empty_sample" if any(s.get("sample_size") == 0 for s in result.get("sources", [])) else "no_aligned_records"
        agreement = indicator_evaluation(result.get("indicators", {}).get("agreement"), reason)
    elif plan.get("mode") == "independent_random":
        analysis = "independent"
        requested = parameters.get("mode")
        reason = ("independent_sampling" if requested == "independent_random" else
                  "no_safe_key_alignment" if requested == "auto" else "historical_reason_unavailable")
        agreement = state("not_evaluated", reason)
    else:
        analysis = "unknown"
        agreement = state("not_evaluated", "historical_reason_unavailable")
    sources = []
    for source in result.get("sources", []):
        sources.append({"columns": {column: profile_evaluations({"metrics": metrics,
            "metadata": source.get("columns", {}).get(column, {})})
            for column, metrics in source.get("metrics", {}).items()}})
    comparisons = []
    for item in result.get("metric_comparisons", []):
        name = item.get("column", "")
        left, right = item.get("left_column", item.get("reference_column")), item.get("right_column", item.get("target_column"))
        a = sources[0]["columns"].get(left, {}) if sources else {}
        b = sources[1]["columns"].get(right, {}) if len(sources) > 1 else {}
        evaluations = {}
        for metric, value in item.get("deltas", {}).items():
            reason = item.get("reason")
            if reason in {"column_missing", "incompatible_type_families"}:
                evaluations[metric] = state("available") if value is not None else state("not_applicable", reason)
            elif value is not None:
                partial = any(side.get(metric, {}).get("status") == "partial" for side in (a, b))
                evaluations[metric] = state("partial", "unavailable_or_invalid_values") if partial else state("available")
            else:
                candidates = [side.get(metric) for side in (a, b) if side.get(metric, {}).get("status") not in {None, "available"}]
                evaluations[metric] = candidates[0] if candidates else state("not_evaluated", "historical_reason_unavailable")
        comparisons.append({"column": name, "metrics": evaluations})
    quality = result.get("indicators", {}).get("quality", {}).get("overall")
    empty = any(s.get("sample_size") == 0 for s in result.get("sources", []))
    return {"analysis_kind": analysis, "agreement": agreement,
            "quality": indicator_evaluation(quality, "empty_sample" if empty else "no_applicable_checks"),
            "sources": sources, "comparisons": comparisons}
