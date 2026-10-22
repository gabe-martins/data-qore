import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, allPages, post, type Model, type Page } from "../api";
import {
  ScopeEditor,
  MappingEditor,
  ColumnsEditor,
  type ComparisonOptions,
} from "../components/ComparisonOptionsEditor";
import { DeleteComparisonDialog } from "../components/DeleteComparisonDialog";
import { Rate, CriticalMetrics } from "../components/CriticalMetrics";
import { normalizeTolerance } from "../lib/tolerances";
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
  RunsTable,
} from "../components/common";
export function Comparisons() {
  const [offset, setOffset] = useState(0),
    [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["comparisons", offset, search],
    queryFn: () =>
      api<Page<Model<"ComparisonSummaryOut">>>(
        `/comparison-summaries?limit=20&offset=${offset}&search=${encodeURIComponent(search)}`,
      ),
  });
  return (
    <>
      <PageTitle
        title="Comparisons"
        subtitle="Five critical metrics, equivalent scopes and reproducible samples."
        action={
          <Button asChild>
            <Link to="/comparisons/new">New comparison</Link>
          </Button>
        }
      />
      <Card>
        <label>
          Search
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loading />
        ) : q.data?.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Comparison</th>
                    <th>State</th>
                    <th>Row Match Rate</th>
                    <th>Latest run</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/comparisons/${c.id}`}>{c.name}</Link>
                      </td>
                      <td>
                        <Badge value={c.is_active ? "active" : "inactive"} />
                      </td>
                      <td>
                        <Rate value={c.latest_result?.row_match_rate} />
                      </td>
                      <td>
                        <Badge value={c.latest_run?.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={q.data.total}
              offset={offset}
              setOffset={setOffset}
            />
          </>
        ) : (
          <Empty title="No comparisons" />
        )}
      </Card>
    </>
  );
}
export function ComparisonDetail() {
  const { id } = useParams(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const c = useQuery({
    queryKey: ["comparison", id],
    queryFn: () => api<Model<"ComparisonOut">>(`/comparisons/${id}`),
  });
  const [offset, setOffset] = useState(0);
  const runs = useQuery({
    queryKey: ["comparison-runs", id, offset],
    queryFn: () =>
      api<Page<Model<"RunOut">>>(
        `/runs?comparison_id=${id}&limit=20&offset=${offset}`,
      ),
    refetchInterval: 2000,
  });
  const latest = useQuery({
    queryKey: [
      "comparison-latest",
      id,
      runs.data?.items[0]?.status,
      runs.data?.items[0]?.id,
    ],
    queryFn: () =>
      api<Model<"ResultOut">>(`/runs/${runs.data!.items[0].id}/result`),
    enabled: runs.data?.items[0]?.status === "succeeded" && offset === 0,
  });
  return (
    <>
      <PageTitle
        title={c.data?.name ?? "Comparison"}
        subtitle="Definition, critical metrics and execution history."
        action={
          <>
            <Button asChild>
              <Link to={`/comparisons/${id}/edit`}>Edit</Link>
            </Button>
            <Button
              disabled={busy || !c.data?.is_active}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const run = await post<Model<"RunOut">>(
                    `/comparisons/${id}/runs`,
                    {},
                  );
                  navigate(`/runs/${run.id}`);
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Run comparison
            </Button>
          </>
        }
      />
      <ErrorBox error={error || c.error || runs.error || latest.error} />
      {c.isPending ? (
        <Loading />
      ) : (
        c.data && (
          <>
            <Card title="Definition">
              <Badge value={c.data.is_active ? "active" : "inactive"} />
              <p>
                Sample: {c.data.sampling_options?.method} ·{" "}
                {c.data.sampling_options?.method === "percentage"
                  ? `${c.data.sampling_options?.percentage}% of the larger scope`
                  : `${c.data.sampling_options?.rows} keys`}
              </p>
              <div className="form-grid comparison-settings">
                <p>
                  <strong>Comparison key</strong>
                  <span>
                    {c.data.comparison_options?.business_key
                      ?.map((p) => `${p.left} ↔ ${p.right}`)
                      .join(", ") || "Discovered from metadata"}
                  </span>
                </p>
                <p>
                  <strong>Data scope</strong>
                  <span>
                    {c.data.comparison_options?.scope?.period
                      ? "Configured period"
                      : "Entire table"}
                    {c.data.comparison_options?.scope?.filters?.length
                      ? " · equivalent filters applied"
                      : ""}
                  </span>
                </p>
                <p>
                  <strong>Excluded columns</strong>
                  <span>
                    A:{" "}
                    {c.data.comparison_options?.excluded_columns?.left?.join(
                      ", ",
                    ) || "None"}{" "}
                    · B:{" "}
                    {c.data.comparison_options?.excluded_columns?.right?.join(
                      ", ",
                    ) || "None"}
                  </span>
                </p>
                <p>
                  <strong>Timestamp interpretation</strong>
                  <span>
                    {Object.entries(
                      c.data.comparison_options?.timestamp_timezones ?? {},
                    )
                      .flatMap(([side, zones]) =>
                        Object.entries(zones).map(
                          ([column, zone]) =>
                            `${side === "left" ? "A" : "B"}.${column}: ${zone}`,
                        ),
                      )
                      .join(" · ") || "No explicit overrides"}
                  </span>
                </p>
                <p>
                  <strong>Numeric equality</strong>
                  <span>
                    Absolute tolerance: {String(c.data.absolute_tolerance ?? 0)}{" "}
                    · relative: {String(c.data.relative_tolerance ?? 0)}{" "}
                    (fraction)
                  </span>
                </p>
                <p>
                  <strong>Sample seed</strong>
                  <span>
                    {String(
                      c.data.sampling_options?.seed ??
                        "Generated on each execution",
                    )}
                  </span>
                </p>
              </div>
              <details>
                <summary>Scope, mapping and tolerances</summary>
                <JsonView value={c.data} />
              </details>
              <div className="form-footer">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await api(`/comparisons/${id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ is_active: !c.data!.is_active }),
                      });
                      await cache.invalidateQueries({
                        queryKey: ["comparison", id],
                      });
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  {c.data.is_active ? "Deactivate" : "Activate"}
                </Button>
                <Button
                  variant="outline"
                  ref={trigger}
                  onClick={() => setDeleting(true)}
                >
                  Delete comparison
                </Button>
              </div>
            </Card>
            {latest.data && <CriticalMetrics result={latest.data.result} />}
            <Card title="Execution history">
              {runs.data?.items.length ? (
                <>
                  <RunsTable runs={runs.data.items} />
                  <Pagination
                    total={runs.data.total}
                    offset={offset}
                    setOffset={setOffset}
                  />
                </>
              ) : (
                <Empty title="No runs" />
              )}
            </Card>
            {deleting && (
              <DeleteComparisonDialog
                comparison={c.data}
                onClose={() => setDeleting(false)}
                returnFocus={() => trigger.current}
                onDeleted={() => {
                  cache.invalidateQueries({ queryKey: ["comparisons"] });
                  navigate("/comparisons");
                }}
              />
            )}
          </>
        )
      )}
    </>
  );
}
export function Wizard() {
  const { id } = useParams(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const [step, setStep] = useState(0),
    [name, setName] = useState("");
  const [left, setLeft] = useState(""),
    [right, setRight] = useState("");
  const [options, setOptions] = useState<ComparisonOptions>({});
  const [method, setMethod] = useState<"rows" | "percentage">("rows"),
    [rows, setRows] = useState(1000),
    [percentage, setPercentage] = useState("10"),
    [seed, setSeed] = useState("");
  const [absolute, setAbsolute] = useState("0"),
    [relative, setRelative] = useState("0"),
    [maxCells, setMaxCells] = useState(100000),
    [maxBytes, setMaxBytes] = useState(16777216);
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<Model<"ComparisonPreviewOut"> | null>(
      null,
    );
  const datasets = useQuery({
    queryKey: ["all-datasets"],
    queryFn: () => allPages<Model<"DatasetOut">>("/datasets"),
  });
  const current = useQuery({
    queryKey: ["comparison", id],
    queryFn: () => api<Model<"ComparisonOut">>(`/comparisons/${id}`),
    enabled: !!id,
  });
  useEffect(() => {
    const c = current.data;
    if (!c) return;
    setName(c.name);
    setLeft(c.left_dataset_id);
    setRight(c.right_dataset_id);
    setOptions(c.comparison_options ?? {});
    setMethod(c.sampling_options?.method ?? "rows");
    setRows(c.sampling_options?.rows ?? 1000);
    setPercentage(String(c.sampling_options?.percentage ?? 10));
    setSeed(
      c.sampling_options?.seed == null ? "" : String(c.sampling_options?.seed),
    );
    setAbsolute(String(c.absolute_tolerance));
    setRelative(String(c.relative_tolerance));
    setMaxCells(c.sampling_options?.max_cells ?? 100000);
    setMaxBytes(c.sampling_options?.max_sample_bytes ?? 16777216);
  }, [current.data]);
  const columns = (identifier: string) =>
    (datasets.data?.items.find((d) => d.id === identifier)?.metadata.columns ??
      {}) as Record<string, any>;
  function payload() {
    return {
      name,
      left_dataset_id: left,
      right_dataset_id: right,
      comparison_options: options,
      absolute_tolerance: normalizeTolerance(absolute),
      relative_tolerance: normalizeTolerance(relative),
      sampling_options: {
        method,
        rows,
        percentage:
          method === "percentage" ? normalizeTolerance(percentage) : null,
        seed: seed || null,
        max_cells: maxCells,
        max_sample_bytes: maxBytes,
      },
    };
  }
  async function review() {
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await post<Model<"ComparisonPreviewOut">>(
          "/comparisons/preview",
          payload(),
        ),
      );
      setStep(3);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function save(run: boolean) {
    setBusy(true);
    setError(null);
    try {
      const c = await api<Model<"ComparisonOut">>(
        id ? `/comparisons/${id}` : "/comparisons",
        { method: id ? "PATCH" : "POST", body: JSON.stringify(payload()) },
      );
      await cache.invalidateQueries({ queryKey: ["comparisons"] });
      if (run) {
        const r = await post<Model<"RunOut">>(`/comparisons/${c.id}/runs`, {});
        navigate(`/runs/${r.id}`);
      } else navigate(`/comparisons/${c.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        title={id ? "Edit comparison" : "New comparison"}
        subtitle={`Step ${step + 1} of 4 · ${["Sources and scope", "Columns and timezones", "Identity and sample", "Review"][step]}`}
      />
      <ErrorBox error={error || datasets.error || current.error} />
      {datasets.isPending || (id && current.isPending) ? (
        <Loading />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (step < 2) setStep(step + 1);
            else if (step === 2) void review();
            else void save(false);
          }}
        >
          {step === 0 && (
            <>
              <Card title="Sources">
                <label>
                  Name
                  <input
                    required
                    maxLength={255}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <div className="form-grid">
                  {([left, right] as string[]).map((v, i) => (
                    <label key={i}>
                      Source {i ? "B" : "A"}
                      <select
                        aria-label={`Source ${i ? "B" : "A"}`}
                        required
                        value={v}
                        onChange={(e) => {
                          (i ? setRight : setLeft)(e.target.value);
                          setOptions({});
                        }}
                      >
                        <option value="">Choose dataset</option>
                        {datasets.data?.items
                          .filter((d) => d.id !== (i ? left : right))
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {[d.catalog_name, d.schema_name, d.table_name]
                                .filter(Boolean)
                                .join(".")}{" "}
                              · {d.id.slice(0, 8)}
                            </option>
                          ))}
                      </select>
                    </label>
                  ))}
                </div>
              </Card>
              <ScopeEditor
                value={options}
                onChange={setOptions}
                left={columns(left)}
                right={columns(right)}
              />
            </>
          )}
          {step === 1 && (
            <ColumnsEditor
              value={options}
              onChange={setOptions}
              left={columns(left)}
              right={columns(right)}
            />
          )}
          {step === 2 && (
            <>
              <MappingEditor
                value={options}
                onChange={setOptions}
                left={Object.fromEntries(
                  Object.entries(columns(left)).filter(
                    ([name]) => !options.excluded_columns?.left?.includes(name),
                  ),
                )}
                right={Object.fromEntries(
                  Object.entries(columns(right)).filter(
                    ([name]) =>
                      !options.excluded_columns?.right?.includes(name),
                  ),
                )}
              />
              <Card
                title="Reproducible random sample"
                subtitle="The same selected keys are fetched in both sources. Selection scans all eligible keys; at most 10,000 keys are compared."
              >
                <label>
                  Sample size
                  <select
                    aria-label="Sample size"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as typeof method)}
                  >
                    <option value="rows">Number of keys</option>
                    <option value="percentage">
                      Percentage of larger scope
                    </option>
                  </select>
                </label>
                {method === "rows" ? (
                  <label>
                    Keys
                    <input
                      type="number"
                      required
                      min={1}
                      max={10000}
                      step={1}
                      value={rows}
                      onChange={(e) => setRows(Number(e.target.value))}
                    />
                  </label>
                ) : (
                  <label>
                    Percentage
                    <input
                      required
                      inputMode="decimal"
                      value={percentage}
                      onChange={(e) => setPercentage(e.target.value)}
                    />
                  </label>
                )}
                <label>
                  Seed (optional)
                  <input
                    inputMode="numeric"
                    pattern="[0-9]{1,20}"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    placeholder="Generated when queued"
                  />
                </label>
                <p className="notice">
                  Same seed, scope and unchanged key set reproduce the
                  selection. Values may change. Percentage uses the larger
                  source row count, not the union size.
                </p>
              </Card>
              <Card title="Numeric tolerances">
                <div className="form-grid">
                  <label>
                    Absolute tolerance
                    <input
                      required
                      value={absolute}
                      onChange={(e) => setAbsolute(e.target.value)}
                    />
                  </label>
                  <label>
                    Relative tolerance (fraction)
                    <input
                      required
                      value={relative}
                      onChange={(e) => setRelative(e.target.value)}
                    />
                  </label>
                </div>
                <p>
                  Zero means exact numeric equality. Relative tolerance uses a
                  fraction: 0.1 means 10%; 10 means 1,000%.
                </p>
                <details>
                  <summary>Capture budgets</summary>
                  <label>
                    Maximum cells (both sources)
                    <input
                      type="number"
                      required
                      min={1}
                      value={maxCells}
                      onChange={(e) => setMaxCells(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Maximum captured bytes
                    <input
                      type="number"
                      required
                      min={1}
                      value={maxBytes}
                      onChange={(e) => setMaxBytes(Number(e.target.value))}
                    />
                  </label>
                </details>
              </Card>
            </>
          )}
          {step === 3 && preview && (
            <Card title="Review">
              <p>
                {name} · {preview.sample_target} requested keys · scoped rows{" "}
                {preview.scope_counts.join(" / ")}
              </p>
              <p>
                Comparison key:{" "}
                {(preview.business_key.length
                  ? preview.business_key
                  : preview.suggested_business_key
                )
                  .map((p) => `${p.left} ↔ ${p.right}`)
                  .join(", ") || "Unavailable — choose a business key"}
              </p>
              <p>
                Preview counts are provisional. Execution validates key
                uniqueness and freezes its own counts and selection.
              </p>
              <p>
                Excluded columns A:{" "}
                {preview.excluded_columns?.left?.join(", ") || "None"} · B:{" "}
                {preview.excluded_columns?.right?.join(", ") || "None"}
              </p>
              <p>
                Timestamp interpretation:{" "}
                {Object.entries(preview.timestamp_timezones ?? {})
                  .flatMap(([side, zones]) =>
                    Object.entries(zones).map(
                      ([column, zone]) =>
                        `${side === "left" ? "A" : "B"}.${column}: ${zone}`,
                    ),
                  )
                  .join(" · ") || "No explicit overrides"}
              </p>
              <JsonView value={preview} />
              <p>Save the definition or save and run now.</p>
            </Card>
          )}
          <div className="form-footer">
            {step > 0 && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setStep(step - 1)}
              >
                Back
              </Button>
            )}
            <Button type="submit" disabled={busy}>
              {busy
                ? "Working…"
                : step === 3
                  ? "Save comparison"
                  : step === 2
                    ? "Review"
                    : "Next"}
            </Button>
            {step === 3 && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Save and run
              </Button>
            )}
          </div>
        </form>
      )}
    </>
  );
}
