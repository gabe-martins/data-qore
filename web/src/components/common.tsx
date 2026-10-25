import { useLanguage } from "../i18n/LanguageProvider";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import { errorText } from "../i18n/errors";
import { ApiError } from "../api";
import { formatPercent } from "../lib/metricFormatting";
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
  const { t: tr, locale } = useLanguage();
  if (!error) return null;
  return (
    <div className="notice warning" role="alert">
      <AlertTriangle size={18} />
      <div>
        {error instanceof Error
          ? errorText(error instanceof ApiError ? error.code : null, error.message, locale)
          : tr("Unable to complete the request.")}
        {locale === "pt-BR" && error instanceof Error && <details><summary>{tr("Technical details")}</summary><p>{error instanceof ApiError ? `${error.code}: ` : ""}{error.message}</p></details>}
        {error instanceof ApiError && error.requestId && (
          <small>{tr("Request ID: ")}{error.requestId}</small>
        )}
      </div>
    </div>
  );
}
export function Loading() {
  const { t: tr } = useLanguage();
  return (
    <div className="empty" role="status">
      <LoaderCircle className="spin" />{tr(" Loading…")}</div>
  );
}
export function Empty({
  title = "No data yet",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  const { t: tr } = useLanguage();
  return (
    <div className="empty">
      <strong>{tr(title)}</strong>
      <p className="muted">
        {children ?? tr("Create your first resource to get started.")}
      </p>
    </div>
  );
}
export function Badge({ value }: { value?: string | null }) {
  const { t: tr } = useLanguage();
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
      {tr((value ?? "not evaluated").replaceAll("_", " "))}
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
export const percent = formatPercent;
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
  const { t: tr } = useLanguage();
  return (
    <div className="pagination">
      <span className="muted">
        {total
          ? tr("{0}–{1} of {2}", {0: offset + 1, 1: Math.min(offset + size, total), 2: total})
          : tr("0 results")}
      </span>
      <Button
        variant="outline"
        disabled={!offset}
        onClick={() => setOffset(Math.max(0, offset - size))}
      >{tr("Previous")}</Button>
      <Button
        variant="outline"
        disabled={offset + size >= total}
        onClick={() => setOffset(offset + size)}
      >{tr("Next")}</Button>
    </div>
  );
}
export function JsonView({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}
export function RunsTable({ runs }: { runs: any[] }) {
  const { t: tr, formatDateTime } = useLanguage();
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{tr("Comparison")}</th>
            <th>{tr("Requested")}</th>
            <th>{tr("Duration")}</th>
            <th>{tr("State")}</th>
            <th>{tr("Conclusion")}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={"/runs/" + r.id}>
                  {r.name ?? r.kind ?? tr("Run")} <small>{r.id.slice(0, 8)}</small>
                </Link>
              </td>
              <td>{r.requested_at ? formatDateTime(r.requested_at) : "—"}</td>
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
