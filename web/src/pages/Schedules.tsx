import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus } from "lucide-react";
import { api, allPages, post, patch, type Model, type Page } from "../api";
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageTitle, Pagination } from "../components/common";
import { Dialog, DialogContent } from "../components/ui/dialog";

type Schedule = Model<"ScheduleOut">;
type Dispatch = Model<"ScheduleDispatchOut">;
type Preview = { cron_expression: string; timezone: string; next_runs: string[] };
const format = (date: string, zone: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(date));
const codes: Record<string, string> = {
  comparison_busy: "Comparison already queued or running", schedule_inactive: "Schedule paused", schedule_changed: "Schedule changed",
  comparison_inactive: "Comparison inactive", connection_inactive: "Source connection inactive", engine_unavailable: "Engine unavailable",
  not_found: "Comparison no longer exists", storage_unavailable: "Engine storage unavailable", invalid_engine_response: "Unable to confirm engine response",
};

export function Schedules() {
  const [params] = useSearchParams();
  const comparison = params.get("comparison_id") ?? "";
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Schedule | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const cache = useQueryClient();
  const comparisons = useQuery({ queryKey: ["schedule-comparisons"], queryFn: () => allPages<Model<"ComparisonOut">>("/comparisons") });
  const schedules = useQuery({ queryKey: ["schedules", comparison, search, offset], queryFn: () => api<Page<Schedule>>(
    `/schedules?limit=20&offset=${offset}&search=${encodeURIComponent(search)}${comparison ? "&comparison_id=" + comparison : ""}`), refetchInterval: 15000 });
  const dispatches = useQuery({ queryKey: ["dispatches", history?.id, historyOffset], enabled: !!history,
    queryFn: () => api<Page<Dispatch>>(`/schedules/${history!.id}/dispatches?limit=20&offset=${historyOffset}`), refetchInterval: 5000 });
  return <>
    <PageTitle title="Schedules" subtitle="Run comparisons automatically with a guided schedule or a traditional cron expression." />
    <div className="notice">Keep the controller, engine and worker running. Times use each schedule’s timezone. After downtime, one overdue occurrence is considered; older missed times are not replayed.</div>
    <div className="toolbar">
      <label>Search schedules<input value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} placeholder="Search by name…" /></label>
      <div className="actions">{comparison && <Button asChild variant="outline"><Link to="/schedules">All schedules</Link></Button>}
        <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus size={18} />New schedule</Button></div>
    </div>
    <ErrorBox error={error || schedules.error || comparisons.error} />
    {schedules.isPending ? <Loading /> : schedules.data?.items.length ? schedules.data.items.map(s => <Card key={s.id}>
      <div className="card-heading"><div className="resource-title"><span className="resource-icon"><CalendarClock /></span><div><h2>{s.name}</h2><Link to={"/comparisons/" + s.comparison_id}>{comparisons.data?.items.find(c => c.id === s.comparison_id)?.name ?? "Open comparison"}</Link></div></div>
        <Badge value={s.is_active ? "active" : "inactive"} /></div>
      <dl className="comparison-facts"><dt>Cron</dt><dd><code>{s.cron_expression}</code></dd><dt>Timezone</dt><dd>{s.timezone}</dd><dt>Next occurrence</dt><dd>{s.is_active ? format(s.next_run_at, s.timezone) : "Paused"}</dd></dl>
      <div className="card-bottom"><span className="muted small">If already queued or running, the occurrence is skipped.</span><div className="actions">
        <Button variant="outline" onClick={() => { setHistory(s); setHistoryOffset(0); }}>Dispatch history</Button>
        <Button variant="outline" onClick={() => { setEditing(s); setOpen(true); }}>Edit</Button>
        <Button variant="outline" onClick={async () => { try { await patch("/schedules/" + s.id, { is_active: !s.is_active }); await cache.invalidateQueries({ queryKey: ["schedules"] }); } catch (e) { setError(e); } }}>{s.is_active ? "Pause" : "Resume"}</Button>
      </div></div>
    </Card>) : <Card><Empty title="No schedules yet">Create a schedule for a saved comparison. No operating system crontab is required.</Empty></Card>}
    {schedules.data && <Pagination total={schedules.data.total} offset={offset} setOffset={setOffset} />}
    {history && <Card title={"Dispatch history — " + history.name} subtitle="Dispatch status describes delivery to the queue. Open the run to see its technical status and analytical result.">
      <ErrorBox error={dispatches.error} />
      {dispatches.isPending ? <Loading /> : dispatches.data?.items.length ? <><div className="table-scroll"><table><thead><tr><th>Scheduled time</th><th>Delivery</th><th>Attempts</th><th>Details</th><th>Run</th></tr></thead><tbody>{dispatches.data.items.map(d => <tr key={d.id}><td>{format(d.scheduled_for, history.timezone)}</td><td>{d.status}</td><td>{d.attempts}</td><td>{d.error_code ? codes[d.error_code] ?? d.error_code : "—"}</td><td>{d.run_id ? <Link to={"/runs/" + d.run_id}>Open run</Link> : "—"}</td></tr>)}</tbody></table></div><Pagination total={dispatches.data.total} offset={historyOffset} setOffset={setHistoryOffset} /></> : <Empty title="No occurrences yet">The first occurrence will appear after the next scheduled time.</Empty>}
    </Card>}
    <Dialog open={open} onOpenChange={setOpen}>{open && <ScheduleForm schedule={editing} comparisonId={comparison} comparisons={comparisons.data?.items ?? []} onSaved={() => { setOpen(false); void cache.invalidateQueries({ queryKey: ["schedules"] }); }} />}</Dialog>
  </>;
}

