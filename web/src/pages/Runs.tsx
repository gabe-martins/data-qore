import { Allowed } from "../lib/access";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Model, type Page } from "../api";
import { ComparisonRunAnimation } from "../components/ComparisonRunAnimation";
import { CriticalMetrics } from "../components/CriticalMetrics";
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
export function Runs() {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["runs", status, offset],
    queryFn: () =>
      api<Page<Model<"RunOut">>>(
        `/runs?limit=20&offset=${offset}${status ? "&status=" + status : ""}`,
      ),
    refetchInterval: 2000,
  });
  return (
    <>
      <PageTitle
        title="Run history"
        subtitle="Comparison executions and saved critical metrics."
      />
      <Card>
        <label>
          Execution state
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All states</option>
            {["queued", "running", "succeeded", "failed"].map((v) => (
              <option key={v}>{v}</option>
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
          <Empty title="No comparison runs" />
        )}
      </Card>
    </>
  );
}
export function RunResult({ differences = false }: { differences?: boolean }) {
  const { id } = useParams();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => api<Model<"RunOut">>(`/runs/${id}`),
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.status ?? "") ? 2000 : false,
  });
  const result = useQuery({
    queryKey: ["result", id],
    queryFn: () => api<Model<"ResultOut">>(`/runs/${id}/result`),
    enabled: run.data?.status === "succeeded",
  });
  return (
    <>
      <PageTitle
        title={differences ? "Comparison differences" : "Comparison result"}
        subtitle="Execution state is separate from the analytical conclusion."
        action={
          <Button asChild>
            <Link to="/runs">Run history</Link>
          </Button>
        }
      />
      <ErrorBox error={run.error || result.error} />
      {run.isPending ? (
        <Loading />
      ) : (
        run.data && (
          <>
            <Card>
              <Badge value={run.data.status} />
              {run.data.comparison_id && (
                <p>
                  <Allowed permission="comparisons.read"><Link to={`/comparisons/${run.data.comparison_id}`}>
                    Open comparison
                  </Link></Allowed>
                </p>
              )}
              {run.data.status === "failed" && (
                <p role="alert">
                  {run.data.error_code}: {run.data.error_message}
                </p>
              )}
              {(run.data.status === "queued" || run.data.status === "running") && (
                <ComparisonRunAnimation state={run.data.status} />
              )}
            </Card>
            {result.data && (
              <>
                <CriticalMetrics result={result.data.result} />
                <Card title="Execution details">
                  <details>
                    <summary>Frozen configuration</summary>
                    <JsonView value={run.data.parameters} />
                  </details>
                  <details>
                    <summary>Aggregated result and query audit</summary>
                    <JsonView value={result.data.result} />
                  </details>
                  <Button
                    onClick={() => {
                      const blob = new Blob(
                        [JSON.stringify(result.data, null, 2)],
                        { type: "application/json" },
                      );
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `comparison-${id}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download result
                  </Button>
                </Card>
              </>
            )}
          </>
        )
      )}
    </>
  );
}
