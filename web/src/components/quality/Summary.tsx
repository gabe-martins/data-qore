import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageProvider";
import type { Model } from "../../api";
import { Badge, Card, percent } from "../common";
import { Rate } from "../CriticalMetrics";
import { Delta, Explain, IntervalNote } from "./shared";

/** Headline rate, its uncertainty and change, and the four companion metrics. */
export function Summary({
  quality,
  openDimension,
  jump,
}: {
  quality: Model<"QualityOut">;
  openDimension: (id: string) => void;
  jump: (id: string) => void;
}) {
  const { t: tr, locale, formatNumber, formatDateTime } = useLanguage();
  const result: any = quality.result;
  const before: any = quality.previous?.metrics;
  const m = result.metrics,
    row = m.row_match_rate,
    count = m.row_count_match,
    keys = m.key_coverage;
  return (
    <Card
      title={tr("Comparison Quality")}
      subtitle={tr("Indicators and diagnostics for this execution only")}
    >
      <Badge value={result.summary.status} />
      {quality.previous && (
        <p className="muted quality-previous">
          {tr("Changes are measured against the previous successful execution, finished {0}.", {
            0: quality.previous.finished_at
              ? formatDateTime(quality.previous.finished_at, { timeZone: "America/Sao_Paulo" })
              : "—",
          })}{" "}
          <Link to={`?run_id=${quality.previous.run_id}`}>{tr("Open previous execution")}</Link>
        </p>
      )}
      <div className="quality-headline">
        <div>
          <span>{tr("Row Match Rate")}</span>
          <strong>{percent(row.percentage, locale)}</strong>
          <Rate value={row} showValue={false} />
          <IntervalNote interval={result.statistics?.intervals?.row_match_rate} />
          <Delta current={row.percentage} previous={before?.row_match_rate.percentage} />
        </div>
        <div>
          <strong>
            {formatNumber(row.numerator)} {tr("matching")} · {formatNumber(row.different_rows)}{tr(" different")}</strong>
          <p>
            {formatNumber(row.not_evaluated)}{tr(" not evaluated · evaluation coverage")}{" "}
            {percent(row.coverage_percentage, locale)}
          </p>
          <p>{tr("Sample results do not certify equality of entire tables.")}</p>
        </div>
      </div>
      <Explain
        metric={row}
        formula={row.formula}
        description={tr("A record matches only when all included fields match. Missing records count as differences; unknown records without a proven difference are excluded from the denominator.")}
        tolerances={result.sampling_plan}
      />
      {row.not_evaluated > 0 && (
        <p className="notice warning">{tr("Partial evaluation. The rate applies to ")}{formatNumber(row.denominator)}{" "}{tr("evaluated positions, not all ")}{formatNumber(row.total)}{tr(" selected positions.")}</p>
      )}
      {!row.total && (
        <p className="notice warning">{tr("No row positions available for evaluation.")}</p>
      )}
      <div className="quality-indicators">
        <button type="button" onClick={() => openDimension("volume")}>
          <span>{tr("Row Count Match")}</span>
          <strong>{count.equal ? tr("Equal counts") : tr("Different counts")}</strong>
          <small>
            A {formatNumber(count.reference_count)} · B {formatNumber(count.target_count)} ·
            {tr("difference")} {formatNumber(count.absolute_difference)}
          </small>
          <Delta
            current={count.percentage_difference}
            previous={before?.row_count_match.percentage_difference}
            lowerIsBetter
          />
        </button>
        <button type="button" onClick={() => openDimension("keys")}>
          <span>{tr("Key Coverage")}</span>
          <strong>
            {percent(keys.reference_to_target.percentage, locale)} /{" "}
            {percent(keys.target_to_reference.percentage, locale)}
          </strong>
          <small>{tr("A → B / B → A · sample")}</small>
          <Delta
            current={keys.reference_to_target.percentage}
            previous={before?.key_coverage.reference_to_target.percentage}
          />
        </button>
        <button type="button" onClick={() => openDimension("integrity")}>
          <span>{tr("Duplicate Key Rate")}</span>
          <strong>
            {m.duplicate_key_rate.map((d: any) => percent(d, locale)).join(" / ")}
          </strong>
          <small>{tr("A / B · 0% means no excess duplicate rows")}</small>
        </button>
        <button type="button" onClick={() => jump("quality-columns")}>
          <span>{tr("Column Match Rate")}</span>
          <strong>
            {result.columns_requiring_review}{" "}
            {result.columns_requiring_review === 1 ? tr("column") : tr("columns")}{" "}{tr("requiring review")}</strong>
          <small>
            {result.column_count}{tr(" pairs · inspect individual rates")}</small>
        </button>
      </div>
    </Card>
  );
}
