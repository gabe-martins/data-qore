import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { api, type Model } from "../api";
import { Card, Empty, ErrorBox, Loading, percent } from "./common";

const colors = ["var(--primitive-green-700)", "var(--primitive-blue-700)",
  "var(--primitive-amber-700)", "var(--primitive-ink-900)", "var(--primitive-slate-600)"];
const zone = "America/Sao_Paulo";
type Trend = Model<"QualityTrendOut">;
const timestamp = (value: string) => new Intl.DateTimeFormat("en-US", {
  timeZone: zone, dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

function PointDetails({ day, series }: { day: string; series: Trend["series"] }) {
  return <><strong>{day}</strong>{series.map((s, i) => {
    const p = s.points.find(p => p.day === day);
    return p && <div key={s.comparison_id} className="quality-point">
      <strong><span className="quality-swatch" style={{ background: colors[i % colors.length] }} />{s.name}</strong>
      <div>{p.finished_at ? `${timestamp(p.finished_at)} · ${p.status}` : "No completed run"}</div>
      <div>Agreement: {percent(p.percentage)} · Coverage: {percent(p.coverage_percentage)}</div>
      <div>{p.passed.toLocaleString()} equal / {p.evaluated.toLocaleString()} evaluated sample positions</div>
      {p.conclusion && <div>Conclusion: {p.conclusion.replaceAll("_", " ")}</div>}
    </div>;
  })}</>;
}

export function QualityTrend({ target }: { target?: string }) {
  const [days, setDays] = useState(7);
  const q = useQuery({
    queryKey: ["quality-trend", "agreement", days, zone],
    queryFn: () => api<Trend>(`/overview/quality-trend?metric=agreement&days=${days}&timezone=${encodeURIComponent(zone)}`, { cache: "no-store" }),
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
  const d = q.data;
  const hasQuality = d?.series.some(s => s.points.some(p => p.percentage !== null));
  const chart = d?.series[0]?.points.map((p, index) => Object.fromEntries([
    ["day", p.day], ["linear_trend", d.linear_trend[index].percentage === null ? null : Number(d.linear_trend[index].percentage)], ...d.series.map(s => [s.comparison_id,
      s.points[index].percentage === null ? null : Number(s.points[index].percentage)]),
  ])) ?? [];
  return <Card title="Quality over time" subtitle="Comparison agreement · last completed run per day · America/Sao_Paulo · today is partial">
    <label className="quality-period">Period<select aria-label="Quality period" value={days} onChange={e => setDays(Number(e.target.value))}>
      {[7, 15, 30].map(n => <option key={n} value={n}>{n} days</option>)}
    </select></label>
    <ErrorBox error={q.error} />
    {q.isPending ? <Loading /> : d && <>
      {hasQuality ? <div className="chart" role="img" aria-label={`Daily comparison agreement for ${days} days with linear trend and target. Details are available below.`}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={chart} accessibilityLayer>
          <CartesianGrid stroke="var(--semantic-border-default)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={v => v.slice(5)} padding={{ left: 12, right: 12 }} />
          <YAxis domain={[0, 100]} allowDataOverflow unit="%" padding={{ top: 8, bottom: 8 }} />
          <Tooltip filterNull={false} content={({ active, label }) => active && label ?
            <div className="quality-tooltip"><PointDetails day={String(label)} series={d.series} />
              <div>Overall agreement: {percent(d.overall.find(p => p.day === String(label))?.percentage)}</div>
              <div>Linear trend: {percent(d.linear_trend.find(p => p.day === String(label))?.percentage)}</div>
              <div>Target: {percent(target)}</div>
            </div> : null} />
          {target !== undefined && <ReferenceLine y={Number(target)} stroke="var(--primitive-amber-700)" strokeDasharray="8 4" label={{ value: `Target ${percent(target)}`, position: "insideBottomRight" }} />}
          {d.series.map((s, i) => <Line key={s.comparison_id} type="linear" dataKey={s.comparison_id} name={s.name}
            stroke={colors[i % colors.length]} strokeDasharray={i >= colors.length ? "5 3" : undefined}
            dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />)}
          <Line dataKey="linear_trend" name="Overall linear trend" stroke="var(--primitive-ink-900)" strokeWidth={2} strokeDasharray="3 4" dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer>
      </div> : <Empty title="No agreement evaluations in this period">Completed comparisons with safe key alignment and evaluated positions will appear here.</Empty>}
      {!!d.series.length && <ul className="quality-legend" aria-label="Comparison legend">{d.series.map((s, i) =>
        <li key={s.comparison_id}><span className="quality-swatch" style={{ background: colors[i % colors.length] }} />
          <Link to={`/comparisons/${s.comparison_id}`}>{s.name}</Link>
          {!s.points.some(p => p.percentage !== null) && <span className="muted"> — no agreement evaluations</span>}
        </li>)}</ul>}
      <ul className="quality-legend" aria-label="Trend and target legend">
        <li><span className="quality-swatch" style={{ background: "transparent", height: 0, borderTop: "2px dashed var(--primitive-ink-900)" }} />Overall linear trend</li>
        <li><span className="quality-swatch" style={{ background: "transparent", height: 0, borderTop: "2px dashed var(--primitive-amber-700)" }} />Target {percent(target)}</li>
      </ul>
      {!!d.series.length && <details className="quality-details"><summary>Daily run details</summary>
        <div className="quality-daily-details">{d.series[0].points.map(p => <section key={p.day}>
          <PointDetails day={p.day} series={d.series} />
        </section>)}</div>
      </details>}
      <p className="small">Overall linear trend · {d.regression_observations} evaluated days · Target {percent(target)}. <Link to="/settings">Configure target</Link></p>
      {d.regression_observations < 2 && <p className="small muted">At least two evaluated days are required for a linear trend.</p>}
    </>}
    <p className="small muted">Active comparisons only. Each day uses its last completed run, including failures.
      Manual and scheduled runs use the same calculation. Missing evaluations remain gaps. Overall agreement weights equal positions by evaluated positions.
      The dashed trend is a statistical fit, not observed data or a forecast; values outside 0–100% are clipped in the chart. Source validity remains under Sample quality.</p>
  </Card>;
}
