import type { Model } from "../api";
import { Card, percent } from "./common";

type Evaluation = Model<"EvaluationOut">;
type ResultEvaluation = Model<"ResultEvaluationOut">;
const reasons: Record<NonNullable<Evaluation["reason"]>, string> = {
  metric_not_applicable_to_type: "This statistic does not apply to the declared column type.",
  empty_sample: "No rows were obtained in this sample.",
  all_values_null: "All sampled values are NULL; no non-null values are available for this statistic.",
  capture_unavailable: "Some values could not be captured within the supported limits.",
  unsupported_type_or_values: "The declared type or captured values are not supported for this evaluation.",
  non_finite_values: "Non-finite numeric values prevent a complete evaluation.",
  calculation_unavailable: "The statistic could not be calculated with the supported precision.",
  historical_reason_unavailable: "Reason unavailable in this historical result",
  incomplete_evaluation: "Some required positions could not be evaluated. Review coverage and column findings.",
  no_applicable_checks: "No applicable quality checks were evaluated. This is not an approval.",
  single_source_profile: "A single-source profile does not compare records between sources.",
  invalid_key: "The selected key is invalid or became unavailable. Review the full-scope key diagnostics below; record agreement was not evaluated.",
  no_aligned_records: "No aligned records could be evaluated.",
  independent_sampling: "Independent sampling was selected. These statistics do not establish record correspondence.",
  no_safe_key_alignment: "No safe comparison key was available. Independent profiles do not establish record correspondence.",
  column_missing: "There is no corresponding column in the other source.",
  incompatible_type_families: "The declared column types are incompatible; values are not automatically converted.",
  unavailable_or_invalid_values: "Only supported, available values contributed to this statistic; evaluation is incomplete.",
};
export function evaluationReason(evaluation?: Evaluation | null) {
  return reasons[evaluation?.reason ?? "historical_reason_unavailable"] ?? reasons.historical_reason_unavailable;
}
export function EvaluationValue({ value, evaluation, rate = false }: {
  value: unknown; evaluation?: Evaluation | null; rate?: boolean;
}) {
  if (value !== null && value !== undefined) return <>
    {rate ? percent(String(Number(value) * 100)) : String(value)}
    {evaluation?.status === "partial" && <small className="muted"> · Partial — {evaluationReason(evaluation)}</small>}
  </>;
  return <span>{evaluation?.status === "not_applicable" ? "Not applicable" : "Not evaluated"}
    <small className="muted" style={{ display: "block" }}>{evaluationReason(evaluation)}</small>
  </span>;
}
export function AnalysisNotice({ evaluation }: { evaluation?: ResultEvaluation | null }) {
  if (!evaluation) return <p className="notice">Reason unavailable in this historical result</p>;
  const titles = { profile: "Single-source profile", aligned: "Aligned sample comparison",
    independent: "Independent source profiles", invalid_key: "Invalid key — inconclusive", unknown: "Historical analysis" };
  return <div className="notice"><strong>{titles[evaluation.analysis_kind]}</strong>
    <p>{evaluation.agreement.status === "available"
      ? "Record correspondence was established within the selected sample. This does not prove equality of entire tables."
      : evaluationReason(evaluation.agreement)}</p>
  </div>;
}
export function ColumnStatistics({ metrics, evaluation }: {
  metrics: Record<string, any>; evaluation?: Record<string, Evaluation>;
}) {
  const m = metrics;
  const numeric = ["integer", "decimal", "float"].includes(m.family);
  const fields = ["sample_count", "null_count", "null_rate", "non_null_count", "distinct_count", "distinct_rate", "duplicate_count", "duplicate_rate",
    ...(m.family === "text" ? ["blank_count", "blank_rate", "text_length_min", "text_length_max", "text_length_mean"] : []),
    ...(numeric ? ["min", "max", "mean", "median", "stddev", "q25", "q75"] : []),
    ...(["date", "datetime", "time"].includes(m.family) ? ["temporal_count", "temporal_min", "temporal_max"] : []),
    ...["unavailable_count", "unsupported_count"].filter(k => m[k] !== undefined)];
  return <>
    <p className="muted small">Declared type: {m.type ?? m.family ?? "Unavailable"} · Observed sample statistics</p>
    {m.sample_count > 0 && m.null_count === m.sample_count && <p className="notice">
      {m.null_count.toLocaleString("en-US")} of {m.sample_count.toLocaleString("en-US")} sampled values are NULL (100%).
    </p>}
    <dl className="profile-statistics">{fields.map(k => <div key={k}><dt>{k.replaceAll("_", " ")}</dt>
      <dd><EvaluationValue value={m[k]} evaluation={evaluation?.[k]} rate={k.endsWith("_rate")} /></dd></div>)}</dl>
    {m.family === "text" && <p className="muted small">Declared as text. Numeric mean, median and numeric distribution do not apply; values are not automatically converted.</p>}
  </>;
}
export function SourceProfiles({ result, evaluation }: { result: any; evaluation?: ResultEvaluation | null }) {
  return <Card title="Observed column statistics" subtitle="Descriptive evidence from each source. Statistics use declared types and do not establish record equality.">
    {(result.sources ?? []).map((source: any, index: number) => <section key={index}>
      <h3>Source {index + 1}: {source.connection} · {source.table}</h3>
      <p>{source.sample_size ?? "Unavailable"} sampled rows</p>
      <div className="profile-grid">{Object.entries(source.metrics ?? {}).map(([column, metrics]) =>
        <details className="column-profile" key={column}><summary>{column}</summary>
          <ColumnStatistics metrics={metrics as Record<string, any>} evaluation={evaluation?.sources[index]?.columns[column]} />
        </details>)}</div>
    </section>)}
  </Card>;
}
