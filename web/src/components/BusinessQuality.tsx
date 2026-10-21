import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, post, type Model } from "../api";
import { Button, Card, Empty, ErrorBox, Loading, percent } from "./common";

type Rule = Model<"RuleInput">;
type Definition = Rule["definition"];
const defaults = (kind: string): Definition => kind === "domain" ? { kind: "domain", values: [], null_policy: "fail" } : kind === "range" ? { kind: "range", minimum: null, maximum: null, include_minimum: true, include_maximum: true, timezone: null, null_policy: "fail" } : kind === "temporal_order" ? { kind: "temporal_order", other_column: "", operator: "lte", timezone: null, null_policy: "fail" } : { kind: "required", reject_blank: true, whitespace_blank: false };

export function QualityRulesEditor({ datasetId, columns }: { datasetId: string; columns: Record<string, any> }) {
  const query = useQuery({ queryKey: ["quality-rules", datasetId], queryFn: () => api<Model<"RuleSetOut">>(`/datasets/${datasetId}/quality-rules`), refetchOnWindowFocus: false });
  const [rules, setRules] = useState<Rule[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  function load(data: Model<"RuleSetOut">) {
    setRules(data.rules.map(({ version: _version, ...rule }) => rule)); setRevision(data.revision); setError(null); setSaved(false);
  }
  useEffect(() => { if (query.data && revision === null) load(query.data); }, [query.data, revision]);
  function update(index: number, next: Partial<Rule>) { setRules(rules.map((r, i) => i === index ? { ...r, ...next } : r)); setSaved(false); }
  return <Card title="Business quality rules" subtitle="Versioned dataset rules. Saved changes apply only to new runs; existing results and queued runs keep their frozen rules.">
    <ErrorBox error={error || query.error} />
    {query.isPending ? <Loading /> : query.data && <>
      <p className="notice">Rules evaluate the observed sample only. Business quality, source validity checks and comparison agreement are separate indicators. Numeric bounds use exact decimal strings with a dot.</p>
      <p className="small muted">Configuration revision {revision}. Removing a rule does not remove historical evidence.</p>
      {rules.map((rule, index) => {
        const d = rule.definition;
        const field = (label: string) => `${label} ${index + 1}`;
        return <fieldset key={index} disabled={busy} className="card">
          <legend>Rule {index + 1}{rule.id ? ` · v${query.data.rules.find(r => r.id === rule.id)?.version ?? 1}` : " · new"}</legend>
          <div className="form-grid">
            <label>Name<input aria-label={field("Rule name")} value={rule.name} maxLength={128} onChange={e => update(index, { name: e.target.value })} /></label>
            <label>Column<select aria-label={field("Rule column")} value={rule.column} onChange={e => update(index, { column: e.target.value })}><option value="">Select a column</option>{Object.keys(columns).map(name => <option key={name}>{name}</option>)}</select></label>
            <label>Rule type<select aria-label={field("Rule type")} value={d.kind} onChange={e => update(index, { definition: defaults(e.target.value) })}><option value="required">Required field</option><option value="domain">Allowed values</option><option value="range">Numeric / temporal range</option><option value="temporal_order">Temporal order</option></select></label>
            <label><input type="checkbox" aria-label={field("Rule active")} checked={rule.is_active} onChange={e => update(index, { is_active: e.target.checked })} /> Active</label>
          </div>
          {d.kind === "required" && <div className="form-grid">
            <label><input type="checkbox" checked={d.reject_blank} onChange={e => update(index, { definition: { ...d, reject_blank: e.target.checked } })} /> Reject empty strings</label>
            <label><input type="checkbox" checked={d.whitespace_blank} onChange={e => update(index, { definition: { ...d, whitespace_blank: e.target.checked } })} /> Treat whitespace-only strings as blank</label>
            <p className="small muted">NULL always fails. Zero and false are present values. Text is never modified.</p>
          </div>}
          {d.kind === "domain" && <label>Allowed values (one per line)<textarea aria-label={field("Allowed values")} value={d.values.map(String).join("\n")} maxLength={16000} onChange={e => {
            const boolean = /^(bool|boolean|bit)$/i.test(columns[rule.column]?.type ?? "");
            update(index, { definition: { ...d, values: e.target.value.split("\n").map(v => boolean && (v === "true" || v === "false") ? v === "true" : v) } });
          }} /><small>Exact values, including spaces. Numeric values retain decimal precision. Boolean values must be true or false.</small></label>}
          {d.kind === "range" && <div className="form-grid">
            <label>Minimum<input aria-label={field("Minimum")} value={d.minimum ?? ""} placeholder="Optional lower bound" maxLength={1024} onChange={e => update(index, { definition: { ...d, minimum: e.target.value || null } })} /></label>
            <label>Maximum<input aria-label={field("Maximum")} value={d.maximum ?? ""} placeholder="Optional upper bound" maxLength={1024} onChange={e => update(index, { definition: { ...d, maximum: e.target.value || null } })} /></label>
            <label><input type="checkbox" checked={d.include_minimum} onChange={e => update(index, { definition: { ...d, include_minimum: e.target.checked } })} /> Include minimum</label>
            <label><input type="checkbox" checked={d.include_maximum} onChange={e => update(index, { definition: { ...d, include_maximum: e.target.checked } })} /> Include maximum</label>
          </div>}
          {d.kind === "temporal_order" && <div className="form-grid">
            <label>Relation<select aria-label={field("Temporal relation")} value={d.operator} onChange={e => update(index, { definition: { ...d, operator: e.target.value as "lt" | "lte" | "gt" | "gte" } })}><option value="lte">Earlier than or equal to</option><option value="lt">Earlier than</option><option value="gte">Later than or equal to</option><option value="gt">Later than</option></select></label>
            <label>Other column<select aria-label={field("Other column")} value={d.other_column} onChange={e => update(index, { definition: { ...d, other_column: e.target.value } })}><option value="">Select a column</option>{Object.keys(columns).filter(n => n !== rule.column).map(n => <option key={n}>{n}</option>)}</select></label>
          </div>}
          {(d.kind === "domain" || d.kind === "range" || d.kind === "temporal_order") && <label>Interpretation timezone<input aria-label={field("Rule timezone")} value={d.timezone ?? ""} maxLength={100} placeholder="IANA timezone, e.g. America/Sao_Paulo" onChange={e => update(index, { definition: { ...d, timezone: e.target.value || null } })} /><small>Required for timestamps without a timezone. Use ISO dates or timestamps for temporal bounds; STRING columns are not parsed as dates.</small></label>}
          {d.kind !== "required" && <label>NULL policy<select aria-label={field("NULL policy")} value={d.null_policy} onChange={e => update(index, { definition: { ...d, null_policy: e.target.value as "fail" | "skip" } })}><option value="fail">Fail the rule</option><option value="skip">Skip and report as not evaluated</option></select></label>}
          <Button variant="outline" onClick={() => { setRules(rules.filter((_, i) => i !== index)); setSaved(false); }}>Remove rule {index + 1}</Button>
        </fieldset>;
      })}
      {!rules.length && <Empty title="No business rules configured">Source validity checks remain available. No business approval is inferred.</Empty>}
      <div className="toolbar">
        <Button variant="outline" disabled={busy || rules.length >= 100 || revision === null} onClick={() => { setRules([...rules, { name: "", column: "", is_active: true, definition: defaults("required") }]); setSaved(false); }}>Add rule</Button>
        <Button disabled={busy || revision === null} onClick={async () => {
          setBusy(true); setError(null); setSaved(false);
          try { const data = await post<Model<"RuleSetOut">>(`/datasets/${datasetId}/quality-rules`, { expected_revision: revision, rules }); load(data); await query.refetch(); setSaved(true); }
          catch (e) { setError(e); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save quality rules"}</Button>
        <Button variant="outline" disabled={busy} onClick={async () => { const result = await query.refetch(); if (result.data) load(result.data); }}>Reload saved rules</Button>
      </div>
      {saved && <p role="status">Rules saved. Request a new profile or comparison to evaluate this revision.</p>}
    </>}
  </Card>;
}

export function BusinessQualityResult({ result }: { result: any }) {
  const quality = result?.indicators?.business_quality;
  return <Card title="Business quality" subtitle="Independent of source validity and comparison agreement. Evidence is limited to the observed sample.">
    {!quality ? <p className="muted">Business rules were not captured in this historical run.</p> : <>
      <p>Checks passed: <strong>{quality.overall.evaluated ? percent(quality.overall.percentage) : "Not evaluated"}</strong> · {quality.overall.passed} passed / {quality.overall.evaluated} evaluated · coverage {quality.overall.total ? percent(quality.overall.coverage_percentage) : "Not applicable"}</p>
      {quality.sources.map((source: any) => <section key={source.source}>
        <h3>Source {source.source} · rules revision {source.rules_revision}</h3>
        {!source.rules.length ? <p className="muted">No rules configured for this dataset when the run was queued.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Rule / version</th><th>Column</th><th>State</th><th>Passed</th><th>Failed</th><th>Evaluated</th><th>Not evaluated</th><th>Reasons</th></tr></thead>
          <tbody>{source.rules.map((r: any) => <tr key={r.rule.id}><td>{r.rule.name} · v{r.rule.version}</td><td>{r.rule.column}</td><td>{r.state}</td><td>{r.passed}</td><td>{r.failed}</td><td>{r.evaluated}</td><td>{r.not_evaluated}</td><td>{Object.entries(r.reasons).map(([k, v]) => `${k.replaceAll("_", " ")}: ${v}`).join("; ") || "—"}</td></tr>)}</tbody>
        </table></div>}
        {source.rules.length > 0 && <details><summary>Frozen rule definitions</summary><dl>{source.rules.map((r: any) => <div key={r.rule.id}><dt>{r.rule.name} · {r.rule.id} · v{r.rule.version}</dt><dd className="break">{JSON.stringify(r.rule.definition)}</dd></div>)}</dl></details>}
      </section>)}
    </>}
  </Card>;
}
