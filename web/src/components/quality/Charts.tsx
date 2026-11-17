import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLanguage } from "../../i18n/LanguageProvider";
import { api, type Model, type Page } from "../../api";
import { Card, Empty, ErrorBox, Loading, percent } from "../common";
import { BarRows, PairBars, kindLabels, outcomes, recordOutcomes } from "./shared";

type Inspect = (state?: string, column?: string) => void;
const views = [
  { id: "records", name: "Record outcomes" },
  { id: "sources", name: "Source A × B" },
  { id: "columns", name: "Columns" },
  { id: "differences", name: "Difference types" },
  { id: "previous", name: "Previous execution" },
] as const;
type View = (typeof views)[number]["id"];
const share = (part: number, total: number) => (total ? (100 * part) / total : 0);

/** One bar for the whole sample: where every selected key position ended up. */
function RecordOutcomes({
  result,
  captured,
  inspect,
}: {
  result: any;
  captured: boolean;
  inspect: Inspect;
}) {
  const { t: tr, locale, formatNumber } = useLanguage();
  const counts = recordOutcomes(result);
  if (!counts.total)
    return <Empty title={tr("No row positions available for evaluation.")}>{tr("The key sample is empty or could not be aligned.")}</Empty>;
  return (
    <>
      <p className="muted">
        {tr("{0} selected key positions. Each position has exactly one outcome.", { 0: formatNumber(counts.total) })}{" "}
        {captured && tr("Select an outcome to inspect its records.")}
      </p>
      <div className="quality-outcomes" role="img" aria-label={tr("Record outcomes")}>
        {outcomes
          .filter((o) => counts[o.id] > 0)
          .map((o) => (
            <i
              key={o.id}
              data-outcome={o.id}
              style={{ flexGrow: counts[o.id] }}
              title={`${tr(o.label)}: ${formatNumber(counts[o.id])}`}
            />
          ))}
      </div>
      <div className="quality-outcome-legend">
        {outcomes.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={!captured || !counts[o.id]}
            onClick={() => inspect(o.state)}
          >
            <i data-outcome={o.id} />
            <span>{tr(o.label)}</span>
            <strong>{formatNumber(counts[o.id])}</strong>
            <small className="muted">{percent(share(counts[o.id], counts.total), locale)}</small>
          </button>
        ))}
      </div>
    </>
  );
}

/** The same measure for each source, side by side on one scale per row. */
function Sources({ result }: { result: any }) {
  const { t: tr, formatNumber } = useLanguage();
  const m = result.metrics,
    count = m.row_count_match,
    keys = m.key_coverage,
    validation = result.key_validation;
  // One scale per scope, so a handful of rows never draws as a full bar.
  const scoped = Math.max(1, count.reference_count, count.target_count),
    sampled = Math.max(1, keys.selected_keys);
  const signed = (a: number | null, b: number | null) =>
    a == null || b == null
      ? null
      : `B − A: ${b - a > 0 ? "+" : ""}${formatNumber(b - a)}`;
  const rows = [
    {
      label: tr("Rows in scope"),
      values: [count.reference_count, count.target_count],
    },
    {
      label: tr("Sampled keys found"),
      values: [keys.reference_to_target.denominator, keys.target_to_reference.denominator],
      scale: sampled,
    },
    {
      label: tr("Sampled keys missing"),
      values: [keys.missing_in_reference, keys.missing_in_target],
      scale: sampled,
    },
    {
      label: tr("Rows with null key components"),
      values: validation.map((v: any) => v.null_key_rows),
    },
    {
      label: tr("Duplicate key groups"),
      values: validation.map((v: any) => v.duplicate_groups),
    },
    {
      label: tr("Excess duplicate rows"),
      values: validation.map((v: any) => v.duplicate_excess_rows),
    },
  ].map((r) => ({
    scale: scoped,
    ...r,
    values: [r.values[0] ?? null, r.values[1] ?? null] as [number | null, number | null],
    note: signed(r.values[0] ?? null, r.values[1] ?? null),
  }));
  return (
    <>
      <p className="muted">
        {tr("Rows and key integrity cover the entire scope and share its scale; sampled keys are scaled to the {0} selected positions.", { 0: formatNumber(keys.selected_keys) })}
      </p>
      <PairBars
        label={tr("Source A × B")}
        series={[tr("Source A"), tr("Source B")]}
        rows={rows}
      />
    </>
  );
}

