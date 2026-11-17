import { useLanguage } from "../../i18n/LanguageProvider";
import type { ReactNode } from "react";
import { percent } from "../common";

export const motion = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
export const labels: Record<string, string> = {
  passed: "Passed",
  attention: "Attention",
  critical: "Critical",
  not_calculated: "Not calculated",
  all: "All records",
  equal: "Equal",
  different: "Different",
  only_source: "Only source A",
  only_target: "Only source B",
  unknown: "Not evaluated",
};
export function Status({ value }: { value: string }) {
  const { t: tr } = useLanguage();
  return (
    <span
      className={`badge ${value === "passed" ? "success" : value === "critical" || value === "attention" ? "warning" : "info"}`}
    >
      {tr(labels[value] ?? value)}
    </span>
  );
}
export function Value({ value }: { value: any }) {
  const { t: tr } = useLanguage();
  if (!value) return <span className="muted">{tr("Not captured")}</span>;
  if (value.kind !== "value")
    return (
      <span className="cell-sentinel">
        {(
          {
            null: "NULL",
            missing: tr("Record / column absent"),
            unavailable: tr("Unavailable"),
          } as Record<string, string>
        )[value.kind] ?? value.kind}
      </span>
    );
  const raw =
    typeof value.raw === "string"
      ? value.raw === ""
        ? 'Empty string ("")'
        : value.raw.trim() === ""
          ? `Whitespace (${JSON.stringify(value.raw)})`
          : value.raw
      : JSON.stringify(value.raw);
  return (
    <span className="evidence-value">
      {value.raw === "" ? tr('Empty string ("")') : typeof value.raw === "string" && value.raw.trim() === "" ? tr("Whitespace ({0})", {0: JSON.stringify(value.raw)}) : raw}
      {value.normalized != null && value.normalized !== String(value.raw) && (
        <small className="muted">{tr("Compared as: ")}{value.normalized}</small>
      )}
    </span>
  );
}
export function Explain({
  metric,
  formula,
  description,
  scope,
  tolerances,
}: {
  metric: any;
  formula: string;
  description: string;
  scope?: string;
  tolerances?: any;
}) {
  const { t: tr, locale, formatNumber, reason, decimal } = useLanguage();
  return (
    <details className="metric-explanation">
      <summary>{tr("Calculation details")}</summary>
      {locale === "pt-BR" && <p>{tr("English reference")}: <span lang="en-US">{formula.includes("equal_rows") ? "Row Match Rate" : formula.includes("equal_values") || !metric?.formula && metric?.left_column ? "Column Match Rate" : formula.includes("excess") ? "Duplicate Key Rate" : formula.includes("common keys") ? "Key Coverage" : formula.includes("B − A") ? "Row Count Match" : "Technical Compatibility"}</span></p>}
      <p>{reason(description)}</p>
      <p>
        <code>{tr(formula)}</code>
      </p>
      {metric?.denominator != null && (
        <p>{tr("Numerator: ")}{formatNumber(metric.numerator)} · {tr("denominator:")}{" "}
          {formatNumber(metric.denominator)} · {tr("not evaluated:")} {formatNumber(metric.not_evaluated)}
        </p>
      )}
      <p>{tr("Scope: ")}{reason(scope ?? metric?.scope ?? "sample")}</p>
      <p>{tr("Numeric tolerances: absolute")}{" "}
        {decimal(tolerances?.absolute_tolerance ?? 0)} · {tr("relative")}{" "}
        {decimal(tolerances?.relative_tolerance ?? 0)}{tr(" (fraction). Text remains exact.")}</p>
      <p>{tr("Passed requires complete evaluation without differences or technical impediments. ")}{metric?.reason && reason(metric.reason)}
      </p>
    </details>
  );
}

/** Outcome of one sampled key position, in a fixed order so colors never move. */
export const outcomes = [
  { id: "equal", state: "equal", label: "Equal" },
  { id: "different", state: "different", label: "Different" },
  { id: "only_reference", state: "only_source", label: "Only source A" },
  { id: "only_target", state: "only_target", label: "Only source B" },
  { id: "unknown", state: "unknown", label: "Not evaluated" },
] as const;

