import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
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
      <div>Sample quality: {percent(p.percentage)} · Coverage: {percent(p.coverage_percentage)}</div>
      <div>{p.passed.toLocaleString()} passed / {p.evaluated.toLocaleString()} evaluated checks</div>
    </div>;
  })}</>;
}

export function QualityTrend() {
  const [days, setDays] = useState(7);
  const q = useQuery({
    queryKey: ["quality-trend", days, zone],
    queryFn: () => api<Trend>(`/overview/quality-trend?days=${days}&timezone=${encodeURIComponent(zone)}`),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
  const d = q.data;
  const hasQuality = d?.series.some(s => s.points.some(p => p.percentage !== null));
  const chart = d?.series[0]?.points.map((p, index) => Object.fromEntries([
    ["day", p.day], ...d.series.map(s => [s.comparison_id,
      s.points[index].percentage === null ? null : Number(s.points[index].percentage)]),
  ])) ?? [];
  return <Card title="Quality over time" subtitle="Last completed run per day · America/Sao_Paulo · today is partial">
    <label className="quality-period">Period<select aria-label="Quality period" value={days} onChange={e => setDays(Number(e.target.value))}>
      {[7, 15, 30].map(n => <option key={n} value={n}>{n} days</option>)}
    </select></label>
    <ErrorBox error={q.error} />
    {q.isPending ? <Loading /> : d && <>
      {hasQuality ? <div className="chart" role="img" aria-label={`Daily sample quality by comparison for ${days} days. Details are available below.`}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={chart} accessibilityLayer>
          <CartesianGrid stroke="var(--semantic-border-default)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={v => v.slice(5)} padding={{ left: 12, right: 12 }} />
          <YAxis domain={[0, 100]} unit="%" padding={{ top: 8, bottom: 8 }} />
          <Tooltip filterNull={false} content={({ active, label }) => active && label ?
            <div className="quality-tooltip"><PointDetails day={String(label)} series={d.series} /></div> : null} />
          {d.series.map((s, i) => <Line key={s.comparison_id} type="linear" dataKey={s.comparison_id} name={s.name}
            stroke={colors[i % colors.length]} strokeDasharray={i >= colors.length ? "5 3" : undefined}
            dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />)}
        </LineChart></ResponsiveContainer>
      </div> : <Empty title="No quality evaluations in this period">Completed runs with evaluated checks will appear here.</Empty>}
      {!!d.series.length && <ul className="quality-legend" aria-label="Comparison legend">{d.series.map((s, i) =>
        <li key={s.comparison_id}><span className="quality-swatch" style={{ background: colors[i % colors.length] }} />
          <Link to={`/comparisons/${s.comparison_id}`}>{s.name}</Link>
          {!s.points.some(p => p.percentage !== null) && <span className="muted"> — no quality evaluations</span>}
        </li>)}</ul>}
      {!!d.series.length && <details className="quality-details"><summary>Daily run details</summary>
        <div className="quality-daily-details">{d.series[0].points.map(p => <section key={p.day}>
          <PointDetails day={p.day} series={d.series} />
        </section>)}</div>
      </details>}
    </>}
    <p className="small muted">Active comparisons only. Each day uses its last completed run, including failures.
      Missing evaluations remain gaps. Quality measures sample checks, not agreement between sources.</p>
  </Card>;
}