/** Column pairs that most need review, as shares of the selected positions. */
function Columns({
  runId,
  result,
  captured,
  inspect,
}: {
  runId: string;
  result: any;
  captured: boolean;
  inspect: Inspect;
}) {
  const { t: tr, locale, formatNumber } = useLanguage();
  const q = useQuery({
    queryKey: ["quality-column-chart", runId],
    queryFn: () =>
      api<Page<Model<"QualityColumnOut">>>(
        `/runs/${runId}/quality/columns?limit=12&sort=differences`,
      ),
  });
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isPending) return <Loading />;
  const data = q.data.items.map((c: any) => {
    const total = c.metric.total;
    return {
      id: c.id,
      name: c.left_column === c.right_column || !c.right_column || !c.left_column
        ? (c.left_column ?? c.right_column)
        : `${c.left_column} ↔ ${c.right_column}`,
      equal: share(c.metric.numerator, total),
      different: share(c.metric.different_values, total),
      unknown: share(c.metric.not_evaluated, total),
      column: c,
    };
  });
  if (!data.length) return <Empty title={tr("No columns match these filters")} />;
  const series = [
    { key: "equal", label: "Equal", fill: "var(--semantic-chart-series-1)" },
    { key: "different", label: "Different", fill: "var(--semantic-chart-series-3)" },
    { key: "unknown", label: "Not evaluated", fill: "url(#quality-hatch)" },
  ];
  return (
    <>
      <p className="muted">
        {tr("{0} of {1} column pairs with the most differences or unevaluated values, as shares of the selected positions.", {
          0: formatNumber(data.length),
          1: formatNumber(result.column_count),
        })}{" "}
        {captured && tr("Select a bar to inspect that column's records.")}
      </p>
      <div
        className="overview-chart"
        style={{ height: 56 + data.length * 34 }}
        role="img"
        aria-label={tr("Column Match Rate")}
      >
        <ResponsiveContainer>
          <BarChart
            data={data}
            layout="vertical"
            barSize={16}
            margin={{ top: 4, right: 20, left: 0, bottom: 4 }}
          >
            <defs>
              <pattern id="quality-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--semantic-background-subtle)" />
                <rect width="2" height="6" fill="var(--semantic-chart-series-5)" />
              </pattern>
            </defs>
            <CartesianGrid horizontal={false} stroke="var(--semantic-border-default)" />
            <XAxis
              type="number"
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v) => percent(v, locale)}
              tick={{ fontSize: 12 }}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={170}
              tick={{ fontSize: 12 }}
              tickFormatter={(v: string) => (v.length > 24 ? v.slice(0, 23) + "…" : v)}
            />
            <Tooltip
              cursor={{ fill: "var(--semantic-background-subtle)" }}
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null;
                const c = payload[0].payload.column,
                  interval = c.statistics?.interval;
                return (
                  <div className="overview-tooltip">
                    <strong>{payload[0].payload.name}</strong>
                    <div>
                      <span>
                        {tr("Match rate")}: <strong>{percent(c.metric, locale)}</strong>
                      </span>
                      <small>
                        {formatNumber(c.metric.numerator)} {tr("Equal")} · {formatNumber(c.metric.different_values)}{" "}
                        {tr("Different")} · {formatNumber(c.metric.not_evaluated)} {tr("Not evaluated")}
                      </small>
                      {interval?.method === "wilson" && (
                        <small>
                          {tr("95% interval over the key union: {0} – {1}", {
                            0: percent(interval.lower, locale),
                            1: percent(interval.upper, locale),
                          })}
                        </small>
                      )}
                    </div>
                  </div>
                );
              }}
            />
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="positions"
                fill={s.fill}
                stroke="var(--semantic-background-surface)"
                strokeWidth={2}
                isAnimationActive={false}
                cursor={captured ? "pointer" : undefined}
                onClick={(bar: any) => captured && inspect("all", bar.payload?.id ?? bar.id)}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="overview-chart-legend">
        {outcomes
          .filter((o) => series.some((s) => s.key === o.id))
          .map((o) => (
            <span key={o.id}>
              <i className="quality-swatch" data-outcome={o.id} />
              {tr(o.label)}
            </span>
          ))}
      </div>
    </>
  );
}