export const kindLabels: Record<string, string> = {
  missing_record: "Record missing in one source",
  reference_null: "NULL only in source A",
  target_null: "NULL only in source B",
  whitespace: "Whitespace only",
  letter_case: "Letter case only",
  numeric: "Numeric value",
  temporal: "Date or time value",
  value: "Other value",
};

/** Results published before engine 8 carry no statistics; the five metrics still give the outcomes. */
export function recordOutcomes(result: any): Record<string, number> {
  const saved = result.statistics?.record_outcomes;
  if (saved) return saved;
  const row = result.metrics.row_match_rate,
    keys = result.metrics.key_coverage;
  return {
    equal: row.numerator,
    different: Math.max(0, row.different_rows - row.missing_rows),
    only_reference: keys.missing_in_target,
    only_target: keys.missing_in_reference,
    unknown: row.unknown_rows,
    total: row.total,
  };
}

export function IntervalNote({ interval }: { interval: any }) {
  const { t: tr, locale } = useLanguage();
  if (!interval) return null;
  return (
    <small className="muted quality-interval">
      {interval.method === "complete_scope"
        ? tr("Exact for the scanned scope: the sample holds every key.")
        : tr("95% interval over the key union: {0} – {1}", {
            0: percent(interval.lower, locale),
            1: percent(interval.upper, locale),
          })}
    </small>
  );
}

/** Change in percentage points against the previous successful execution. */
export function Delta({
  current,
  previous,
  lowerIsBetter = false,
}: {
  current: unknown;
  previous: unknown;
  lowerIsBetter?: boolean;
}) {
  const { t: tr, locale } = useLanguage();
  if (current == null || previous == null) return null;
  const change = Number(current) - Number(previous);
  if (!Number.isFinite(change)) return null;
  const text = Math.abs(change).toLocaleString(locale, { maximumFractionDigits: 2 });
  return (
    <span
      className="quality-delta"
      data-trend={!change ? "same" : change > 0 !== lowerIsBetter ? "better" : "worse"}
    >
      {!change
        ? tr("No change since the previous execution")
        : tr(change > 0 ? "▲ {0} pp since the previous execution" : "▼ {0} pp since the previous execution", { 0: text })}
    </span>
  );
}

/** One measure per row; bar length is the share of the largest value. */
export function BarRows({
  rows,
  label,
}: {
  rows: { label: string; value: number; detail?: ReactNode }[];
  label: string;
}) {
  const { formatNumber } = useLanguage();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="quality-bars" role="list" aria-label={label}>
      {rows.map((r) => (
        <div key={r.label} role="listitem">
          <span>{r.label}</span>
          <div className="quality-bar-track">
            <i style={{ width: `${(100 * r.value) / max}%` }} data-empty={!r.value} />
            <strong>{formatNumber(r.value)}</strong>
            {r.detail && <small className="muted">{r.detail}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Two series on one shared scale per row, for A × B and execution × execution. */
export function PairBars({
  rows,
  series,
  label,
}: {
  rows: {
    label: string;
    values: [number | null, number | null];
    text?: [string, string];
    scale?: number;
    note?: ReactNode;
  }[];
  series: [string, string];
  label: string;
}) {
  const { t: tr, formatNumber } = useLanguage();
  return (
    <>
      <div className="overview-chart-legend quality-legend-start">
        {series.map((name, i) => (
          <span key={name}>
            <i className="quality-swatch" data-series={i} />
            {name}
          </span>
        ))}
      </div>
      <div className="quality-bars quality-pairs" role="list" aria-label={label}>
        {rows.map((r) => {
          const scale = r.scale ?? Math.max(1, ...r.values.map((v) => v ?? 0));
          return (
            <div key={r.label} role="listitem">
              <span>
                {r.label}
                {r.note && <small className="muted">{r.note}</small>}
              </span>
              <div>
                {r.values.map((v, i) => (
                  <div className="quality-bar-track" key={i}>
                    <i
                      data-series={i}
                      data-empty={!v}
                      style={{ width: `${v == null ? 0 : (100 * v) / scale}%` }}
                    />
                    <strong>
                      {v == null ? tr("Unavailable") : (r.text?.[i] ?? formatNumber(v))}
                    </strong>
                    <small className="muted">{series[i]}</small>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
