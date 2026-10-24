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
const n = (value: number) => value.toLocaleString("en-US");
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
  const status = targetState(rate, target);
  return (
    <span className="target-status" data-state={status.state}>
      {status.label}
    </span>
  );
}
function MiniTrend({ points }: { points: Comparison["points"] }) {
  const available = points.some((p) => p.percentage != null);
  if (!available) return <span className="muted">No evaluations</span>;
  return (
    <div
      className="overview-spark"
      role="img"
      aria-label="Daily Row Match Rate; days without an evaluation remain gaps"
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
  const lower = metric === "duplicate_key_rate" || metric === "row_count_match";
  return (
    <>
      <div
        className="overview-metric-tabs"
        role="group"
        aria-label="Chart metric"
      >
        {metrics.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={m.id === metric}
            onClick={() => setMetric(m.id)}
          >
            {m.name}
          </button>
        ))}
      </div>
      <div className="overview-chart-caption">
        <p className="muted">
          {metrics.find((m) => m.id === metric)!.description}
        </p>
        {lower && (
          <span className="target-status" data-state="neutral">
            Lower is better
          </span>
        )}
      </div>
      {metric === "column_match_rate" && (
        <label>
          Column pair
          <select
            aria-label="Column pair"
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
                {p.left_column ?? "Unpaired"} → {p.right_column ?? "Unpaired"}
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
            aria-label={`${metrics.find((m) => m.id === metric)!.name} by day for ${comparison.name}`}
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
                  tickFormatter={(v) => String(v).slice(5)}
                  tick={{ fontSize: 12 }}
                  minTickGap={24}
                />
                <YAxis
                  domain={
                    metric === "row_count_match"
                      ? [0, (max: number) => Math.max(100, max)]
                      : [0, 100]
                  }
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 12 }}
                  width={58}
                />
                <Tooltip
                  content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    const point = q.data?.points.find((p) => p.day === label);
                    return (
                      <div className="overview-tooltip">
                        <strong>{label}</strong>
                        {point?.values.map((v) => (
                          <div key={v.label}>
                            <span>
                              {v.label}:{" "}
                              <strong>{percent(v.percentage)}</strong>
                            </span>
                            <small>
                              {n(v.numerator)} / {n(v.denominator)}
                              {metric === "row_count_match"
                                ? " · difference / source A"
                                : " evaluated"}{" "}
                              · {n(v.not_evaluated)} not evaluated
                            </small>
                            <small>
                              {v.scope.replaceAll("_", " ")}
                              {v.reason
                                ? ` · ${v.reason.replaceAll("_", " ")}`
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
                      value: `Target ${percent(target)}`,
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
                    name={label}
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
                {label}
              </span>
            ))}
            {metric === "row_match_rate" && target != null && (
              <span className="muted">
                Dashed line: current target {percent(target)}
              </span>
            )}
          </div>
        </>
      ) : (
        <Empty title="No evaluated points in this period">
          Choose another metric, comparison or period. Missing evaluations are
          never plotted as zero.
        </Empty>
      )}
      <details className="overview-daily">
        <summary>Daily values and denominators</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Execution</th>
                <th>Direction / pair</th>
                <th>Rate</th>
                <th>Numerator / denominator</th>
                <th>Not evaluated</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.points.flatMap((p) =>
                p.values.length
                  ? p.values.map((v) => (
                      <tr key={p.day + v.label}>
                        <td>{p.day}</td>
                        <td>
                          <Link
                            to={`/comparisons/${comparison.comparison_id}?run_id=${p.run_id}`}
                          >
                            <Badge value={p.status} />
                          </Link>
                        </td>
                        <td>{v.label}</td>
                        <td>{percent(v.percentage)}</td>
                        <td>
                          {n(v.numerator)} / {n(v.denominator)}
                        </td>
                        <td>{n(v.not_evaluated)}</td>
                      </tr>
                    ))
                  : [
                      <tr key={p.day}>
                        <td>{p.day}</td>
                        <td>{p.status ?? "No execution"}</td>
                        <td colSpan={4}>Not evaluated</td>
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
        title="Overview"
        eyebrow="COMPARISON HEALTH"
        subtitle="Track daily quality, investigate changes and follow your Row Match Rate target."
        action={
          <Allowed permission="comparisons.manage">
            <Button asChild>
              <Link to="/comparisons/new">New comparison</Link>
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
              label="Row Match Rate"
              value={percent(d.row_match_rate.percentage)}
              detail={`${n(d.row_match_rate.passed)} / ${n(d.row_match_rate.evaluated)} evaluated · ${percent(d.row_match_rate.coverage_percentage)} coverage`}
            />
            <Card className="overview-target">
              <div className="overview-stat-label">
                <Target size={17} />
                Quality target
              </div>
              <strong className="overview-target-value">
                {settings.isPending
                  ? "Loading…"
                  : settings.isError
                    ? "Unavailable"
                    : target == null
                      ? "Disabled"
                      : percent(target)}
              </strong>
              {!settings.isPending && !settings.isError && (
                <TargetBadge rate={globalRate} target={target} />
              )}
              <Link to="/settings/quality">
                {settings.isPending
                  ? "Quality settings"
                  : "View target settings"}
                <ArrowUpRight size={14} />
              </Link>
            </Card>
            <Stat
              label="Active comparisons"
              value={d.active_comparisons}
              detail={`${d.evaluated_comparisons} with an evaluated latest result`}
            />
            <Stat
              label="Requires investigation"
              value={
                (d.latest_conclusions.difference_observed ?? 0) +
                (d.latest_conclusions.inconclusive ?? 0) +
                (d.latest_conclusions.failed ?? 0)
              }
              detail={`${d.latest_conclusions.difference_observed ?? 0} differences · ${d.latest_conclusions.inconclusive ?? 0} inconclusive · ${d.latest_conclusions.failed ?? 0} failed`}
            />
          </div>
        )
      )}
      <Card className="overview-evolution">
        <div className="overview-section-heading">
          <div>
            <div className="overview-stat-label">
              <TrendingUp size={17} />
              DAILY EVOLUTION
            </div>
            <h2>Comparison quality over time</h2>
            <p className="muted">
              Last terminal execution per day · America/Sao_Paulo · today is
              partial
            </p>
          </div>
          <div className="overview-controls">
            <label>
              Comparison
              <select
                aria-label="Comparison"
                value={current?.comparison_id ?? ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option disabled value="">
                  Select a comparison
                </option>
                {items.map((c) => (
                  <option key={c.comparison_id} value={c.comparison_id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Period
              <select
                aria-label="Period"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[7, 15, 30].map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
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
          <Empty title="No comparisons to display">
            Existing active comparisons and their recorded history appear here.
          </Empty>
        )}
        <p className="overview-footnote">
          Rates use saved executions only. Days without an evaluation and failed
          executions remain gaps. The target line shows the current setting, not
          historical targets. A sample does not prove equality of entire tables.
        </p>
      </Card>
      <Card className="overview-comparisons">
        <div className="overview-section-heading">
          <div>
            <h2>Comparisons at a glance</h2>
            <p className="muted">
              Latest terminal result per active comparison. Target attainment is
              separate from the analytical conclusion.
            </p>
          </div>
          <label>
            Search comparisons
            <input
              type="search"
              value={search}
              maxLength={255}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="Search by name…"
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
                  <th>Comparison</th>
                  <th>Row Match Rate</th>
                  <th>Daily curve</th>
                  <th>
                    Key Coverage
                    <br />
                    <small>A → B / B → A</small>
                  </th>
                  <th>
                    Duplicate Key Rate
                    <br />
                    <small>A / B · lower is better</small>
                  </th>
                  <th>Row Count Match</th>
                  <th>Column Match Rate</th>
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
                        >
                          Show daily chart
                        </button>
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
                                  "en-US",
                                  {
                                    timeZone: "America/Sao_Paulo",
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )
                              : "No completed execution"}
                          </small>
                        </div>
                      </td>
                      <td>
                        <strong className="overview-rate">
                          {percent(rate)}
                        </strong>
                        {rate && (
                          <small>
                            {n(rate.numerator)} / {n(rate.denominator)}{" "}
                            evaluated
                            <br />
                            {n(rate.not_evaluated)} not evaluated
                          </small>
                        )}
                        {settings.isPending ? (
                          "Loading target…"
                        ) : settings.isError ? (
                          <span>Unavailable</span>
                        ) : (
                          <TargetBadge rate={rate} target={target} />
                        )}
                      </td>
                      <td>
                        <MiniTrend points={c.points} />
                      </td>
                      <td>
                        {m
                          ? `${percent(m.key_coverage.reference_to_target.percentage)} / ${percent(m.key_coverage.target_to_reference.percentage)}`
                          : "Not evaluated"}
                        <small>Selected key sample</small>
                      </td>
                      <td>
                        {m
                          ? m.duplicate_key_rate
                              .map((p) => percent(p))
                              .join(" / ")
                          : "Not evaluated"}
                        <small>Complete scoped data</small>
                      </td>
                      <td>
                        {m ? (
                          <>
                            <strong>
                              {m.row_count_match.equal
                                ? "Equal counts"
                                : "Different counts"}
                            </strong>
                            <small>
                              A {n(m.row_count_match.reference_count)} · B{" "}
                              {n(m.row_count_match.target_count)}
                            </small>
                            <small>
                              Δ {n(m.row_count_match.signed_difference)} ·{" "}
                              {percent(m.row_count_match.percentage_difference)}{" "}
                              absolute / A
                            </small>
                          </>
                        ) : (
                          "Not evaluated"
                        )}
                      </td>
                      <td>
                        {m ? (
                          <>
                            <strong>
                              {review} / {columns.length} pairs to review
                            </strong>
                            <small>
                              Individual rates in comparison details
                            </small>
                          </>
                        ) : (
                          "Not evaluated"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No matching comparisons">
            Adjust the search or create your first comparison.
          </Empty>
        )}
        {comparisons.data && (
          <div className="pagination">
            <span className="muted">
              {comparisons.data.total
                ? `${offset + 1}–${Math.min(offset + 25, comparisons.data.total)} of ${comparisons.data.total}`
                : "0 comparisons"}
            </span>
            <Button
              variant="outline"
              disabled={!offset || comparisons.isFetching}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={
                offset + 25 >= comparisons.data.total || comparisons.isFetching
              }
              onClick={() => setOffset(offset + 25)}
            >
              Next
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
