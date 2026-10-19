import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import { ApiError } from "../api";
export { Button };
export function PageTitle({
  title,
  subtitle,
  action,
  eyebrow,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      <div className="title-actions">{action}</div>
    </div>
  );
}
export function Card({
  children,
  title,
  subtitle,
  className = "",
}: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  className?: string;
}) {
  return (
    <section className={"card " + className}>
      {title && <h2>{title}</h2>}
      {subtitle && <p className="muted">{subtitle}</p>}
      {children}
    </section>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="notice warning" role="alert">
      <AlertTriangle size={18} />
      <div>
        {error instanceof Error
          ? error.message
          : "Unable to complete the request."}
        {error instanceof ApiError && error.requestId && (
          <small>Request ID: {error.requestId}</small>
        )}
      </div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="empty" role="status">
      <LoaderCircle className="spin" /> Loading…
    </div>
  );
}
export function Empty({
  title = "No data yet",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p className="muted">
        {children ?? "Create your first resource to get started."}
      </p>
    </div>
  );
}
export function Badge({ value }: { value?: string | null }) {
  return (
    <span
      className={
        "badge " +
        (value === "succeeded" ||
        value === "compatible_in_sample" ||
        value === "active"
          ? "success"
          : value === "failed" || value === "difference_observed"
            ? "warning"
            : "info")
      }
    >
      {(value ?? "not evaluated").replaceAll("_", " ")}
    </span>
  );
}
export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="card stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
export const percent = (v: unknown) =>
  v === null || v === undefined
    ? "Not evaluated"
    : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
export const date = (v?: string | null) =>
  v ? new Date(v).toLocaleString("en-US") : "—";
export function Pagination({
  total,
  offset,
  setOffset,
  size = 20,
}: {
  total: number;
  offset: number;
  setOffset: (n: number) => void;
  size?: number;
}) {
  return (
    <div className="pagination">
      <span className="muted">
        {total
          ? `${offset + 1}–${Math.min(offset + size, total)} of ${total}`
          : "0 results"}
      </span>
      <Button
        variant="outline"
        disabled={!offset}
        onClick={() => setOffset(Math.max(0, offset - size))}
      >
        Previous
      </Button>
      <Button
        variant="outline"
        disabled={offset + size >= total}
        onClick={() => setOffset(offset + size)}
      >
        Next
      </Button>
    </div>
  );
}
export function JsonView({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}
export function RunsTable({ runs }: { runs: any[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Comparison / dataset</th>
            <th>Requested</th>
            <th>Duration</th>
            <th>State</th>
            <th>Conclusion</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={"/runs/" + r.id}>
                  {r.name ?? r.kind ?? "Run"} <small>{r.id.slice(0, 8)}</small>
                </Link>
              </td>
              <td>{date(r.requested_at)}</td>
              <td>
                {r.started_at && r.finished_at
                  ? Math.max(
                      0,
                      Math.round(
                        (Date.parse(r.finished_at) - Date.parse(r.started_at)) /
                          1000,
                      ),
                    ) + "s"
                  : "—"}
              </td>
              <td>
                <Badge value={r.status} />
              </td>
              <td>{r.conclusion ? <Badge value={r.conclusion} /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
