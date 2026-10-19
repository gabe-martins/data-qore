import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  GitCompareArrows,
  Play,
  Check,
  ArrowRight,
} from "lucide-react";
import { api, allPages, patch, post, type Model, type Page } from "../api";
import {
  normalizeTolerance,
  fractionToPercent,
  percentToFraction,
} from "../lib/tolerances";
import { ToleranceHelp } from "../components/ToleranceHelp";
import {
  ScopeEditor,
  MappingEditor,
  ScopeSummary,
  FrozenComparisonContext,
  type ComparisonOptions,
} from "../components/ComparisonOptionsEditor";
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
  RunsTable,
  Stat,
} from "../components/common";
const defaults = {
  pilot_rows: 64,
  min_rows: 64,
  max_rows: 1000,
  max_cells: 100000,
  max_sample_bytes: 16777216,
  proportion_margin: 0.05,
};
export function Comparisons() {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["comparisons", search, offset],
    queryFn: () =>
      api<Page<Model<"ComparisonSummaryOut">>>(
        `/comparison-summaries?limit=20&offset=${offset}&search=${encodeURIComponent(search)}`,
      ),
  });
  return (
    <>
      <PageTitle
        title="Comparisons"
        subtitle="Validate source and target data with sample evidence and reusable settings."
      />
      <div className="toolbar">
        <div className="search">
          <Search size={19} />
          <input
            aria-label="Search comparisons"
            placeholder="Search comparisons…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <Button asChild>
          <Link to="/comparisons/new">
            <Plus size={18} />
            New comparison
          </Link>
        </Button>
      </div>
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loading />
      ) : q.data?.items.length ? (
        q.data.items.map((c) => (
          <Card key={c.id}>
            <div className="card-heading">
              <div className="resource-title">
                <span className="resource-icon">
                  <GitCompareArrows />
                </span>
                <div>
                  <h2>
                    <Link to={"/comparisons/" + c.id}>{c.name}</Link>
                  </h2>
                  <span className="muted">
                    {c.mode.replaceAll("_", " ")} · Sample comparison
                  </span>
                </div>
              </div>
              <div className="actions">
                <Badge value={c.is_active ? "active" : "inactive"} />
                <Button asChild variant="outline">
                  <Link to={`/comparisons/${c.id}/edit`}>Edit</Link>
                </Button>
              </div>
            </div>
            <dl className="comparison-facts">
              <dt>Execution</dt>
              <dd><Link to={"/schedules?comparison_id=" + c.id}>Manual / schedules</Link></dd>
              <dt>Status</dt>
              <dd>
                <button
                  className={"switch " + (c.is_active ? "on" : "")}
                  aria-label={"Activate " + c.name}
                  role="switch"
                  aria-checked={c.is_active}
                  onClick={async () => {
                    try {
                      await patch("/comparisons/" + c.id, {
                        is_active: !c.is_active,
                      });
                      await cache.invalidateQueries({
                        queryKey: ["comparisons"],
                      });
                    } catch (e) {
                      setError(e);
                    }
                  }}
                />
                {c.is_active ? "Active" : "Inactive"}
              </dd>
              <dt>Last result</dt>
              <dd>
                <Badge value={c.latest_result?.conclusion} />
              </dd>
              <dt>Context</dt>
              <dd>
                Review scope, alignment and coverage before interpreting
                observed differences.
              </dd>
            </dl>
            <div className="card-bottom">
              <span className="muted small">
                {c.latest_run
                  ? `Latest run: ${c.latest_run.status}`
                  : "No runs yet"}
              </span>
              <Button
                disabled={!c.is_active}
                onClick={async () => {
                  try {
                    const r = await post<Model<"RunOut">>(
                      `/comparisons/${c.id}/runs`,
                      {},
                      crypto.randomUUID(),
                    );
                    navigate("/runs/" + r.id);
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                <Play size={16} />
                Run now
              </Button>
            </div>
          </Card>
        ))
      ) : (
        <Card>
          <Empty title="No comparisons found">
            Choose two registered datasets to create your first comparison.
          </Empty>
        </Card>
      )}
      {q.data && (
        <Pagination
          total={q.data.total}
          offset={offset}
          setOffset={setOffset}
        />
      )}
    </>
  );
}
export function ComparisonDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState("Overview");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const navigate = useNavigate();
  const c = useQuery({
    queryKey: ["comparison", id],
    queryFn: () => api<Model<"ComparisonOut">>("/comparisons/" + id),
  });
  const runs = useQuery({
    queryKey: ["comparison-runs", id, offset],
    queryFn: () =>
      api<Page<Model<"RunOut">>>(
        `/runs?comparison_id=${id}&limit=20&offset=${offset}`,
      ),
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => ["queued", "running"].includes(r.status))
        ? 2000
        : false,
  });
  const latestSuccessful = useQuery({
    queryKey: [
      "comparison-latest-success",
      id,
      runs.data?.items[0]?.id,
      runs.data?.items[0]?.status,
    ],
    queryFn: () =>
      api<Page<Model<"RunOut">>>(
        `/runs?comparison_id=${id}&status=succeeded&limit=1`,
      ),
  });
  const latest = latestSuccessful.data?.items[0];
  const result = useQuery({
    queryKey: ["result", latest?.id],
    queryFn: () => api<Model<"ResultOut">>(`/runs/${latest!.id}/result`),
    enabled: !!latest,
  });
  const r = result.data?.result as any;
  const row = r?.row_comparisons?.[0];
  return (
    <>
      <PageTitle
        title={c.data?.name ?? "Comparison"}
        subtitle="Monitor observed outcomes, execution history and configuration."
        eyebrow="DATA QUALITY / COMPARISONS"
        action={
          <>
            <Button asChild variant="outline"><Link to={"/schedules?comparison_id=" + id}>Schedules</Link></Button>
            <Button asChild variant="outline">
              <Link to={`/comparisons/${id}/edit`}>Edit</Link>
            </Button>
            <Button
              disabled={!c.data?.is_active}
              onClick={async () => {
                try {
                  const run = await post<Model<"RunOut">>(
                    `/comparisons/${id}/runs`,
                    {},
                    crypto.randomUUID(),
                  );
                  navigate("/runs/" + run.id);
                } catch (e) {
                  setError(e);
                }
              }}
            >
              <Play size={16} />
              Run now
            </Button>
          </>
        }
      />
      <ErrorBox error={error || c.error || runs.error || result.error} />
      {c.isPending ? (
        <Loading />
      ) : (
        c.data && (
          <>
            <div className="tabs" role="tablist">
              {["Overview", "Differences", "Rules", "Runs", "Settings"].map(
                (t) => (
                  <button
                    role="tab"
                    aria-selected={tab === t}
                    key={t}
                    className={tab === t ? "active" : ""}
                    onClick={() => setTab(t)}
                  >
                    {t}
                  </button>
                ),
              )}
            </div>
            {tab === "Overview" ? (
              <>
                <div className="stats-grid four">
                  <Stat
                    label="Rows observed per source"
                    value={
                      r?.sources?.map((s: any) => s.sample_size).join(" / ") ||
                      "Not evaluated"
                    }
                    detail="Observed sample only"
                  />
                  <Stat
                    label="Cell agreement"
                    value={percent(r?.indicators?.agreement?.percentage)}
                    detail={
                      "Coverage " +
                      percent(r?.indicators?.agreement?.coverage_percentage)
                    }
                  />
                  <Stat
                    label="Different sampled rows"
                    value={row?.different_rows ?? "Not evaluated"}
                  />
                  <Stat
                    label="Execution"
                    value="Manual / schedules"
                    detail={
                      <Badge value={c.data.is_active ? "active" : "inactive"} />
                    }
                  />
                </div>
                <div className="content-columns">
                  <Card
                    title="Latest available result"
                    subtitle="A sample cannot establish equality of entire tables."
                  >
                    {result.data ? (
                      <>
                        <Badge value={result.data.conclusion} />
                        <div className="notice">
                          {r?.sampling_plan?.metric_scope ??
                            "Review source sample scope and coverage."}
                        </div>
                        <Button asChild variant="outline">
                          <Link to={"/runs/" + result.data.run_id}>
                            Open results <ArrowRight size={16} />
                          </Link>
                        </Button>
                      </>
                    ) : (
                      <Empty title="No successful run yet">
                        Run this comparison to collect evidence.
                      </Empty>
                    )}
                  </Card>
                  <Card title="Source configuration">
                    <dl>
                      <dt>Source A</dt>
                      <dd>
                        <Link to={"/datasets/" + c.data.left_dataset_id}>
                          Open source dataset
                        </Link>
                      </dd>
                      <dt>Source B</dt>
                      <dd>
                        <Link to={"/datasets/" + c.data.right_dataset_id}>
                          Open comparison dataset
                        </Link>
                      </dd>
                      <dt>Method</dt>
                      <dd>{c.data.mode}</dd>
                      <dt>Key alignment</dt>
                      <dd>
                        {c.data.comparison_options?.business_key?.length
                          ? c.data.comparison_options.business_key
                              .map((p) => `${p.left} ↔ ${p.right}`)
                              .join(" + ")
                          : "Automatic PK / non-null UNIQUE"}
                      </dd>
                    </dl>
                  </Card>
                </div>
              </>
            ) : tab === "Runs" ? (
              <Card title="Run history">
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
                  <Empty />
                )}
              </Card>
            ) : tab === "Differences" ? (
              <Card title="Aggregate differences">
                {result.data ? (
                  <>
                    <p className="muted">
                      Inspect schema, quality and per-column observations
                      without record values.
                    </p>
                    <Button asChild>
                      <Link to={"/runs/" + result.data.run_id + "/differences"}>
                        Open differences
                      </Link>
                    </Button>
                  </>
                ) : (
                  <Empty title="No results yet" />
                )}
              </Card>
            ) : tab === "Rules" ? (
              <Card title="Comparison rules">
                <dl>
                  <dt>
                    Absolute tolerance (units) <ToleranceHelp />
                  </dt>
                  <dd>{c.data.absolute_tolerance}</dd>
                  <dt>
                    Relative tolerance (%) <ToleranceHelp relative />
                  </dt>
                  <dd>{fractionToPercent(c.data.relative_tolerance)}%</dd>
                  <dt>Strings</dt>
                  <dd>Exact; case and whitespace preserved</dd>
                  <dt>Column correspondence</dt>
                  <dd>Manual pairs followed by automatic name matching</dd>
                  <dt>Scope & mapping configuration</dt>
                  <dd>
                    <JsonView value={c.data.comparison_options} />
                  </dd>
                </dl>
              </Card>
            ) : (
              <>
                <FrozenComparisonContext result={r} />
                <Card title="Sampling settings">
                  <JsonView
                    value={{
                      mode: c.data.mode,
                      sample_size: c.data.sample_size,
                      ...c.data.sampling_options,
                      comparison_options: c.data.comparison_options,
                    }}
                  />
                </Card>
              </>
            )}
          </>
        )
      )}
    </>
  );
}
export function Wizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [step, setStep] = useState(1);
  const [comparisonOptions, setComparisonOptions] = useState<ComparisonOptions>(
    {},
  );
  const [preview, setPreview] = useState<Model<"ComparisonPreviewOut"> | null>(
    null,
  );
  const [name, setName] = useState("");
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [mode, setMode] = useState("auto");
  const [absolute, setAbsolute] = useState("0");
  const [relative, setRelative] = useState("0");
  const [sampling, setSampling] = useState(defaults);
  const [size, setSize] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const datasets = useQuery({
    queryKey: ["wizard-datasets"],
    queryFn: () => allPages<Model<"DatasetOut">>("/datasets"),
  });
  const existing = useQuery({
    queryKey: ["comparison", id],
    queryFn: () => api<Model<"ComparisonOut">>("/comparisons/" + id),
    enabled: !!id,
  });
  useEffect(() => {
    if (existing.data) {
      const c = existing.data;
      setName(c.name);
      setComparisonOptions(c.comparison_options ?? {});
      setLeft(c.left_dataset_id);
      setRight(c.right_dataset_id);
      setMode(c.mode);
      setAbsolute(String(c.absolute_tolerance));
      setRelative(fractionToPercent(c.relative_tolerance));
      setSampling({
        ...defaults,
        ...Object.fromEntries(
          Object.entries(c.sampling_options ?? {}).filter(
            ([, value]) => value != null,
          ),
        ),
      });
      setSize(c.sample_size ? String(c.sample_size) : "");
    }
  }, [existing.data]);
  const l = datasets.data?.items.find((d) => d.id === left);
  const r = datasets.data?.items.find((d) => d.id === right);
  const columns = (d?: Model<"DatasetOut">) =>
    (d?.metadata as any)?.columns ?? {};
  function values() {
    return {
      name,
      left_dataset_id: left,
      right_dataset_id: right,
      mode,
      absolute_tolerance: normalizeTolerance(absolute),
      relative_tolerance: percentToFraction(relative),
      sampling_options: sampling,
      sample_size: size ? Number(size) : null,
      comparison_options: comparisonOptions,
    };
  }
  async function refreshPreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<Model<"ComparisonPreviewOut">>(
        "/comparisons/preview",
        values(),
      );
      setPreview(result);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(run: boolean) {
    setError(null);
    setBusy(true);
    try {
      let comparison = saved;
      if (!comparison) {
        const payload = values();
        const c = id
          ? await patch<Model<"ComparisonOut">>("/comparisons/" + id, {
              ...payload,
              sample_size: size ? Number(size) : null,
            })
          : await post<Model<"ComparisonOut">>("/comparisons", payload);
        comparison = c.id;
        setSaved(c.id);
        await cache.invalidateQueries({ queryKey: ["comparisons"] });
        await cache.invalidateQueries({ queryKey: ["comparison", comparison] });
      }
      if (run) {
        const key = retryKey ?? crypto.randomUUID();
        setRetryKey(key);
        const job = await post<Model<"RunOut">>(
          `/comparisons/${comparison}/runs`,
          {},
          key,
        );
        navigate("/runs/" + job.id);
      } else navigate("/comparisons/" + comparison);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        title={
          id
            ? "Edit comparison"
            : step === 1
              ? "Create comparison"
              : step === 2
                ? "Review columns & define rules"
                : "Review comparison"
        }
        subtitle="Compare datasets side by side and evaluate observed differences."
        eyebrow="DATA QUALITY / COMPARISONS"
      />
      <ErrorBox error={error || datasets.error || existing.error} />
      {saved && (
        <div className="notice warning">
          The comparison is saved. If execution failed, retry with the same
          request key or open its run history before creating another run.{" "}
          <Link to={"/comparisons/" + saved}>Open saved comparison</Link>
        </div>
      )}
      <div className="wizard-steps">
        {["Datasets & scope", "Mapping & rules", "Review"].map((label, i) => (
          <div
            key={label}
            className={step === i + 1 ? "current" : step > i + 1 ? "done" : ""}
          >
            <span>
              {step > i + 1 ? (
                <Check size={17} />
              ) : (
                String(i + 1).padStart(2, "0")
              )}
            </span>
            <div>
              <strong>{label}</strong>
              <small>
                {
                  [
                    "Sources & equivalent criteria",
                    "Column pairs & identity",
                    "Save or run",
                  ][i]
                }
              </small>
            </div>
          </div>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (left === right) {
            setError(Error("Choose two distinct datasets."));
            return;
          }
          if (step === 2) {
            try {
              normalizeTolerance(absolute);
              percentToFraction(relative);
            } catch (error) {
              setError(error);
              return;
            }
          }
          setError(null);
          if (step === 2) {
            if (await refreshPreview()) setStep(3);
          } else if (step < 3) setStep(step + 1);
          else void save(true);
        }}
      >
        <fieldset disabled={busy || !!saved} className="wizard-fieldset">
          {step === 1 ? (
            <>
              <div className="content-columns">
                <Card
                  title="Datasets to compare"
                  subtitle="Select two registered source tables."
                >
                  <div className="dataset-pair">
                    {[
                      ["A", "Source dataset", left, setLeft],
                      ["B", "Comparison dataset", right, setRight],
                    ].map(([badge, title, value, setter]: any) => (
                      <div className="dataset-choice" key={badge}>
                        <h3>
                          <span className="badge success">{badge}</span> {title}
                        </h3>
                        <label>
                          Dataset
                          <select
                            aria-label="Dataset"
                            value={value}
                            onChange={(e) => {
                              setter(e.target.value);
                              setComparisonOptions({});
                              setPreview(null);
                            }}
                            required
                          >
                            <option value="">Choose dataset</option>
                            {datasets.data?.items.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.schema_name ? d.schema_name + "." : ""}
                                {d.table_name} · {d.id.slice(0, 8)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <Link to="/catalog">Browse source catalog</Link>
                      </div>
                    ))}
                  </div>
                  <p className="notice">
                    Review the equivalent scope below. Column pairs and business
                    keys are selected in the next step.
                  </p>
                </Card>
                <Card title="Comparison settings">
                  <label>
                    Comparison name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={255}
                    />
                  </label>
                </Card>
              </div>
              <ScopeEditor
                value={comparisonOptions}
                onChange={(v) => {
                  setComparisonOptions(v);
                  setPreview(null);
                }}
                left={columns(l)}
                right={columns(r)}
              />
            </>
          ) : step === 2 ? (
            <div className="content-columns">
              <MappingEditor
                mode={mode}
                value={comparisonOptions}
                onChange={(v) => {
                  setComparisonOptions(v);
                  setPreview(null);
                }}
                left={columns(l)}
                right={columns(r)}
              />
              <Card title="Validation rules">
                <label>
                  Strategy
                  <select
                    aria-label="Strategy"
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="auto">
                      Auto — align when a safe key exists
                    </option>
                    <option value="matched_keys">
                      Matched keys — require safe alignment
                    </option>
                    <option
                      value="independent_random"
                      disabled={!!comparisonOptions.business_key?.length}
                    >
                      Independent random — profiles only
                    </option>
                  </select>
                </label>
                <p className="muted small">
                  Keys are discovered from compatible PK or non-null UNIQUE
                  constraints. Profiles alone cannot prove row correspondence.
                </p>

                <div className="tolerance-field">
                  <div className="tolerance-label">
                    <label htmlFor="absolute-tolerance">
                      Absolute tolerance (units)
                    </label>
                    <ToleranceHelp />
                  </div>
                  <input
                    id="absolute-tolerance"
                    value={absolute}
                    onChange={(e) => {
                      setAbsolute(e.target.value);
                      setError(null);
                    }}
                    required
                    inputMode="decimal"
                    aria-describedby="absolute-tolerance-hint"
                  />
                  <p id="absolute-tolerance-hint" className="muted small">
                    Fixed difference in each numeric column’s units, e.g. 0.50.
                  </p>
                </div>
                <div className="tolerance-field">
                  <div className="tolerance-label">
                    <label htmlFor="relative-tolerance">
                      Relative tolerance (%)
                    </label>
                    <ToleranceHelp relative />
                  </div>
                  <div className="percentage-input">
                    <input
                      id="relative-tolerance"
                      value={relative}
                      onChange={(e) => {
                        setRelative(e.target.value);
                        setError(null);
                      }}
                      required
                      inputMode="decimal"
                      aria-describedby="relative-tolerance-hint"
                    />
                    <span aria-hidden="true">%</span>
                  </div>
                  <p id="relative-tolerance-hint" className="muted small">
                    Enter 1 for 1%. Use a dot or comma for decimals; no
                    thousands separators.
                  </p>
                </div>
                <p className="notice">
                  Numeric values match when their difference is within the
                  larger of the absolute and relative limits. The limits are not
                  added. Both at zero means exact numeric equality. These rules
                  do not set a percentage of differing records.
                </p>
                <dl>
                  <dt>Strings</dt>
                  <dd>Exact match, preserving case and spaces</dd>
                  <dt>NULL handling</dt>
                  <dd>
                    NULL equals NULL; non-NULL values are compared normally
                  </dd>
                  <dt>Matching key</dt>
                  <dd>
                    {comparisonOptions.business_key?.length
                      ? "Explicit business key; full-scope validation at execution"
                      : "Automatic and checked at execution"}
                  </dd>
                </dl>
              </Card>
            </div>
          ) : (
            <div className="content-columns">
              <Card title="Comparison summary" subtitle={name}>
                <div className="stats-grid">
                  <Stat label="Datasets" value="2" />
                  <Stat
                    label="Column pairs"
                    value={preview?.mapping.length ?? "Preview required"}
                  />
                </div>
                <dl>
                  <dt>Source A</dt>
                  <dd>{l?.table_name}</dd>
                  <dt>Source B</dt>
                  <dd>{r?.table_name}</dd>
                  <dt>Strategy</dt>
                  <dd>{mode}</dd>
                  <dt>Tolerances</dt>
                  <dd>
                    {absolute} units absolute / {relative}% relative
                  </dd>
                </dl>
                <ScopeSummary preview={preview} />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void refreshPreview()}
                >
                  Refresh preview
                </Button>
                <p className="notice">
                  The run freezes this definition and selected tables. It
                  resolves current credentials when execution starts. All
                  results describe sampled observations.
                </p>
              </Card>
              <Card
                title="Execution settings"
                subtitle="Manual execution with explicit sample budgets."
              >
                <label>
                  Explicit sample size (optional)
                  <input
                    type="number"
                    min="1"
                    max={sampling.max_rows}
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    placeholder="Adaptive planning"
                  />
                </label>
                <div className="form-grid">
                  {Object.entries(sampling).map(([k, v]) => (
                    <label key={k}>
                      {k.replaceAll("_", " ")}
                      <input
                        type="number"
                        value={v}
                        min={k === "proportion_margin" ? 0.000001 : 1}
                        max={
                          k === "proportion_margin"
                            ? 0.999999
                            : ["max_rows", "min_rows", "pilot_rows"].includes(k)
                              ? 10000
                              : undefined
                        }
                        step={k === "proportion_margin" ? "any" : "1"}
                        required
                        onChange={(e) =>
                          setSampling({
                            ...sampling,
                            [k]: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <p className="muted small">
                  Byte budgets are estimates. Random ordering may scan the
                  source table.
                </p>
              </Card>
            </div>
          )}
        </fieldset>
        <div className="wizard-footer">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate("/comparisons")}
          >
            Cancel
          </Button>
          <div className="actions">
            {step > 1 && !saved && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(step - 1)}
              >
                Back
              </Button>
            )}
            {step === 3 && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={(e) => {
                  if (e.currentTarget.form?.reportValidity()) void save(false);
                }}
              >
                Save comparison
              </Button>
            )}
            <Button disabled={busy}>
              {busy
                ? "Working…"
                : step === 3
                  ? saved
                    ? "Retry run"
                    : "Run now"
                  : "Continue"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
