import { errorText } from "../../i18n/errors";
import { useLanguage } from "../../i18n/LanguageProvider";
import type { Model } from "../../api";
import { Badge, Card } from "../common";

export function ExecutionContext({
  quality,
}: {
  quality: Model<"QualityOut">;
}) {
  const { t: tr, locale, decimal } = useLanguage();
  const run = quality.run,
    result: any = quality.result,
    p = run.parameters as any;
  const frozen = result?.comparison_options ?? p.comparison_options ?? {};
  const sample = result?.sampling_plan ?? p.sampling_options ?? {};
  const scope = result?.resolved_scope ?? p.resolved_scope;
  const sources = result?.sources ?? p.sources ?? [];
  const duration =
    run.started_at && run.finished_at
      ? (
          (new Date(run.finished_at).getTime() -
            new Date(run.started_at).getTime()) /
          1000
        ).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " " + tr("seconds")
      : tr("Pending");
  return (
    <Card
      title={tr("Execution information")}
      subtitle={tr("Frozen configuration for the selected execution")}
    >
      <Badge value={run.status} />
      <div className="form-grid comparison-settings">
        <p>
          <strong>{tr("Sources")}</strong>
          <span>
            {sources
              .map(
                (s: any) =>
                  s.table ??
                  [s.catalog_name, s.schema_name, s.table_name]
                    .filter(Boolean)
                    .join("."),
              )
              .join(" ↔ ")}
          </span>
        </p>
        <p>
          <strong>{tr("Date and duration")}</strong>
          <span>
            {new Date(run.requested_at).toLocaleString(locale, {
              timeZone: "America/Sao_Paulo",
            })}{" "}
            · America/Sao_Paulo · {duration}
          </span>
        </p>
        <p>
          <strong>{tr("Comparison key")}</strong>
          <span>
            {(result?.key_validation ?? [])
              .map((k: any) => k.columns.join(" + "))
              .join(" ↔ ") ||
              frozen.business_key
                ?.map((k: any) => `${k.left} ↔ ${k.right}`)
                .join(", ") ||
              tr("Discovered from metadata")}
          </span>
        </p>
        <p>
          <strong>{tr("Data scope")}</strong>
          <span>
            {scope?.period
              ? tr("{0} → {1} (end exclusive)", {0: scope.period.start, 1: scope.period.end})
              : tr("Entire table")}{" "}
            · {scope?.filters?.length ?? 0}{tr(" equivalent filters")}</span>
        </p>
        <p>
          <strong>{tr("Exclusions")}</strong>
          <span>
            A: {frozen.excluded_columns?.left?.join(", ") || tr("None")} · B:{" "}
            {frozen.excluded_columns?.right?.join(", ") || tr("None")}
          </span>
        </p>
        <p>
          <strong>{tr("Timestamp interpretation")}</strong>
          <span>
            {Object.entries(frozen.timestamp_timezones ?? {})
              .flatMap(([side, zones]: any) =>
                Object.entries(zones).map(
                  ([col, zone]) =>
                    `${side === "left" ? "A" : "B"}.${col}: ${zone}`,
                ),
              )
              .join(" · ") || tr("No explicit overrides")}
          </span>
        </p>
        <p>
          <strong>{tr("Numeric tolerances")}</strong>
          <span>{tr("Absolute:")}{" "}
            {decimal(sample.absolute_tolerance ?? p.absolute_tolerance ?? 0)} ·
            {tr("relative fraction:")}{" "}
            {decimal(sample.relative_tolerance ?? p.relative_tolerance ?? 0)}
          </span>
        </p>
        <p>
          <strong>{tr("Sampling strategy")}</strong>
          <span>
            {sample.algorithm ?? tr("Deterministic SHA-256 union selection")} · {tr("seed")}{" "}
            {sample.seed ?? tr("Pending")}
          </span>
        </p>
      </div>
      {run.status === "failed" && (
        <p className="notice warning" role="alert">{tr("Execution incomplete: ")}{run.error_code}. {errorText(run.error_code, run.error_message ?? "", locale)}{tr(" No data-quality score is assigned to this technical failure.")}
          </p>
      )}
      {run.status === "failed" && locale === "pt-BR" && <details><summary>{tr("Technical details")}</summary><p>{run.error_message}</p></details>}
    </Card>
  );
}
