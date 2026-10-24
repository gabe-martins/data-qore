import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Model, type Page } from "../api";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  Pagination,
  percent,
} from "./common";
import { Rate } from "./CriticalMetrics";
import { ComparisonRunAnimation } from "./ComparisonRunAnimation";

const n = (value: number) => value.toLocaleString("en-US");
const motion = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
const labels: Record<string, string> = {
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
function Status({ value }: { value: string }) {
  return (
    <span
      className={`badge ${value === "passed" ? "success" : value === "critical" || value === "attention" ? "warning" : "info"}`}
    >
      {labels[value] ?? value}
    </span>
  );
}
function Value({ value }: { value: any }) {
  if (!value) return <span className="muted">Not captured</span>;
  if (value.kind !== "value")
    return (
      <span className="cell-sentinel">
        {(
          {
            null: "NULL",
            missing: "Record / column absent",
            unavailable: "Unavailable",
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
      {raw}
      {value.normalized != null && value.normalized !== String(value.raw) && (
        <small className="muted">Compared as: {value.normalized}</small>
      )}
    </span>
  );
}
function Explain({
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
  return (
    <details className="metric-explanation">
      <summary>Calculation details</summary>
      <p>{description}</p>
      <p>
        <code>{formula}</code>
      </p>
      {metric?.denominator != null && (
        <p>
          Numerator: {n(metric.numerator)} · denominator:{" "}
          {n(metric.denominator)} · not evaluated: {n(metric.not_evaluated)}
        </p>
      )}
      <p>Scope: {(scope ?? metric?.scope ?? "sample").replaceAll("_", " ")}</p>
      <p>
        Numeric tolerances: absolute{" "}
        {String(tolerances?.absolute_tolerance ?? 0)} · relative{" "}
        {String(tolerances?.relative_tolerance ?? 0)} (fraction). Text remains
        exact.
      </p>
      <p>
        Passed requires complete evaluation without differences or technical
        impediments. {metric?.reason?.replaceAll("_", " ")}
      </p>
    </details>
  );
}

export function ExecutionContext({
  quality,
}: {
  quality: Model<"QualityOut">;
}) {
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
        ).toFixed(1) + " seconds"
      : "Pending";
  return (
    <Card
      title="Execution information"
      subtitle="Frozen configuration for the selected execution"
    >
      <Badge value={run.status} />
      <div className="form-grid comparison-settings">
        <p>
          <strong>Sources</strong>
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
          <strong>Date and duration</strong>
          <span>
            {new Date(run.requested_at).toLocaleString("en-US", {
              timeZone: "America/Sao_Paulo",
            })}{" "}
            · America/Sao_Paulo · {duration}
          </span>
        </p>
        <p>
          <strong>Comparison key</strong>
          <span>
            {(result?.key_validation ?? [])
              .map((k: any) => k.columns.join(" + "))
              .join(" ↔ ") ||
              frozen.business_key
                ?.map((k: any) => `${k.left} ↔ ${k.right}`)
                .join(", ") ||
              "Discovered from metadata"}
          </span>
        </p>
        <p>
          <strong>Data scope</strong>
          <span>
            {scope?.period
              ? `${scope.period.start} → ${scope.period.end} (end exclusive)`
              : "Entire table"}{" "}
            · {scope?.filters?.length ?? 0} equivalent filters
          </span>
        </p>
        <p>
          <strong>Exclusions</strong>
          <span>
            A: {frozen.excluded_columns?.left?.join(", ") || "None"} · B:{" "}
            {frozen.excluded_columns?.right?.join(", ") || "None"}
          </span>
        </p>
        <p>
          <strong>Timestamp interpretation</strong>
          <span>
            {Object.entries(frozen.timestamp_timezones ?? {})
              .flatMap(([side, zones]: any) =>
                Object.entries(zones).map(
                  ([col, zone]) =>
                    `${side === "left" ? "A" : "B"}.${col}: ${zone}`,
                ),
              )
              .join(" · ") || "No explicit overrides"}
          </span>
        </p>
        <p>
          <strong>Numeric tolerances</strong>
          <span>
            Absolute:{" "}
            {String(sample.absolute_tolerance ?? p.absolute_tolerance ?? 0)} ·
            relative fraction:{" "}
            {String(sample.relative_tolerance ?? p.relative_tolerance ?? 0)}
          </span>
        </p>
        <p>
          <strong>Sampling strategy</strong>
          <span>
            {sample.algorithm ?? "Deterministic SHA-256 union selection"} · seed{" "}
            {sample.seed ?? "Pending"}
          </span>
        </p>
      </div>
      {run.status === "failed" && (
        <p className="notice warning" role="alert">
          Execution incomplete: {run.error_code}. {run.error_message} No
          data-quality score is assigned to this technical failure.
        </p>
      )}
    </Card>
  );
}

export function ComparisonQuality({
  quality,
}: {
  quality: Model<"QualityOut">;
}) {
  const [dimension, setDimension] = useState("consistency");
  const [search, setSearch] = useState(""),
    [columnStatus, setColumnStatus] = useState("all"),
    [sort, setSort] = useState("differences"),
    [columnOffset, setColumnOffset] = useState(0);
  const [state, setState] = useState("all"),
    [column, setColumn] = useState(""),
    [keyInput, setKeyInput] = useState(""),
    [keyFilter, setKeyFilter] = useState(""),
    [recordOffset, setRecordOffset] = useState(0),
    [expanded, setExpanded] = useState<number | null>(null),
    [exportError, setExportError] = useState<unknown>(null),
    [exporting, setExporting] = useState(false);
  const result: any = quality.result,
    run = quality.run,
    evidence: any = quality.evidence;
  const available = !!result,
    captured = ["available", "partial"].includes(evidence.status);
  const columnQuery = new URLSearchParams({
    limit: "50",
    offset: String(columnOffset),
    search,
    status: columnStatus,
    sort,
  });
  const cols = useQuery({
    queryKey: ["quality-columns", run.id, columnQuery.toString()],
    queryFn: () =>
      api<Page<Model<"QualityColumnOut">>>(
        `/runs/${run.id}/quality/columns?${columnQuery}`,
      ),
    enabled: available,
  });
  const filters = new URLSearchParams({
    state,
    ...(column ? { column } : {}),
    ...(keyFilter ? { key: keyFilter } : {}),
  });
  const records = useQuery({
    queryKey: ["quality-records", run.id, filters.toString(), recordOffset],
    queryFn: () =>
      api<Page<Model<"EvidenceRecordOut">>>(
        `/runs/${run.id}/quality/records?${filters}&limit=50&offset=${recordOffset}`,
      ),
    enabled: available && captured,
  });
  const record = useQuery({
    queryKey: ["quality-record", run.id, expanded],
    queryFn: () =>
      api<Model<"EvidenceRecordOut">>(
        `/runs/${run.id}/quality/records/${expanded}`,
      ),
    enabled: captured && expanded !== null,
  });
  useEffect(() => {
    if (available && window.location.hash === "#quality-records")
      document
        .getElementById("quality-records")
        ?.scrollIntoView({ behavior: "auto" });
  }, [run.id, available]);
  const inspect = (nextState = "all", nextColumn = "") => {
    setState(nextState);
    setColumn(nextColumn);
    setRecordOffset(0);
    setExpanded(null);
    document
      .getElementById("quality-records")
      ?.scrollIntoView({ behavior: motion(), block: "start" });
  };
  if (!result)
    return (
      <Card title="Comparison Quality">
        {run.status === "queued" || run.status === "running" ? (
          <ComparisonRunAnimation state={run.status} />
        ) : (
          <p>
            Indicators unavailable. This execution did not publish a completed
            result.
          </p>
        )}
      </Card>
    );
  const m = result.metrics,
    row = m.row_match_rate,
    count = m.row_count_match,
    keys = m.key_coverage;
  const allColumns = result.column_directory.map((c: any) => ({
    id: c.id,
    label: `${c.left_column ?? "Missing"} ↔ ${c.right_column ?? "Missing"}`,
  }));
  const openDimension = (id: string) => {
    setDimension(id);
    document
      .getElementById(`dimension-${id}`)
      ?.scrollIntoView({ behavior: motion(), block: "nearest" });
  };
  return (
    <section aria-label="Comparison Quality" className="comparison-quality">
      <Card
        title="Comparison Quality"
        subtitle="Indicators and diagnostics for this execution only"
      >
        <Badge value={result.summary.status} />
        <div className="quality-headline">
          <div>
            <span>Row Match Rate</span>
            <strong>{percent(row.percentage)}</strong>
            <Rate value={row} showValue={false} />
          </div>
          <div>
            <strong>
              {n(row.numerator)} matching · {n(row.different_rows)} different
            </strong>
            <p>
              {n(row.not_evaluated)} not evaluated · evaluation coverage{" "}
              {percent(row.coverage_percentage)}
            </p>
            <p>Sample results do not certify equality of entire tables.</p>
          </div>
        </div>
        <Explain
          metric={row}
          formula={row.formula}
          description="A record matches only when all included fields match. Missing records count as differences; unknown records without a proven difference are excluded from the denominator."
          tolerances={result.sampling_plan}
        />
        {row.not_evaluated > 0 && (
          <p className="notice warning">
            Partial evaluation. The rate applies to {n(row.denominator)}{" "}
            evaluated positions, not all {n(row.total)} selected positions.
          </p>
        )}
        {!row.total && (
          <p className="notice warning">
            No row positions available for evaluation.
          </p>
        )}
        <div className="quality-indicators">
          <button type="button" onClick={() => openDimension("volume")}>
            <span>Row Count Match</span>
            <strong>{count.equal ? "Equal counts" : "Different counts"}</strong>
            <small>
              A {n(count.reference_count)} · B {n(count.target_count)} ·
              difference {n(count.absolute_difference)}
            </small>
          </button>
          <button type="button" onClick={() => openDimension("keys")}>
            <span>Key Coverage</span>
            <strong>
              {percent(keys.reference_to_target.percentage)} /{" "}
              {percent(keys.target_to_reference.percentage)}
            </strong>
            <small>A → B / B → A · sample</small>
          </button>
          <button type="button" onClick={() => openDimension("integrity")}>
            <span>Duplicate Key Rate</span>
            <strong>
              {m.duplicate_key_rate.map((d: any) => percent(d)).join(" / ")}
            </strong>
            <small>A / B · 0% means no excess duplicate rows</small>
          </button>
          <button
            type="button"
            onClick={() =>
              document
                .getElementById("quality-columns")
                ?.scrollIntoView({ behavior: motion() })
            }
          >
            <span>Column Match Rate</span>
            <strong>
              {result.columns_requiring_review}{" "}
              {result.columns_requiring_review === 1 ? "column" : "columns"}{" "}
              requiring review
            </strong>
            <small>
              {result.column_count} pairs · inspect individual rates
            </small>
          </button>
        </div>
      </Card>
      <Card
        title="Quality dimensions"
        subtitle="Observed indicators and validation status are separate. Lower duplicate and count-difference rates are better."
      >
        <div className="quality-dimensions">
          {quality.dimensions.map((d: any) => (
            <div key={d.id} id={`dimension-${d.id}`}>
              <button
                type="button"
                aria-expanded={dimension === d.id}
                onClick={() => setDimension(dimension === d.id ? "" : d.id)}
              >
                <strong>{d.name}</strong>
                <Status value={d.status} />
              </button>
              {dimension === d.id && (
                <div className="quality-dimension-detail">
                  <p>{d.description}</p>
                  {d.measures.map((measure: any) => (
                    <div key={measure.label}>
                      <span>{measure.label}: </span>
                      <strong>{percent(measure)}</strong>
                      {measure.percentage != null && (
                        <meter
                          aria-label={d.name + " " + measure.label}
                          min={0}
                          max={Math.max(100, Number(measure.percentage))}
                          value={Number(measure.percentage)}
                        />
                      )}
                      {measure.denominator != null && d.id !== "volume" && (
                        <Rate
                          value={measure}
                          showValue={false}
                          lowerIsBetter={measure.lower_is_better}
                        />
                      )}
                    </div>
                  ))}
                  {d.id === "volume" && (
                    <p>
                      Signed difference B − A: {n(count.signed_difference)}. A
                      0% count difference means equal volumes, not equal
                      records.
                    </p>
                  )}
                  {d.id === "integrity" &&
                    m.duplicate_key_rate.map((item: any) => (
                      <p key={item.source}>
                        Source {item.source}:{" "}
                        {item.duplicate_groups ?? "Unavailable"} duplicate
                        groups · {item.null_key_rows ?? "Unavailable"} rows with
                        null key components. {item.columns.join(" + ")}
                      </p>
                    ))}
                  <Explain
                    metric={d.measures[0]}
                    formula={
                      d.id === "volume"
                        ? "B − A; 100 × |B − A| / A"
                        : d.id === "keys"
                          ? "100 × common keys / keys observed in each source"
                          : d.id === "integrity"
                            ? "100 × excess duplicate rows / rows with non-null key components"
                            : d.id === "consistency"
                              ? row.formula
                              : "Frozen column mapping and type compatibility"
                    }
                    description={d.description}
                    scope={
                      d.id === "volume" || d.id === "integrity"
                        ? "entire_selected_scope"
                        : "sample"
                    }
                    tolerances={result.sampling_plan}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Analysis coverage">
        <div className="stats-grid">
          <div>
            <strong>
              {n(count.reference_count)} / {n(count.target_count)}
            </strong>
            <p>Scoped population A / B</p>
          </div>
          <div>
            <strong>{n(keys.selected_keys)}</strong>
            <p>Selected union-key positions</p>
          </div>
          <div>
            <strong>
              {result.sampling_plan.percentage_base
                ? percent(
                    (100 * keys.selected_keys) /
                      result.sampling_plan.percentage_base,
                  )
                : "Not applicable"}
            </strong>
            <p>
              Selected positions / larger scoped row count; not a union sampling
              fraction
            </p>
          </div>
          <div>
            <strong>{percent(row.coverage_percentage)}</strong>
            <p>Evaluation coverage within selected positions</p>
          </div>
        </div>
        <p>
          Counts and key integrity cover the entire scope. Key Coverage, Row
          Match Rate and Column Match Rate describe the selected sample. No
          confidence interval is inferred.
        </p>
        <details>
          <summary>Consistency and limitations</summary>
          {result.warnings.map((w: string, i: number) => (
            <p key={i}>{w}</p>
          ))}
        </details>
      </Card>
      <div id="quality-columns">
        <Card
          title="Column analysis"
          subtitle="Filters, ordering and pagination are applied by the backend"
        >
          <div className="form-grid">
            <label>
              Search columns
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setColumnOffset(0);
                }}
              />
            </label>
            <label>
              Column status
              <select
                aria-label="Column status"
                value={columnStatus}
                onChange={(e) => {
                  setColumnStatus(e.target.value);
                  setColumnOffset(0);
                }}
              >
                {[
                  "all",
                  "passed",
                  "attention",
                  "critical",
                  "not_calculated",
                ].map((v) => (
                  <option key={v} value={v}>
                    {labels[v] ?? v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Order columns
              <select
                aria-label="Order columns"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setColumnOffset(0);
                }}
              >
                <option value="differences">Most differences / unknowns</option>
                <option value="name">Column name</option>
                <option value="match">Lowest match rate</option>
              </select>
            </label>
          </div>
          <ErrorBox error={cols.error} />
          {cols.isPending ? (
            <Loading />
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Column A / B</th>
                      <th>Match rate</th>
                      <th>Differences</th>
                      <th>Status</th>
                      <th>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cols.data?.items.map((c: any) => (
                      <tr key={c.id}>
                        <td>
                          <details>
                            <summary>
                              {c.left_column ?? "Missing"} ↔{" "}
                              {c.right_column ?? "Missing"}
                            </summary>
                            <p>
                              Types: {c.left_type ?? "Missing"} /{" "}
                              {c.right_type ?? "Missing"}
                            </p>
                            <Explain
                              metric={c.metric}
                              formula={
                                c.metric.formula ??
                                "Unavailable: unpaired column"
                              }
                              description="Equal values divided by evaluated positions; a missing record counts as a difference. Unknown values reduce evaluation coverage."
                              tolerances={result.sampling_plan}
                            />
                          </details>
                        </td>
                        <td>
                          <Rate value={c.metric} />
                        </td>
                        <td>
                          {n(c.metric.different_values)}
                          <small className="muted">
                            {" "}
                            · {n(c.metric.not_evaluated)} unknown
                          </small>
                        </td>
                        <td>
                          <Status value={c.status} />
                        </td>
                        <td>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!captured}
                            onClick={() => inspect("all", c.id)}
                          >
                            Inspect column
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                total={cols.data?.total ?? 0}
                offset={columnOffset}
                setOffset={setColumnOffset}
                size={50}
              />
            </>
          )}
        </Card>
      </div>
      <Card
        title="Divergence diagnosis"
        subtitle="Categories can overlap. Counts must not be summed as distinct records."
      >
        <div className="quality-diagnostics">
          {quality.diagnostics.map((d: any) => (
            <div
              key={d.id}
              data-selected={!!d.record_state && state === d.record_state}
            >
              <strong>{d.label}</strong>
              <span>
                {d.count == null ? "Unavailable" : n(d.count)} ·{" "}
                {d.scope.replaceAll("_", " ")}
              </span>
              <Status
                value={
                  d.count == null
                    ? "not_calculated"
                    : d.count
                      ? d.severity
                      : "passed"
                }
              />
              {d.record_state && captured ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={state === d.record_state}
                  onClick={() => inspect(d.record_state)}
                >
                  Inspect records
                </Button>
              ) : (
                <small className="muted">
                  {d.record_state
                    ? "Record evidence unavailable"
                    : "Full-scope / technical diagnostic; individual aligned evidence does not identify these violations."}
                </small>
              )}
            </div>
          ))}
        </div>
      </Card>
      <div id="quality-records">
        <Card
          title="Record inspection"
          subtitle="Frozen evidence from this execution; no source queries are performed"
        >
          <p className={`notice ${captured ? "" : "warning"}`}>
            {(
              {
                not_captured:
                  "Not captured: this historical execution contains aggregated results only.",
                expired:
                  "Expired: individual evidence is removed after 30 days; aggregated metrics remain available.",
                unavailable:
                  "Unavailable: evidence could not be captured for this execution.",
                partial:
                  "Partial capture: evidence limits were reached; the table and download cover captured positions only.",
                available:
                  "Captured sample: this table is not the entire source population.",
              } as Record<string, string>
            )[evidence.status] ?? evidence.status}{" "}
            {evidence.reason?.replaceAll("_", " ")}
          </p>
          {evidence.expires_at && (
            <p>
              Retention: 30 days · expires{" "}
              {new Date(evidence.expires_at).toLocaleString("en-US", {
                timeZone: "America/Sao_Paulo",
              })}{" "}
              · captured {n(evidence.stored_positions)} /{" "}
              {n(evidence.selected_positions)} positions
            </p>
          )}
          {captured && (
            <>
              <div className="form-grid">
                <label>
                  Record state
                  <select
                    aria-label="Record state"
                    value={state}
                    onChange={(e) => inspect(e.target.value, column)}
                  >
                    {[
                      "all",
                      "equal",
                      "different",
                      "only_source",
                      "only_target",
                      "unknown",
                    ].map((v) => (
                      <option key={v} value={v}>
                        {labels[v]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Affected column
                  <select
                    aria-label="Affected column"
                    value={column}
                    onChange={(e) => inspect(state, e.target.value)}
                  >
                    <option value="">All columns</option>
                    {allColumns.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setKeyFilter(keyInput);
                  setRecordOffset(0);
                  setExpanded(null);
                }}
              >
                <label>
                  Exact key (JSON array; strings preserve precision)
                  <input
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    aria-describedby="evidence-key-help"
                  />
                </label>
                <small id="evidence-key-help">
                  Component order:{" "}
                  {result.key_validation[0]?.columns.join(" + ")}. Include every
                  component, preserving case and spaces.
                </small>
                <div className="form-footer">
                  <Button type="submit">Search key</Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setKeyInput("");
                      setKeyFilter("");
                      inspect();
                    }}
                  >
                    Clear filters
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={exporting}
                    onClick={async () => {
                      setExporting(true);
                      setExportError(null);
                      try {
                        const data = await api(
                          `/runs/${run.id}/quality/export?${filters}`,
                        );
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(data, null, 2)], {
                            type: "application/json",
                          }),
                        );
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `evidence-${run.id}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch (error) {
                        setExportError(error);
                      } finally {
                        setExporting(false);
                      }
                    }}
                  >
                    {exporting ? "Preparing…" : "Download captured records"}
                  </Button>
                </div>
              </form>
              <ErrorBox error={records.error || record.error || exportError} />
              {records.isPending ? (
                <Loading />
              ) : records.data?.items.length ? (
                <>
                  <p>
                    {n(records.data.total)} captured records match these
                    filters.
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th>State</th>
                          <th>Affected fields</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.data.items.map((item) => (
                          <Fragment key={item.id}>
                            <tr>
                              <td>
                                {item.key.map((k, i) => (
                                  <span key={i}>
                                    <Value value={k} />
                                    {i < item.key.length - 1 ? " + " : ""}
                                  </span>
                                ))}
                              </td>
                              <td>{labels[item.state]}</td>
                              <td>{item.affected_columns.length}</td>
                              <td>
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-expanded={expanded === item.id}
                                  onClick={() =>
                                    setExpanded(
                                      expanded === item.id ? null : item.id,
                                    )
                                  }
                                >
                                  Inspect record
                                </Button>
                              </td>
                            </tr>
                            {expanded === item.id && (
                              <tr>
                                <td colSpan={4}>
                                  {record.isPending ? (
                                    <Loading />
                                  ) : (
                                    record.data?.id === item.id && (
                                      <table className="evidence-cells">
                                        <thead>
                                          <tr>
                                            <th>Column A / B</th>
                                            <th>Source A</th>
                                            <th>Source B</th>
                                            <th>State</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {record.data.cells?.map((c: any) => (
                                            <tr
                                              key={c.id}
                                              className={
                                                c.status === "different"
                                                  ? "evidence-different"
                                                  : ""
                                              }
                                            >
                                              <td>
                                                {c.left_column ?? "Missing"} ↔{" "}
                                                {c.right_column ?? "Missing"}
                                              </td>
                                              <td>
                                                <Value value={c.left} />
                                              </td>
                                              <td>
                                                <Value value={c.right} />
                                              </td>
                                              <td>{labels[c.status]}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    total={records.data.total}
                    offset={recordOffset}
                    setOffset={(v) => {
                      setRecordOffset(v);
                      setExpanded(null);
                    }}
                    size={50}
                  />
                </>
              ) : (
                <Empty title="No captured records match these filters" />
              )}
            </>
          )}
        </Card>
      </div>
    </section>
  );
}
