import { useLanguage } from "../i18n/LanguageProvider";
import { Allowed } from "../lib/access";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Target, TrendingUp } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { api, type Model } from "../api";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  PageTitle,
  percent,
  Stat,
} from "../components/common";
import { targetState } from "../lib/qualityTarget";

type Comparison = Model<"OverviewComparisonOut">;
type Metric =
  | "row_match_rate"
  | "row_count_match"
  | "key_coverage"
  | "duplicate_key_rate"
  | "column_match_rate";
const metrics: { id: Metric; name: string; description: string }[] = [
  {
    id: "row_match_rate",
    name: "Row Match Rate",
    description:
      "Equal records / evaluated positions in the selected sample. Higher is better.",
  },
  {
    id: "key_coverage",
    name: "Key Coverage",
    description:
      "Common keys / observed keys in each direction of the selected sample. Higher is better.",
  },
  {
    id: "duplicate_key_rate",
    name: "Duplicate Key Rate",
    description:
      "Excess duplicate rows / non-null-key rows, across the entire scoped data. Lower is better.",
  },
  {
    id: "row_count_match",
    name: "Row Count Match",
    description:
      "Absolute difference / source A count, across the entire scoped data. Lower is better; this rate can exceed 100%.",
  },
  {
    id: "column_match_rate",
    name: "Column Match Rate",
    description:
      "Equal values / evaluated positions for one frozen column pair. Higher is better. No combined cell score.",
  },
];
const colors = [
  "var(--semantic-chart-series-1)",
  "var(--semantic-chart-series-2)",
];
function TargetBadge({
  rate,
  target,
}: {
  rate:
    | {
        percentage?: unknown;
        numerator?: number;
        denominator?: number;
        not_evaluated?: number;
      }
    | null
    | undefined;
  target: string | null | undefined;
}) {
  const { t: tr } = useLanguage();
  const status = targetState(rate, target);
  return (
    <span className="target-status" data-state={status.state}>
      {tr(status.label)}
    </span>
  );
}
function MiniTrend({ points }: { points: Comparison["points"] }) {
  const { t: tr } = useLanguage();
  const available = points.some((p) => p.percentage != null);
  if (!available) return <span className="muted">{tr("No evaluations")}</span>;
  return (
    <div
      className="overview-spark"
      role="img"
      aria-label={tr("Daily Row Match Rate; days without an evaluation remain gaps")}
    >
      <ResponsiveContainer>
        <LineChart
          data={points.map((p) => ({
            ...p,
            value: p.percentage == null ? null : Number(p.percentage),
          }))}
        >
          <YAxis hide domain={[0, 100]} />
          <Line
            dataKey="value"
            stroke={colors[0]}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
function TrendChart({
  comparison,
  days,
  target,
}: {
  comparison: Comparison;
  days: number;
  target: string | null | undefined;
}) {
  const { t: tr, locale, formatNumber, reason } = useLanguage();
  const [metric, setMetric] = useState<Metric>("row_match_rate"),
    [column, setColumn] = useState("");
  const pairs = comparison.column_pairs;
  const selectedPair =
    pairs.find(
      (p) => JSON.stringify([p.left_column, p.right_column]) === column,
    ) ?? pairs[0];
  const params = new URLSearchParams({
    comparison_id: comparison.comparison_id,
    metric,
    days: String(days),
    timezone: "America/Sao_Paulo",
  });
  if (metric === "column_match_rate" && selectedPair) {
    if (selectedPair.left_column != null)
      params.set("left_column", selectedPair.left_column);
    if (selectedPair.right_column != null)
      params.set("right_column", selectedPair.right_column);
  }
  const q = useQuery({
    queryKey: ["overview-metric-trend", params.toString()],
    queryFn: () =>
      api<Model<"MetricTrendOut">>(`/overview/metric-trend?${params}`),
    refetchInterval: 30000,
    enabled: metric !== "column_match_rate" || !!selectedPair,
  });
  const labels = [
    ...new Set(
      q.data?.points.flatMap((p) => p.values.map((v) => v.label)) ?? [],
    ),
  ];
  const data =
    q.data?.points.map((p) => ({
      ...p,
      ...Object.fromEntries(
        labels.map((label, i) => {
          const value = p.values.find((v) => v.label === label);
          return [
            `series_${i}`,
            value?.percentage == null ? null : Number(value.percentage),
          ];
        }),
      ),
    })) ?? [];
  const hasData = data.some((p) =>
    labels.some((_, i) => p[`series_${i}` as keyof typeof p] != null),
  );
  const chartLabel = (label: string) => metric === "column_match_rate"
    ? `${selectedPair?.left_column ?? tr("Unpaired")} → ${selectedPair?.right_column ?? tr("Unpaired")}`
    : reason(label);
  const lower = metric === "duplicate_key_rate" || metric === "row_count_match";
  return (
    <>
      <div
        className="overview-metric-tabs"
        role="group"
        aria-label={tr("Chart metric")}
      >
        {metrics.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={m.id === metric}
            onClick={() => setMetric(m.id)}
          >
            {tr(m.name)}
          </button>
        ))}
      </div>
      <div className="overview-chart-caption">
        <p className="muted">
          {tr(metrics.find((m) => m.id === metric)!.description)}
          {locale === "pt-BR" && <small>{tr("English reference")}: <span lang="en-US">{metrics.find(m => m.id === metric)!.name}</span></small>}
        </p>
        {lower && (
          <span className="target-status" data-state="neutral">{tr("Lower is better")}</span>
        )}
      </div>
      {metric === "column_match_rate" && (
        <label>{tr("Column pair")}<select
            aria-label={tr("Column pair")}
            value={
              selectedPair
                ? JSON.stringify([
                    selectedPair.left_column,
                    selectedPair.right_column,
                  ])
                : ""
            }
            onChange={(e) => setColumn(e.target.value)}
          >
            {pairs.map((p) => (
              <option
                key={JSON.stringify([p.left_column, p.right_column])}
                value={JSON.stringify([p.left_column, p.right_column])}
              >
                {p.left_column ?? tr("Unpaired")} → {p.right_column ?? tr("Unpaired")}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorBox error={q.error} />
      {q.isPending && q.fetchStatus !== "idle" ? (
        <Loading />
      ) : hasData ? (
        <>
          <div
            className="overview-chart"
            role="img"
            aria-label={tr("{0} by day for {1}", {0: tr(metrics.find((m) => m.id === metric)!.name), 1: comparison.name})}
          >
            <ResponsiveContainer>
              <LineChart
                data={data}
                margin={{ top: 18, right: 20, left: 0, bottom: 4 }}
              >
                <CartesianGrid
                  strokeDasharray="3 5"
                  stroke="var(--semantic-border-default)"
                />
                <XAxis
                  dataKey="day"
                  tickFormatter={(v) => locale === "pt-BR" ? String(v).slice(5).split("-").reverse().join("/") : String(v).slice(5)}
                  tick={{ fontSize: 12 }}
                  minTickGap={24}
                />
                <YAxis
                  domain={
                    metric === "row_count_match"
                      ? [0, (max: number) => Math.max(100, max)]
                      : [0, 100]
                  }
                  tickFormatter={(v) => percent(v, locale)}
                  tick={{ fontSize: 12 }}
                  width={58}
                />
                <Tooltip
                  content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    const point = q.data?.points.find((p) => p.day === label);
                    return (
                      <div className="overview-tooltip">
                        <strong>{locale === "pt-BR" && /^\d{4}-\d{2}-\d{2}$/.test(String(label)) ? String(label).split("-").reverse().join("/") : label}</strong>
                        {point?.values.map((v) => (
                          <div key={chartLabel(v.label)}>
                            <span>
                              {chartLabel(v.label)}:{" "}
                              <strong>{percent(v.percentage, locale)}</strong>
                            </span>
                            <small>
                              {formatNumber(v.numerator)} / {formatNumber(v.denominator)}
                              {metric === "row_count_match"
                                ? tr(" · difference / source A")
                                : tr(" evaluated")}{" "}
                              · {formatNumber(v.not_evaluated)}{tr(" not evaluated")}</small>
                            <small>
                              {reason(v.scope)}
                              {v.reason
                                ? ` · ${reason(v.reason)}`
                                : ""}
                            </small>
                          </div>
                        ))}
                      </div>
                    );
                  }}
                />
                {metric === "row_match_rate" && target != null && (
                  <ReferenceLine
                    y={Number(target)}
                    stroke="var(--semantic-text-secondary)"
                    strokeDasharray="6 4"
                    label={{
                      value: tr("Target {0}", {0: percent(target, locale)}),
                      position: "insideBottomRight",
                      fill: "var(--semantic-text-secondary)",
                      fontSize: 12,
                    }}
                  />
                )}
                {labels.map((label, i) => (
                  <Line
                    key={label}
                    type="linear"
                    dataKey={`series_${i}`}
                    name={chartLabel(label)}
                    stroke={colors[i % colors.length]}
                    strokeWidth={2.5}
                    dot={{ r: 4, strokeWidth: 2 }}
                    activeDot={{ r: 6 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="overview-chart-legend">
            {labels.map((label, i) => (
              <span key={label}>
                <i style={{ background: colors[i % colors.length] }} />
                {chartLabel(label)}
              </span>
            ))}
            {metric === "row_match_rate" && target != null && (
              <span className="muted">{tr("Dashed line: current target ")}{percent(target, locale)}
              </span>
            )}
          </div>
        </>
      ) : (
        <Empty title={tr("No evaluated points in this period")}>{tr("Choose another metric, comparison or period. Missing evaluations are never plotted as zero.")}</Empty>
      )}
      <details className="overview-daily">
        <summary>{tr("Daily values and denominators")}</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{tr("Day")}</th>
                <th>{tr("Execution")}</th>
                <th>{tr("Direction / pair")}</th>
                <th>{tr("Rate")}</th>
                <th>{tr("Numerator / denominator")}</th>
                <th>{tr("Not evaluated")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.points.flatMap((p) =>
                p.values.length
                  ? p.values.map((v) => (
                      <tr key={p.day + v.label}>
                        <td>{locale === "pt-BR" ? p.day.split("-").reverse().join("/") : p.day}</td>
                        <td>
                          <Link
                            to={`/comparisons/${comparison.comparison_id}?run_id=${p.run_id}`}
                          >
                            <Badge value={p.status} />
                          </Link>
                        </td>
                        <td>{chartLabel(v.label)}</td>
                        <td>{percent(v.percentage, locale)}</td>
                        <td>
                          {formatNumber(v.numerator)} / {formatNumber(v.denominator)}
                        </td>
                        <td>{formatNumber(v.not_evaluated)}</td>
                      </tr>
                    ))
                  : [
                      <tr key={locale === "pt-BR" ? p.day.split("-").reverse().join("/") : p.day}>
                        <td>{locale === "pt-BR" ? p.day.split("-").reverse().join("/") : p.day}</td>
                        <td>{p.status ?? tr("No execution")}</td>
                        <td colSpan={4}>{tr("Not evaluated")}</td>
                      </tr>,
                    ],
              )}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
export function Overview() {
  const { t: tr, locale, formatNumber } = useLanguage();
  const [days, setDays] = useState(7),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState("");
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Model<"OverviewOut">>("/overview"),
    refetchInterval: 30000,
  });
  const settings = useQuery({
    queryKey: ["quality-settings"],
    queryFn: () => api<Model<"QualitySettingsOut">>("/settings/quality"),
    refetchInterval: 30000,
  });
  const params = new URLSearchParams({
    days: String(days),
    limit: "25",
    offset: String(offset),
    search,
    timezone: "America/Sao_Paulo",
  });
  const comparisons = useQuery({
    queryKey: ["overview-comparisons", params.toString()],
    queryFn: () =>
      api<Model<"OverviewComparisonsOut">>(`/overview/comparisons?${params}`),
    refetchInterval: 30000,
  });
  const d = overview.data,
    target = settings.data?.row_match_target_percentage,
    items = comparisons.data?.items ?? [],
    current = items.find((c) => c.comparison_id === selected) ?? items[0];
  const globalRate = d
    ? {
        percentage: d.row_match_rate.percentage,
        numerator: d.row_match_rate.passed,
        denominator: d.row_match_rate.evaluated,
        not_evaluated:
          d.row_match_rate.total -
          d.row_match_rate.evaluated +
          (d.active_comparisons - d.evaluated_comparisons),
      }
    : null;
  return (
    <>
      <PageTitle
        title={tr("Overview")}
        eyebrow="COMPARISON HEALTH"
        subtitle={tr("Track daily quality, investigate changes and follow your Row Match Rate target.")}
        action={
          <Allowed permission="comparisons.manage">
            <Button asChild>
              <Link to="/comparisons/new">{"New comparison"}</Link>
            </Button>
          </Allowed>
        }
      />
      <ErrorBox error={overview.error || comparisons.error || settings.error} />
      {overview.isPending ? (
        <Loading />
      ) : (
        d && (
          <div className="stats-grid four overview-stats">
            <Stat
              label={tr("Row Match Rate")}
              value={percent(d.row_match_rate.percentage, locale)}
              detail={tr("{0} / {1} evaluated · {2} coverage", {0: formatNumber(d.row_match_rate.passed), 1: formatNumber(d.row_match_rate.evaluated), 2: percent(d.row_match_rate.coverage_percentage, locale)})}
            />
            <Card className="overview-target">
              <div className="overview-stat-label">
                <Target size={17} />{tr("Quality target")}</div>
              <strong className="overview-target-value">
                {settings.isPending
                  ? tr("Loading…")
                  : settings.isError
                    ? tr("Unavailable")
                    : target == null
                      ? tr("Disabled")
                      : percent(target, locale)}
              </strong>
              {!settings.isPending && !settings.isError && (
                <TargetBadge rate={globalRate} target={target} />
              )}
              <Link to="/settings/quality">
                {settings.isPending
                  ? tr("Quality settings")
                  : tr("View target settings")}
                <ArrowUpRight size={14} />
              </Link>
            </Card>
            <Stat
              label={tr("Active comparisons")}
              value={d.active_comparisons}
              detail={tr("{0} with an evaluated latest result", {0: d.evaluated_comparisons})}
            />
            <Stat
              label={tr("Requires investigation")}
              value={
                (d.latest_conclusions.difference_observed ?? 0) +
                (d.latest_conclusions.inconclusive ?? 0) +
                (d.latest_conclusions.failed ?? 0)
              }
              detail={tr("{0} differences · {1} inconclusive · {2} failed", {0: d.latest_conclusions.difference_observed ?? 0, 1: d.latest_conclusions.inconclusive ?? 0, 2: d.latest_conclusions.failed ?? 0})}
            />
          </div>
        )
      )}
      <Card className="overview-evolution">
        <div className="overview-section-heading">
          <div>
            <div className="overview-stat-label">
              <TrendingUp size={17} />{tr("DAILY EVOLUTION")}</div>
            <h2>{tr("Comparison quality over time")}</h2>
            <p className="muted">{tr("Last terminal execution per day · America/Sao_Paulo · today is partial")}</p>
          </div>
          <div className="overview-controls">
            <label>{tr("Comparison")}<select
                aria-label={tr("Comparison")}
                value={current?.comparison_id ?? ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option disabled value="">{tr("Select a comparison")}</option>
                {items.map((c) => (
                  <option key={c.comparison_id} value={c.comparison_id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>{tr("Period")}<select
                aria-label={tr("Period")}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[7, 15, 30].map((n) => (
                  <option key={n} value={n}>
                    {n}{tr(" days")}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {comparisons.isPending ? (
          <Loading />
        ) : current ? (
          <TrendChart
            key={current.comparison_id}
            comparison={current}
            days={days}
            target={settings.isError ? null : target}
          />
        ) : (
          <Empty title={tr("No comparisons to display")}>{tr("Existing active comparisons and their recorded history appear here.")}</Empty>
        )}
        <p className="overview-footnote">{tr("Rates use saved executions only. Days without an evaluation and failed executions remain gaps. The target line shows the current setting, not historical targets. A sample does not prove equality of entire tables.")}</p>
      </Card>
      <Card className="overview-comparisons">
        <div className="overview-section-heading">
          <div>
            <h2>{tr("Comparisons at a glance")}</h2>
            <p className="muted">{tr("Latest terminal result per active comparison. Target attainment is separate from the analytical conclusion.")}</p>
          </div>
          <label>{tr("Search comparisons")}<input
              type="search"
              value={search}
              maxLength={255}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder={tr("Search by name…")}
            />
          </label>
        </div>
        {comparisons.isPending ? (
          <Loading />
        ) : items.length ? (
          <div className="table-scroll">
            <table className="overview-quality-table">
              <thead>
                <tr>
                  <th>{tr("Comparison")}</th>
                  <th>{tr("Row Match Rate")}</th>
                  <th>{tr("Daily curve")}</th>
                  <th>{tr("Key Coverage")}<br />
                    <small>A → B / B → A</small>
                  </th>
                  <th>{tr("Duplicate Key Rate")}<br />
                    <small>{tr("A / B · lower is better")}</small>
                  </th>
                  <th>{tr("Row Count Match")}</th>
                  <th>{tr("Column Match Rate")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => {
                  const m = c.metrics,
                    rate = m?.row_match_rate,
                    columns = m?.column_match_rate ?? [],
                    review = columns.filter(
                      (x) =>
                        x.different_values || x.not_evaluated || !x.denominator,
                    ).length;
                  return (
                    <tr
                      key={c.comparison_id}
                      data-selected={c.comparison_id === current?.comparison_id}
                    >
                      <td>
                        <Link
                          className="overview-comparison-name"
                          to={`/comparisons/${c.comparison_id}${c.run_id ? `?run_id=${c.run_id}` : ""}`}
                        >
                          {c.name}
                          <ArrowUpRight size={14} />
                        </Link>
                        <small>
                          {c.source_table} → {c.target_table}
                        </small>
                        <button
                          className="overview-text-button"
                          onClick={() => setSelected(c.comparison_id)}
                        >{tr("Show daily chart")}</button>
                        <div className="overview-execution">
                          <Badge
                            value={c.conclusion ?? c.status ?? "not_evaluated"}
                          />
                          {c.execution_status &&
                            ["queued", "running"].includes(
                              c.execution_status,
                            ) && (
                              <small>
                                <Badge value={c.execution_status} />
                              </small>
                            )}
                          <small>
                            {c.finished_at
                              ? new Date(c.finished_at).toLocaleString(
                                  locale,
                                  {
                                    timeZone: "America/Sao_Paulo",
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )
                              : tr("No completed execution")}
                          </small>
                        </div>
                      </td>
                      <td>
                        <strong className="overview-rate">
                          {percent(rate, locale)}
                        </strong>
                        {rate && (
                          <small>
                            {formatNumber(rate.numerator)} / {formatNumber(rate.denominator)}{" "}{tr("evaluated")}<br />
                            {formatNumber(rate.not_evaluated)}{tr(" not evaluated")}</small>
                        )}
                        {settings.isPending ? (
                          tr("Loading target…")
                        ) : settings.isError ? (
                          <span>{tr("Unavailable")}</span>
                        ) : (
                          <TargetBadge rate={rate} target={target} />
                        )}
                      </td>
                      <td>
                        <MiniTrend points={c.points} />
                      </td>
                      <td>
                        {m
                          ? `${percent(m.key_coverage.reference_to_target.percentage, locale)} / ${percent(m.key_coverage.target_to_reference.percentage, locale)}`
                          : tr("Not evaluated")}
                        <small>{tr("Selected key sample")}</small>
                      </td>
                      <td>
                        {m
                          ? m.duplicate_key_rate
                              .map((p) => percent(p, locale))
                              .join(" / ")
                          : tr("Not evaluated")}
                        <small>{tr("Complete scoped data")}</small>
                      </td>
                      <td>
                        {m ? (
                          <>
                            <strong>
                              {m.row_count_match.equal
                                ? tr("Equal counts")
                                : tr("Different counts")}
                            </strong>
                            <small>
                              A {formatNumber(m.row_count_match.reference_count)} · B{" "}
                              {formatNumber(m.row_count_match.target_count)}
                            </small>
                            <small>
                              Δ {formatNumber(m.row_count_match.signed_difference)} ·{" "}
                              {percent(m.row_count_match.percentage_difference, locale)}{" "}{tr("absolute / A")}</small>
                          </>
                        ) : (
                          tr("Not evaluated")
                        )}
                      </td>
                      <td>
                        {m ? (
                          <>
                            <strong>
                              {review} / {columns.length}{tr(" pairs to review")}</strong>
                            <small>{tr("Individual rates in comparison details")}</small>
                          </>
                        ) : (
                          tr("Not evaluated")
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={tr("No matching comparisons")}>{tr("Adjust the search or create your first comparison.")}</Empty>
        )}
        {comparisons.data && (
          <div className="pagination">
            <span className="muted">
              {comparisons.data.total
                ? tr("{0}–{1} of {2}", {0: offset + 1, 1: Math.min(offset + 25, comparisons.data.total), 2: comparisons.data.total})
                : tr("0 comparisons")}
            </span>
            <Button
              variant="outline"
              disabled={!offset || comparisons.isFetching}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >{tr("Previous")}</Button>
            <Button
              variant="outline"
              disabled={
                offset + 25 >= comparisons.data.total || comparisons.isFetching
              }
              onClick={() => setOffset(offset + 25)}
            >{tr("Next")}</Button>
          </div>
        )}
      </Card>
    </>
  );
}
