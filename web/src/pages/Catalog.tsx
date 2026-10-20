import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Database, Play, RefreshCw, Trash2 } from "lucide-react";
import { DeleteDatasetDialog } from "../components/DeleteDatasetDialog";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { api, allPages, post, type Model, type Page } from "../api";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  JsonView,
  Loading,
  PageTitle,
  Pagination,
  percent,
  Stat,
} from "../components/common";
const running = (r: any) => r?.status === "queued" || r?.status === "running";
export function Catalog() {
  const [connection, setConnection] = useState("");
  const [catalog,setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [offset, setOffset] = useState(0);
  const [datasetOffset, setDatasetOffset] = useState(0);
  const [deleting, setDeleting] = useState<Model<"DatasetOut"> | null>(null);
  const connectionSelect = useRef<HTMLSelectElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const cache = useQueryClient();
  const connections = useQuery({
    queryKey: ["catalog-connections"],
    queryFn: () => allPages<Model<"ConnectionOut">>("/connections"),
  });
  const databricks = connections.data?.items.find(c=>c.id===connection)?.connector === "databricks";
  const catalogs = useQuery({queryKey:["catalogs",connection],queryFn:()=>allPages<string>(`/connections/${connection}/catalogs`),enabled:!!connection && databricks});
  const schemas = useQuery({
    queryKey: ["schemas", connection, catalog],
    queryFn: () => allPages<string>(`/connections/${connection}/schemas${databricks ? "?catalog="+encodeURIComponent(catalog) : ""}`),
    enabled: !!connection && (!databricks || !!catalog),
  });
  const tables = useQuery({
    queryKey: ["tables", connection, catalog, schema, offset],
    queryFn: () =>
      api<Page<Model<"TableOut">>>(
        `/connections/${connection}/tables?limit=20&offset=${offset}${databricks ? "&catalog="+encodeURIComponent(catalog) : ""}${schema ? "&schema=" + encodeURIComponent(schema) : ""}`,
      ),
    enabled: !!connection && (!databricks || !!catalog && !!schema),
  });
  const datasets = useQuery({
    queryKey: ["datasets", datasetOffset],
    queryFn: () =>
      api<Page<Model<"DatasetOut">>>(
        "/datasets?limit=20&offset=" + datasetOffset,
      ),
  });
  return (
    <>
      <PageTitle
        title="Catalog"
        subtitle="Explore live source metadata and register tables for profiling and comparison."
      />
      <ErrorBox
        error={
          error ||
          connections.error ||
          catalogs.error ||
          schemas.error ||
          tables.error ||
          datasets.error
        }
      />
      <Card title="Source catalog">
        <div className="form-grid">
          <label>
            Connection
            <select
              ref={connectionSelect}
              aria-label="Connection"
              value={connection}
              onChange={(e) => {
                setConnection(e.target.value);
                setCatalog("");
                setSchema("");
                setOffset(0);
              }}
            >
              <option value="">Select a connection</option>
              {connections.data?.items
                .filter((c) => c.is_active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          {databricks && <label>Catalog<select aria-label="Unity catalog" value={catalog} onChange={e=>{setCatalog(e.target.value);setSchema("");setOffset(0);}}>
            <option value="">Select a catalog</option>{catalogs.data?.items.map(c=><option key={c}>{c}</option>)}
          </select></label>}
          <label>
            Schema
            <select
              aria-label="Schema"
              value={schema}
              disabled={!connection || databricks && !catalog}
              onChange={(e) => {
                setSchema(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">{databricks ? "Select a schema" : "All schemas"}</option>
              {schemas.data?.items.filter(Boolean).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        {!connection ? (
          <Empty title="Choose a source">
            Only table metadata is queried. No rows are displayed.
          </Empty>
        ) : databricks && (!catalog || !schema) ? <Empty title="Choose a catalog and schema">Select the Unity Catalog location to list tables and views.</Empty> : tables.isPending ? (
          <Loading />
        ) : tables.data?.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Schema</th>
                    <th>Table / view</th>
                    {databricks && <th>Type</th>}
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.data.items.map((t) => (
                    <tr key={t.schema_name + "." + t.table_name}>
                      <td>{[t.catalog_name,t.schema_name].filter(Boolean).join(".") || "—"}</td>
                      <td>
                        <Database size={15} /> {t.table_name}
                      </td>
                      {databricks && <td>{t.table_type}</td>}
                      <td>
                        <Button
                          variant="outline"
                          disabled={!!busy}
                          onClick={async () => {
                            setBusy(t.table_name);
                            setError(null);
                            try {
                              await post("/datasets", {
                                connection_id: connection,
                                catalog_name:t.catalog_name, schema_name:t.schema_name, table_name:t.table_name,
                              });
                              await cache.invalidateQueries({
                                queryKey: ["datasets"],
                              });
                            } catch (e) {
                              setError(e);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          {busy === t.table_name
                            ? "Registering…"
                            : "Register dataset"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={tables.data.total}
              offset={offset}
              setOffset={setOffset}
            />
          </>
        ) : (
          <Empty title="No tables available">
            Check the selected schema and source permissions.
          </Empty>
        )}
      </Card>
      <Card
        title="Registered datasets"
        subtitle="Open a dataset to inspect metadata and calculate a fresh profile."
      >
        {datasets.isPending ? (
          <Loading />
        ) : datasets.data?.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Table / view</th>
                    <th>Type</th>
                    <th>Location</th>
                    <th>Metadata</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {datasets.data.items.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link to={"/datasets/" + d.id}>{d.table_name}</Link>
                      </td>
                      <td>{(d.metadata as any)?.table_type ?? "—"}</td>
                      <td>{[d.catalog_name,d.schema_name].filter(Boolean).join(".") || "—"}</td>
                      <td>
                        {Object.keys((d.metadata as any)?.columns ?? {}).length}{" "}
                        columns
                      </td>
                      <td>
                        <Button variant="outline" onClick={() => setDeleting(d)}>
                          <Trash2 size={16} aria-hidden="true" /> Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={datasets.data.total}
              offset={datasetOffset}
              setOffset={setDatasetOffset}
            />
          </>
        ) : (
          <Empty title="No registered datasets">
            Choose a table from the source catalog.
          </Empty>
        )}
      </Card>
      {deleting && <DeleteDatasetDialog dataset={deleting}
        onClose={() => setDeleting(null)}
        returnFocus={() => connectionSelect.current}
        onDeleted={() => {
          setDeleting(null);
          setDatasetOffset(0);
          for (const key of ["datasets", "wizard-datasets", "connections", "catalog-connections", "connection-dependencies", "runs", "overview"])
            void cache.invalidateQueries({queryKey:[key]});
          cache.removeQueries({queryKey:["dataset", deleting.id]});
          cache.removeQueries({queryKey:["profile-runs", deleting.id]});
        }} />}
    </>
  );
}
export function DatasetProfile() {
  const { id } = useParams();
  const [selected, setSelected] = useState("");
  const [column, setColumn] = useState("");
  const [metric, setMetric] = useState("mean");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [metricOffset, setMetricOffset] = useState(0);
  const [profileOffset, setProfileOffset] = useState(0);
  const cache = useQueryClient();
  const dataset = useQuery({
    queryKey: ["dataset", id],
    queryFn: () => api<Model<"DatasetOut">>("/datasets/" + id),
  });
  const runs = useQuery({
    queryKey: ["profile-runs", id],
    queryFn: () =>
      api<Page<Model<"RunOut">>>("/runs?dataset_id=" + id + "&limit=200"),
    refetchInterval: (q) => (q.state.data?.items.some(running) ? 2000 : false),
  });
  const active = selected || runs.data?.items[0]?.id;
  const current = runs.data?.items.find((r) => r.id === active);
  useEffect(() => {
    if (current?.status === "succeeded") {
      void cache.invalidateQueries({ queryKey: ["dataset", id] });
      void cache.invalidateQueries({ queryKey: ["metrics", id] });
    }
  }, [current?.id, current?.status, cache, id]);
  const result = useQuery({
    queryKey: ["result", active],
    queryFn: () => api<Model<"ResultOut">>(`/runs/${active}/result`),
    enabled: current?.status === "succeeded",
  });
  const profiles = useQuery({
    queryKey: ["profiles", id, active, current?.status, profileOffset],
    queryFn: () =>
      api<Page<Model<"ProfileOut">>>(
        `/datasets/${id}/profiles?run_id=${active}&limit=20&offset=${profileOffset}`,
      ),
    enabled: current?.status === "succeeded",
  });
  const metrics = useQuery({
    queryKey: ["metrics", id, column, metric, metricOffset],
    queryFn: () =>
      api<Page<Model<"MetricOut">>>(
        `/metrics?dataset_id=${id}&limit=200&offset=${metricOffset}&column_name=${encodeURIComponent(column)}&metric_name=${encodeURIComponent(metric)}`,
      ),
    enabled: !!column,
  });
  const metadata = (dataset.data?.metadata as any)?.columns ?? {};
  const overall = (result.data?.result as any)?.indicators?.quality?.overall;
  const observed = (result.data?.result as any)?.sources?.[0];
  const tableMetadata = dataset.data?.metadata as any;
  return (
    <>
      <PageTitle
        title={dataset.data?.table_name ?? "Dataset profile"}
        subtitle={[dataset.data?.catalog_name,dataset.data?.schema_name,dataset.data?.table_name].filter(Boolean).join(".")+" · Descriptive statistics from observed samples. No record correspondence is asserted."}
        eyebrow="DATA QUALITY / CATALOG"
        action={
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await post(`/datasets/${id}/refresh`);
                  await cache.invalidateQueries({ queryKey: ["dataset", id] });
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw size={16} />
              Refresh metadata
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await post<Model<"RunOut">>(
                    `/datasets/${id}/profile-runs`,
                    {},
                    crypto.randomUUID(),
                  );
                  setSelected(r.id);
                  await cache.invalidateQueries({
                    queryKey: ["profile-runs", id],
                  });
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Play size={16} />
              Run profile
            </Button>
          </>
        }
      />
      <ErrorBox
        error={
          error ||
          dataset.error ||
          runs.error ||
          result.error ||
          profiles.error ||
          metrics.error
        }
      />
      {dataset.isPending ? (
        <Loading />
      ) : (
        <>
          <div className="stats-grid four">
            <Stat label="Columns" value={Object.keys(metadata).length} />
            <Stat
              label="Estimated source rows"
              value={String(
                (dataset.data?.metadata as any)?.estimated_rows ??
                  "Unavailable",
              )}
              detail="Whole-table catalog estimate; may be stale. Not the number of sampled rows."
            />
            <Stat label="Sample quality" value={percent(overall?.percentage)} />
            <Stat
              label="Evaluation coverage"
              value={percent(overall?.coverage_percentage)}
            />
          </div>
          {tableMetadata?.table_details && <TableDetails details={tableMetadata.table_details} title="Current table details" />}
          <Card title="Column metadata">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Nullable</th>
                    <th>Key</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(metadata).map(
                    ([name, info]: [string, any]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{info.type}</td>
                        <td>{String(info.nullable)}</td>
                        <td>
                          {info.primary_key
                            ? "Primary key"
                            : info.unique_groups?.length
                              ? "Unique"
                              : "—"}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </Card>
          <Card
            title="Calculated profiles"
            subtitle="Select an execution. Historical results are not substituted for current source data."
          >
            <label>
              Profile execution
              <select
                aria-label="Profile execution"
                value={active ?? ""}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setProfileOffset(0);
                }}
              >
                <option value="">Select a run</option>
                {runs.data?.items.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.requested_at).toLocaleString("en-US")} ·{" "}
                    {r.status} · {r.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            {current && (
              <div className="inline-info">
                <Badge value={current.status} />
                <Link to={"/runs/" + current.id}>Open execution</Link>
              </div>
            )}
            {current?.status === "succeeded" && observed && <>
              <p className="notice">Selected execution: <strong>{observed.sample_size} sampled rows</strong>. Source row estimate at execution: <strong>{observed.estimated_rows ?? "Unavailable"}</strong>. Statistics below describe this sample.</p>
              {observed.table_details && <TableDetails details={observed.table_details} title="Table details captured for this execution" />}
            </>}
            {current?.status === "failed" && (
              <p className="notice warning">
                {current.error_code}: Unable to complete profiling. Check the
                source and worker before requesting a new run.
              </p>
            )}
            {profiles.isFetching ? (
              <Loading />
            ) : profiles.data?.items.length ? (
              <>
                <div className="profile-grid">
                  {profiles.data.items.map((p) => (
                    <article className="column-profile" key={p.id}>
                      <h3>{p.column_name}</h3>
                      <ProfileStatistics value={p.profile} />
                    </article>
                  ))}
                </div>
                <Pagination
                  total={profiles.data.total}
                  offset={profileOffset}
                  setOffset={setProfileOffset}
                />
              </>
            ) : (
              <Empty
                title={
                  running(current)
                    ? "Profiling in progress"
                    : "No calculated profiles"
                }
              >
                The worker processes requests in the background.
              </Empty>
            )}
          </Card>
          <Card
            title="Metric history"
            subtitle="Numeric series over the last 30 days. Exact values remain strings in the table."
          >
            <div className="form-grid">
              <label>
                Column
                <select
                  aria-label="Column"
                  value={column}
                  onChange={(e) => {
                    setColumn(e.target.value);
                    setMetricOffset(0);
                  }}
                >
                  <option value="">Select column</option>
                  {Object.keys(metadata).map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label>
                Metric
                <input
                  value={metric}
                  onChange={(e) => {
                    setMetric(e.target.value);
                    setMetricOffset(0);
                  }}
                  placeholder="mean"
                />
              </label>
            </div>
            {metrics.data?.items.length ? (
              <>
                <div className="chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={[...metrics.data.items]
                        .reverse()
                        .map((m) => ({
                          ...m,
                          chartValue: m.value === null ? null : Number(m.value),
                        }))}
                    >
                      <CartesianGrid stroke="var(--semantic-border-default)" />
                      <XAxis
                        dataKey="measured_at"
                        tickFormatter={(v) =>
                          new Date(v).toLocaleDateString("en-US")
                        }
                      />
                      <YAxis />
                      <Tooltip />
                      <Line
                        dataKey="chartValue"
                        name={metric}
                        stroke="var(--semantic-chart-series-2)"
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Measured at</th>
                        <th>Metric</th>
                        <th>Exact value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.data.items.map((m) => (
                        <tr key={m.id}>
                          <td>
                            {new Date(m.measured_at).toLocaleString("en-US")}
                          </td>
                          <td>{m.metric_name}</td>
                          <td>{m.value ?? "Not evaluated"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  total={metrics.data.total}
                  offset={metricOffset}
                  setOffset={setMetricOffset}
                  size={200}
                />
              </>
            ) : (
              <Empty title="No numeric series selected">
                Select a column and a metric available in the profile.
              </Empty>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function ProfileStatistics({ value }: { value: any }) {
  const m = value.metrics ?? {};
  const fields = [
    "sample_count",
    "null_count",
    "null_rate",
    "non_null_count",
    "blank_count",
    "blank_rate",
    "distinct_count",
    "distinct_rate",
    "duplicate_count",
    "duplicate_rate",
    "text_length_min",
    "text_length_max",
    "text_length_mean",
    "temporal_count",
    "temporal_min",
    "temporal_max",
    "temporal_timezone",
    "unavailable_count",
    "unsupported_count",
    "min",
    "max",
    "mean",
    "median",
    "stddev",
    "q25",
    "q75",
  ];
  const numeric = ["integer", "decimal", "float"].includes(m.family);
  const points = ["min", "q25", "median", "q75", "max"]
    .filter((k) => m[k] !== null && m[k] !== undefined)
    .map((k) => ({ label: k, value: Number(m[k]) }));
  return (
    <>
      <div className="inline-info">
        <Badge value={m.family ?? m.type} />
        <span className="muted small">Observed sample statistics</span>
      </div>
      <dl className="profile-statistics">
        {fields
          .filter((k) => m[k] !== undefined && m[k] !== null)
          .map((k) => (
            <div key={k}>
              <dt>{k.replaceAll("_", " ")}</dt>
              <dd>{k.endsWith("_rate") ? percent(m[k] == null ? null : Number(m[k]) * 100) : String(m[k])}</dd>
            </div>
          ))}
      </dl>
      {m.family === "text" && <p className="muted small">Declared as text. Numeric mean, median and numeric distribution do not apply; values are not automatically converted.</p>}
      {numeric && points.length > 1 && (
        <div
          className="column-chart"
          role="img"
          aria-label="Numeric sample distribution summary"
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points}>
              <XAxis dataKey="label" />
              <YAxis width={45} />
              <Tooltip />
              <Line
                isAnimationActive={false}
                dataKey="value"
                stroke="var(--semantic-chart-series-2)"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <details>
        <summary className="small">Full aggregate evidence</summary>
        <JsonView value={value} />
      </details>
    </>
  );
}

function TableDetails({ details, title }: { details: any; title: string }) {
  const unknown = "Unavailable";
  const fields: [string, string][] = [
    ["Object type", details.type ?? unknown],
    ["Format", details.provider ?? unknown],
    ["Size (bytes, catalog statistics)", details.size_in_bytes == null ? unknown : String(details.size_in_bytes)],
    ["Created at", details.created_time ? new Date(details.created_time).toLocaleString("en-US") : unknown],
    ["Partition columns", Array.isArray(details.partition_columns) ? details.partition_columns.join(", ") || "None" : unknown],
    ["Estimate source", details.estimate_source === "databricks_optimizer_statistics" ? "Databricks optimizer statistics" : unknown],
    ["Metadata collected at", details.collected_at ? new Date(details.collected_at).toLocaleString("en-US") : unknown],
  ];
  return <Card title={title} subtitle="Whole-table metadata. The collection time is not the last update time of the source statistics.">
    <dl className="profile-statistics">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {details.estimate_status !== "available" && <p className="muted small">Row estimate unavailable ({details.estimate_status}). No full table count is run automatically.</p>}
    {details.status !== "available" && <p className="notice warning">Extended table metadata is {details.status}. Available column metadata and sample profiling are preserved.</p>}
  </Card>;
}
