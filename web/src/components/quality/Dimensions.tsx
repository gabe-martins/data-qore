import { useLanguage } from "../../i18n/LanguageProvider";
import type { Model } from "../../api";
import { Card, percent } from "../common";
import { Rate } from "../CriticalMetrics";
import { BarRows, Explain, Status } from "./shared";

const stageLabels: Record<string, string> = {
  metadata: "Metadata and configuration",
  key_validation: "Full-scope counts and key validation",
  key_selection: "Key scan and sample selection",
  record_fetch: "Reading sampled records",
  evaluation: "Record and column evaluation",
  evidence_capture: "Evidence capture",
};

/** Validation status per dimension and what the sample covers. */
export function Dimensions({
  quality,
  dimension,
  setDimension,
}: {
  quality: Model<"QualityOut">;
  dimension: string;
  setDimension: (id: string) => void;
}) {
  const { t: tr, locale, formatNumber, reason } = useLanguage();
  const result: any = quality.result;
  const m = result.metrics,
    row = m.row_match_rate,
    count = m.row_count_match,
    keys = m.key_coverage;
  return (
    <>
    <Card
      title={tr("Quality dimensions")}
      subtitle={tr("Observed indicators and validation status are separate. Lower duplicate and count-difference rates are better.")}
    >
      <div className="quality-dimensions">
        {quality.dimensions.map((d: any) => (
          <div key={d.id} id={`dimension-${d.id}`}>
            <button
              type="button"
              aria-expanded={dimension === d.id}
              onClick={() => setDimension(dimension === d.id ? "" : d.id)}
            >
              <strong>{tr(d.name)}</strong>
              <Status value={d.status} />
            </button>
            {dimension === d.id && (
              <div className="quality-dimension-detail">
                <p>{reason(d.description)}</p>
                {d.measures.map((measure: any) => (
                  <div key={measure.label}>
                    <span>{reason(measure.label)}: </span>
                    <strong>{percent(measure, locale)}</strong>
                    {measure.percentage != null && (
                      <meter
                        aria-label={tr(d.name) + " " + reason(measure.label)}
                        min={0}
                        max={Math.max(100, Number(measure.percentage))}
                        value={Number(measure.percentage)}
                      />
                    )}
                    {measure.denominator != null && d.id !== "volume" && (
                      <Rate
                        value={measure}
                        showValue={false}
                        lowerIsBetter={measure.lower_is_better}
                      />
                    )}
                  </div>
                ))}
                {d.id === "volume" && (
                  <p>{tr("Signed difference B − A: ")}{formatNumber(count.signed_difference)}{tr(". A 0% count difference means equal volumes, not equal records.")}</p>
                )}
                {d.id === "integrity" &&
                  m.duplicate_key_rate.map((item: any) => (
                    <p key={item.source}>{tr("Source ")}{item.source}:{" "}
                      {item.duplicate_groups ?? tr("Unavailable")} {tr("duplicate groups")} · {item.null_key_rows ?? tr("Unavailable")}{tr(" rows with null key components. ")}{item.columns.join(" + ")}
                    </p>
                  ))}
                <Explain
                  metric={d.measures[0]}
                  formula={
                    d.id === "volume"
                      ? "B − A; 100 × |B − A| / A"
                      : d.id === "keys"
                        ? "100 × common keys / keys observed in each source"
                        : d.id === "integrity"
                          ? "100 × excess duplicate rows / rows with non-null key components"
                          : d.id === "consistency"
                            ? row.formula
                            : "Frozen column mapping and type compatibility"
                  }
                  description={reason(d.description)}
                  scope={
                    d.id === "volume" || d.id === "integrity"
                      ? "entire_selected_scope"
                      : "sample"
                  }
                  tolerances={result.sampling_plan}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
    <Card title={tr("Analysis coverage")}>
      <div className="stats-grid">
        <div>
          <strong>
            {formatNumber(count.reference_count)} / {formatNumber(count.target_count)}
          </strong>
          <p>{tr("Scoped population A / B")}</p>
        </div>
        <div>
          <strong>{formatNumber(keys.selected_keys)}</strong>
          <p>{tr("Selected union-key positions")}</p>
        </div>
        <div>
          <strong>
            {result.sampling_plan.percentage_base
              ? percent(
                  (100 * keys.selected_keys) /
                    result.sampling_plan.percentage_base,
                  locale)
              : tr("Not applicable")}
          </strong>
          <p>{tr("Selected positions / larger scoped row count; not a union sampling fraction")}</p>
        </div>
        <div>
          <strong>{percent(row.coverage_percentage, locale)}</strong>
          <p>{tr("Evaluation coverage within selected positions")}</p>
        </div>
      </div>
      <p>{tr("Counts and key integrity cover the entire scope. Key Coverage, Row Match Rate and Column Match Rate describe the selected sample. Intervals bound each rate over the union of keys in scope; they do not cover positions that could not be evaluated.")}</p>
      <details>
        <summary>{tr("Consistency and limitations")}</summary>
        {result.warnings.map((w: string, i: number) => (
          <p key={i}>{reason(w)}</p>
        ))}
      </details>
    </Card>
    </>
  );
}