/** What kind of difference was proven, and how many columns differ per record. */
function Differences({ result }: { result: any }) {
  const { t: tr } = useLanguage();
  const statistics = result.statistics;
  if (!statistics)
    return (
      <Empty title={tr("Not available for this execution")}>
        {tr("Difference types are recorded by executions published from engine version 8. Run the comparison again to obtain them.")}
      </Empty>
    );
  const kinds = Object.entries<number>(statistics.difference_kinds)
    .map(([kind, value]) => ({ label: tr(kindLabels[kind] ?? kind), value }))
    .sort((a, b) => b.value - a.value);
  const histogram = statistics.differing_columns_per_record.map((h: any) => ({
    label: tr(h.columns === 1 ? "{0} column" : "{0} columns", { 0: h.columns }),
    value: h.records,
  }));
  if (!kinds.some((k) => k.value) && !histogram.length)
    return <Empty title={tr("No differing values in paired records")}>{tr("Records present in both sources have no proven value difference.")}</Empty>;
  return (
    <div className="quality-split">
      <div>
        <h3>{tr("Differing values by type")}</h3>
        <p className="muted">{tr("Values in records present in both sources, across all column pairs.")}</p>
        <BarRows label={tr("Differing values by type")} rows={kinds} />
      </div>
      <div>
        <h3>{tr("Differing columns per record")}</h3>
        <p className="muted">{tr("Paired records with at least one proven difference.")}</p>
        <BarRows label={tr("Differing columns per record")} rows={histogram} />
      </div>
    </div>
  );
}

/** This execution beside the previous successful one, rates on a 0–100% scale. */
function Previous({ quality }: { quality: Model<"QualityOut"> }) {
  const { t: tr, locale, formatDateTime } = useLanguage();
  const now: any = quality.result!.metrics,
    before: any = quality.previous?.metrics;
  if (!quality.previous || !before)
    return (
      <Empty title={tr("No previous execution")}>
        {tr("This is the first successful execution of this comparison.")}
      </Empty>
    );
  const pick = (m: any) => [
    ["Row Match Rate", m.row_match_rate.percentage],
    ["Key Coverage A → B", m.key_coverage.reference_to_target.percentage],
    ["Key Coverage B → A", m.key_coverage.target_to_reference.percentage],
    ["Row count difference / A", m.row_count_match.percentage_difference],
    ["Duplicate Key Rate A", m.duplicate_key_rate[0]?.percentage],
    ["Duplicate Key Rate B", m.duplicate_key_rate[1]?.percentage],
  ];
  const previous = pick(before);
  const rows = pick(now).map(([label, value], i) => {
    const old = previous[i][1];
    const numbers = [value, old].map((v) => (v == null ? null : Number(v))) as [number | null, number | null];
    const change = numbers[0] == null || numbers[1] == null ? null : numbers[0] - numbers[1];
    return {
      label: tr(label),
      values: numbers,
      text: [percent(value, locale), percent(old, locale)] as [string, string],
      scale: Math.max(100, numbers[0] ?? 0, numbers[1] ?? 0),
      note:
        change == null
          ? null
          : !change
            ? tr("No change")
            : `${change > 0 ? "+" : "−"}${Math.abs(change).toLocaleString(locale, { maximumFractionDigits: 2 })} pp`,
    };
  });
  return (
    <>
      <p className="muted">
        {tr("Previous successful execution finished {0}.", {
          0: quality.previous.finished_at
            ? formatDateTime(quality.previous.finished_at, { timeZone: "America/Sao_Paulo" })
            : "—",
        })}{" "}
        <Link to={`?run_id=${quality.previous.run_id}`}>{tr("Open previous execution")}</Link>
      </p>
      <PairBars
        label={tr("Previous execution")}
        series={[tr("This execution"), tr("Previous execution")]}
        rows={rows}
      />
    </>
  );
}

export function Charts({
  quality,
  captured,
  inspect,
}: {
  quality: Model<"QualityOut">;
  captured: boolean;
  inspect: Inspect;
}) {
  const { t: tr } = useLanguage();
  const [view, setView] = useState<View>("records");
  const result: any = quality.result;
  return (
    <Card
      title={tr("Comparative charts")}
      subtitle={tr("The same saved result from different angles; no new source queries are made")}
    >
      <div className="overview-metric-tabs" role="group" aria-label={tr("Chart view")}>
        {views.map((v) => (
          <button key={v.id} type="button" aria-pressed={v.id === view} onClick={() => setView(v.id)}>
            {tr(v.name)}
          </button>
        ))}
      </div>
      <div className="quality-chart-view">
        {view === "records" && <RecordOutcomes result={result} captured={captured} inspect={inspect} />}
        {view === "sources" && <Sources result={result} />}
        {view === "columns" && (
          <Columns runId={quality.run.id} result={result} captured={captured} inspect={inspect} />
        )}
        {view === "differences" && <Differences result={result} />}
        {view === "previous" && <Previous quality={quality} />}
      </div>
    </Card>
  );
}