function ScheduleForm({ schedule, comparisonId, comparisons, onSaved }: { schedule: Schedule | null; comparisonId: string; comparisons: Model<"ComparisonOut">[]; onSaved: () => void }) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [target, setTarget] = useState(schedule?.comparison_id ?? comparisonId);
  const [mode, setMode] = useState(schedule ? "cron" : "guided");
  const [expression, setExpression] = useState(schedule?.cron_expression ?? "0 8 * * *");
  const [zone, setZone] = useState(schedule?.timezone ?? "America/Sao_Paulo");
  const [frequency, setFrequency] = useState("daily");
  const [time, setTime] = useState("08:00");
  const [weekday, setWeekday] = useState("1");
  const [monthday, setMonthday] = useState("1");
  const [minute, setMinute] = useState("0");
  const [interval, setInterval] = useState("15");
  const [active, setActive] = useState(schedule?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hour, min] = time.split(":").map(Number);
  const cron = mode === "cron" ? expression.trim() : frequency === "interval" ? `*/${interval} * * * *` : frequency === "hourly" ? `${minute} * * * *` : frequency === "weekly" ? `${min} ${hour} * * ${weekday}` : frequency === "monthly" ? `${min} ${hour} ${monthday} * *` : `${min} ${hour} * * *`;
  const [candidate, setCandidate] = useState({ cron, zone });
  useEffect(() => { const t = window.setTimeout(() => setCandidate({ cron, zone }), 350); return () => clearTimeout(t); }, [cron, zone]);
  const preview = useQuery({ queryKey: ["cron-preview", candidate.cron, candidate.zone], queryFn: () => post<Preview>("/schedules/preview", { cron_expression: candidate.cron, timezone: candidate.zone }), retry: false });
  const validPreview = !preview.isError && !!preview.data && candidate.cron === cron && candidate.zone === zone;
  return <DialogContent title={schedule ? "Edit schedule" : "New schedule"} description="Choose a comparison and define when its validations should run.">
    <form onSubmit={async e => { e.preventDefault(); if (!validPreview || busy) return; setBusy(true); setError(null); try { const body = { name, comparison_id: target, cron_expression: cron, timezone: zone, is_active: active }; if (schedule) await patch("/schedules/" + schedule.id, body); else await post("/schedules", body); onSaved(); } catch (e) { setError(e); } finally { setBusy(false); } }}>
      <div className="form-grid"><label>Schedule name<input required maxLength={255} value={name} onChange={e => setName(e.target.value)} /></label><label>Comparison<select aria-label="Comparison" required value={target} onChange={e => setTarget(e.target.value)}><option value="">Select a comparison</option>{comparisons.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : " (inactive)"}</option>)}</select></label></div>
      <fieldset className="schedule-mode"><legend>Configuration mode</legend><label className="check-label"><input type="radio" name="schedule-mode" checked={mode === "guided"} onChange={() => setMode("guided")} />Guided</label><label className="check-label"><input type="radio" name="schedule-mode" checked={mode === "cron"} onChange={() => { setExpression(cron); setMode("cron"); }} />Cron expression</label></fieldset>
      {mode === "guided" ? <><div className="form-grid"><label>Frequency<select aria-label="Frequency" value={frequency} onChange={e => setFrequency(e.target.value)}><option value="interval">Every N minutes</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        {frequency === "interval" ? <label>Minutes interval<select aria-label="Minutes interval" value={interval} onChange={e => setInterval(e.target.value)}>{[1,2,3,5,10,15,20,30].map(n => <option key={n}>{n}</option>)}</select></label> : frequency === "hourly" ? <label>Minute of hour<input type="number" min="0" max="59" required value={minute} onChange={e => setMinute(e.target.value)} /></label> : <label>Time<input type="time" required value={time} onChange={e => setTime(e.target.value)} /></label>}
        {frequency === "weekly" && <label>Day of week<select aria-label="Day of week" value={weekday} onChange={e => setWeekday(e.target.value)}>{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((d,i) => <option key={d} value={i}>{d}</option>)}</select></label>}
        {frequency === "monthly" && <label>Day of month<input aria-label="Day of month" type="number" min="1" max="31" required value={monthday} onChange={e => setMonthday(e.target.value)} /><span className="muted small">Months without this day are skipped.</span></label>}</div><p className="muted small">Switching to Guided replaces a custom expression with the selections above.</p></> : <label>Cron expression<input aria-label="Cron expression" required value={expression} onChange={e => setExpression(e.target.value)} placeholder="0 8 * * 1-5" spellCheck={false} /><span className="muted small">minute · hour · day of month · month · day of week. Example: 0 8 * * 1-5 = weekdays at 08:00. No seconds or shell commands.</span></label>}
      <label>Timezone<input required list="schedule-timezones" value={zone} onChange={e => setZone(e.target.value)} placeholder="America/Sao_Paulo" /><datalist id="schedule-timezones"><option value="America/Sao_Paulo" /><option value="UTC" /><option value="Europe/Lisbon" /><option value="America/New_York" /></datalist></label>
      <div className="notice"><strong>Effective cron: <code>{cron}</code></strong><p className="muted small">When both day of month and day of week are restricted, either can match (traditional cron).</p><div aria-live="polite">{!validPreview && !preview.error ? "Validating next occurrences…" : preview.data && <><strong>Next occurrences ({zone})</strong><ol>{preview.data.next_runs.map(d => <li key={d}>{format(d, candidate.zone)}</li>)}</ol></>}</div></div>
      <ErrorBox error={error || preview.error} />
      <label className="check-label"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Schedule enabled</label>
      <p className="muted small">A busy comparison is skipped. Temporary delivery failures retry up to five times using the same idempotency key. Pausing does not cancel an already queued run.</p>
      <div className="form-footer"><Button type="submit" disabled={busy || !validPreview}>{busy ? "Saving…" : "Save schedule"}</Button></div>
    </form>
  </DialogContent>;
}
