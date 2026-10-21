import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, ArrowLeft } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { BusinessQualityResult } from "../components/BusinessQuality";
import { ComparisonRunAnimation } from "../components/ComparisonRunAnimation";
import { FrozenComparisonContext } from "../components/ComparisonOptionsEditor";
import { AnalysisNotice, EvaluationValue, SourceProfiles, evaluationReason } from "../components/Evaluation";
import { api, type Model, type Page } from "../api";
import {
  Badge,
  Button,
  Card,
  date,
  Empty,
  ErrorBox,
  JsonView,
  Loading,
  PageTitle,
  Pagination,
  percent,
  RunsTable,
  Stat,
} from "../components/common";
const savedProfileWarnings: Record<string, string> = {
  "Perfil amostral descritivo; não representa toda a população.": "Descriptive sample profile; it does not represent the entire population.",
  "A ordenação aleatória pode percorrer a tabela inteira; o limite de linhas não limita esse custo.": "Random ordering may scan the entire table; the row limit does not bound this cost.",
};
export function Runs() {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["runs", status, offset],
    queryFn: () =>
      api<Page<Model<"RunOut">>>(
        `/runs?limit=20&offset=${offset}${status ? "&status=" + status : ""}`,
      ),
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => ["queued", "running"].includes(r.status))
        ? 2000
        : false,
  });
  return (
    <>
      <PageTitle
        title="Run history"
        subtitle="Track asynchronous profiles and comparisons. Execution state is separate from analytical conclusion."
      />
      <Card>
        <label className="filter-label">
          Execution state
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All states</option>
            {["queued", "running", "succeeded", "failed"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loading />
        ) : q.data?.items.length ? (
          <>
            <RunsTable runs={q.data.items} />
            <Pagination
              total={q.data.total}
              offset={offset}
              setOffset={setOffset}
            />
          </>
        ) : (
          <Empty title="No executions found">
            Request a profile or comparison to start collecting evidence.
          </Empty>
        )}
      </Card>
    </>
  );
}
export function RunResult({ differences = false }: { differences?: boolean }) {
  const { id } = useParams();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => api<Model<"RunOut">>("/runs/" + id),
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.status ?? "") ? 2000 : false,
  });
  const result = useQuery({
    queryKey: ["result", id],
    queryFn: () => api<Model<"ResultOut">>(`/runs/${id}/result`),
    enabled: run.data?.status === "succeeded",
  });
  const r = result.data?.result as any;
  const evaluation = result.data?.evaluation;
  const rows = r?.row_comparisons?.[0];
  const a = r?.indicators?.agreement;
  const q = r?.indicators?.quality?.overall;
  const counts = Object.entries(rows?.different_values ?? {}).map(
    ([column, value]) => ({ column, count: Number(value) }),
  );
  const findings = [
    ...(r?.schema_findings ?? []).map((f: any) => ({
      category: "Schema",
      ...f,
    })),
    ...(r?.quality_findings ?? []).map((f: any) => ({
      category: "Quality",
      ...f,
    })),
    ...(r?.metric_comparisons ?? []).map((f: any) => ({
      category: "Metric",
      ...f,
    })),
    ...counts.map((f) => ({
      category: "Aligned column",
      column: f.column,
      different_values: f.count,
    })),
  ].filter(
    (f) =>
      !filter || JSON.stringify(f).toLowerCase().includes(filter.toLowerCase()),
  );
  function download() {
    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dataqore-run-${id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <PageTitle
        title={differences ? "Aggregate differences" : `Run ${id?.slice(0, 8)}`}
        subtitle={
          differences
            ? "Inspect schema, quality and column-level evidence. Individual records are not stored."
            : "Review the outcome, sampling scope, coverage and configuration frozen for this run."
        }
        eyebrow={
          "DATA QUALITY / " + (differences ? "DIFFERENCES" : "RUN RESULTS")
        }
        action={
          <>
            {differences && (
              <Button asChild variant="outline">
                <Link to={"/runs/" + id}>
                  <ArrowLeft size={16} />
                  Back to results
                </Link>
              </Button>
            )}
            {result.data && (
              <>
                <Button variant="outline" onClick={download}>
                  <Download size={16} />
                  Export JSON
                </Button>
                {!differences && (
                  <Button asChild>
                    <Link to={"/runs/" + id + "/differences"}>
                      Open differences
                    </Link>
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      <ErrorBox error={run.error || result.error} />
      {run.isPending ? (
        <Loading />
      ) : (
        run.data && (
          <>
            <div className="inline-info">
              <Badge value={run.data.status} />
              {result.data && <Badge value={result.data.conclusion} />}
              <span className="muted">
                Requested {date(run.data.requested_at)}
              </span>
            </div>
            {run.data.status === "failed" ? (
              <Card title="Execution failed">
                <p className="notice warning">
                  {run.data.error_code ?? "execution_failed"} · No completed
                  result is available.
                </p>
                <p>
                  Check source access, engine configuration, monthly metric
                  partitions and worker logs. Request a new run after correcting
                  the cause.
                </p>
                {run.data.comparison_id && (
                  <Button asChild>
                    <Link to={"/comparisons/" + run.data.comparison_id}>
                      Open comparison
                    </Link>
                  </Button>
                )}
              </Card>
            ) : run.data.status !== "succeeded" ? (
              <Card>
                {run.data.kind === "comparison" ? (
                  <ComparisonRunAnimation state={run.data.status} />
                ) : (
                  <Empty
                    title={
                      run.data.status === "queued"
                        ? "Waiting for the worker"
                        : "Analysis in progress"
                    }
                  >
                    This page updates every two seconds until execution finishes.
                    Keep the worker process running.
                  </Empty>
                )}
              </Card>
            ) : result.isPending ? (
              <Loading />
            ) : (
              r && (
                <>
                  {differences ? (
                    <>
                      <div className="toolbar">
                        <input
                          className="wide-search"
                          aria-label="Filter observations"
                          placeholder="Filter by column, rule or observation…"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        />
                        <span className="muted">
                          {findings.length} observations
                        </span>
                      </div>
                      <div className="content-columns">
                        <Card title="Observed differences and checks">
                          <p className="muted small">
                            Metric differences can be descriptive only. Review
                            each finding and its scope.
                          </p>
                          {findings.length ? (
                            <div className="table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Category</th>
                                    <th>Column / rule</th>
                                    <th>Evidence</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {findings.map((f: any, i) => (
                                    <tr key={i}>
                                      <td>{f.category}</td>
                                      <td>
                                        {f.column ??
                                          f.column_name ??
                                          f.rule ??
                                          f.field ??
                                          "General"}
                                      </td>
                                      <td>
                                        <Button
                                          variant="ghost"
                                          onClick={() => setSelected(f)}
                                        >
                                          Inspect evidence
                                        </Button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <Empty title="No matching observations" />
                          )}
                        </Card>
                        <Card title="Selected observation">
                          {selected ? (
                            <Observation value={selected} evaluation={evaluation?.comparisons.find(c => c.column === selected.column)?.metrics} />
                          ) : (
                            <Empty title="Select an observation">
                              Evidence contains aggregate counts and statistics.
                            </Empty>
                          )}
                        </Card>
                      </div>
                    </>
                  ) : (
                    <>
                      <AnalysisNotice evaluation={evaluation} />
                      {run.data.kind === "profile" || evaluation?.analysis_kind === "independent" || evaluation?.analysis_kind === "invalid_key" ? (
                        <div className="stats-grid four">
                          <Stat label="Rows observed per source" value={r.sources?.map((s: any) => s.sample_size).join(" / ") ?? "Unavailable"} detail="Observed sample only" />
                          <Stat label="Sample quality" value={<EvaluationValue value={q?.percentage == null ? null : percent(q.percentage)} evaluation={evaluation?.quality} />} />
                          <Stat label="Evaluation coverage" value={<EvaluationValue value={q?.coverage_percentage == null ? null : percent(q.coverage_percentage)} evaluation={evaluation?.quality} />} />
                          <Stat label="Sources" value={r.sources?.length ?? "Unavailable"} />
                        </div>
                      ) : (
                      <div className="stats-grid four">
                        <Stat
                          label="Cell agreement"
                          value={<EvaluationValue value={a?.percentage == null ? null : percent(a.percentage)} evaluation={evaluation?.agreement} />}
                          detail={"Coverage " + percent(a?.coverage_percentage)}
                        />
                        <Stat
                          label="Different sampled rows"
                          value={<EvaluationValue value={rows?.different_rows} evaluation={evaluation?.agreement} />}
                          detail="Only where keys align"
                        />
                        <Stat
                          label="Missing in source sample"
                          value={<EvaluationValue value={rows?.missing_in_reference} evaluation={evaluation?.agreement} />}
                        />
                        <Stat
                          label="Missing in target sample"
                          value={<EvaluationValue value={rows?.missing_in_target} evaluation={evaluation?.agreement} />}
                        />
                      </div>
                      )}
                      <div className="content-columns">
                        {run.data.kind === "profile" || evaluation?.analysis_kind !== "aligned" ? (
                          <Card title="Analysis scope"><p>Statistics below describe the captured sample, using declared column types. No record-level equality is inferred without safe alignment.</p></Card>
                        ) : (
                        <Card
                          title="Differences by column"
                          subtitle="Different values observed in aligned sample positions."
                        >
                          {counts.length ? (
                            <div className="chart">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart layout="vertical" data={counts}>
                                  <CartesianGrid
                                    stroke="var(--semantic-border-default)"
                                    horizontal={false}
                                  />
                                  <XAxis type="number" allowDecimals={false} />
                                  <YAxis
                                    dataKey="column"
                                    type="category"
                                    width={120}
                                  />
                                  <Tooltip />
                                  <Bar
                                    dataKey="count"
                                    name="Different values"
                                    fill="var(--semantic-chart-series-3)"
                                    radius={4}
                                  />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          ) : (
                            <Empty title="No aligned difference counts">
                              Independent profiles do not establish record
                              correspondence.
                            </Empty>
                          )}
                        </Card>
                        )}
                        <Card title="Run metadata">
                          <dl>
                            <dt>Run ID</dt>
                            <dd className="break">{id}</dd>
                            <dt>Kind</dt>
                            <dd>{run.data.kind}</dd>
                            <dt>Started</dt>
                            <dd>{date(run.data.started_at)}</dd>
                            <dt>Finished</dt>
                            <dd>{date(run.data.finished_at)}</dd>
                            <dt>Sample quality</dt>
                            <dd><EvaluationValue value={q?.percentage == null ? null : percent(q.percentage)} evaluation={evaluation?.quality} /></dd>
                            <dt>Quality coverage</dt>
                            <dd><EvaluationValue value={q?.coverage_percentage == null ? null : percent(q.coverage_percentage)} evaluation={evaluation?.quality} /></dd>
                          </dl>
                        </Card>
                      </div>
                      <Card title="Source samples">
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Source</th>
                                <th>Table</th>
                                <th>Observed rows</th>
                                <th>Estimated source rows</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.sources?.map((s: any, i: number) => (
                                <tr key={i}>
                                  <td>{s.connection}</td>
                                  <td>{s.table}</td>
                                  <td>{s.sample_size}</td>
                                  <td>{s.estimated_rows ?? "Unavailable"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="notice">
                          {a?.scope ?? "Observed sample only"}. Counts from
                          samples are not claims about the full source
                          population.
                        </p>
                      </Card>
                      <SourceProfiles result={r} evaluation={evaluation} />
                    </>
                  )}
                  <BusinessQualityResult result={r} />
                  <FrozenComparisonContext result={r} />
                  <Card title="Scope and interpretation">
                    <ul className="warnings">
                      {r.warnings?.map((w: string, i: number) => (
                        <li key={i}>{savedProfileWarnings[w] ?? w}</li>
                      ))}
                    </ul>
                  </Card>
                  <details className="card">
                    <summary>
                      Frozen execution parameters and sampling plan
                    </summary>
                    <JsonView
                      value={{
                        parameters: run.data.parameters,
                        sampling_plan: r.sampling_plan,
                      }}
                    />
                  </details>
                </>
              )
            )}
          </>
        )
      )}
    </>
  );
}

function Observation({ value, evaluation }: { value: any; evaluation?: Record<string, Model<"EvaluationOut">> }) {
  const simple = Object.entries(value).filter(
    ([k, v]) => k !== "category" && v !== null && typeof v !== "object",
  );
  return (
    <>
      <dl>
        {simple.map(([k, v]) => (
          <div className="observation-field" key={k}>
            <dt>{k.replaceAll("_", " ")}</dt>
            <dd>{k === "reason" ? evaluationReason({ status: "not_evaluated", reason: v as Model<"EvaluationOut">["reason"], counts: {} }) : String(v)}</dd>
          </div>
        ))}
      </dl>
      {value.deltas && (
        <>
          <h3>Metric differences</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Exact difference</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(value.deltas).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k.replaceAll("_", " ")}</td>
                    <td><EvaluationValue value={v} evaluation={evaluation?.[k]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <details>
        <summary className="small">Full aggregate evidence</summary>
        <JsonView value={value} />
      </details>
    </>
  );
}
