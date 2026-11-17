import { Fragment, useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLanguage } from "../../i18n/LanguageProvider";
import { api, type Model, type Page } from "../../api";
import { Button, Card, Empty, ErrorBox, Loading, Pagination } from "../common";
import { Value, labels } from "./shared";

/** Captured sample records; state and column filters are shared with the charts. */
export function RecordInspection({
  runId,
  result,
  evidence,
  state,
  column,
  setFilters,
}: {
  runId: string;
  result: any;
  evidence: any;
  state: string;
  column: string;
  setFilters: (state: string, column: string) => void;
}) {
  const { t: tr, locale, formatNumber, reason } = useLanguage();
  const [keyInput, setKeyInput] = useState(""),
    [keyFilter, setKeyFilter] = useState(""),
    [recordOffset, setRecordOffset] = useState(0),
    [expanded, setExpanded] = useState<number | null>(null),
    [exportError, setExportError] = useState<unknown>(null),
    [exporting, setExporting] = useState(false);
  const captured = ["available", "partial"].includes(evidence.status);
  useEffect(() => {
    setRecordOffset(0);
    setExpanded(null);
  }, [state, column]);
  const filters = new URLSearchParams({
    state,
    ...(column ? { column } : {}),
    ...(keyFilter ? { key: keyFilter } : {}),
  });
  const records = useQuery({
    queryKey: ["quality-records", runId, filters.toString(), recordOffset],
    queryFn: () =>
      api<Page<Model<"EvidenceRecordOut">>>(
        `/runs/${runId}/quality/records?${filters}&limit=50&offset=${recordOffset}`,
      ),
    enabled: captured,
    placeholderData: keepPreviousData,
  });
  const record = useQuery({
    queryKey: ["quality-record", runId, expanded],
    queryFn: () =>
      api<Model<"EvidenceRecordOut">>(
        `/runs/${runId}/quality/records/${expanded}`,
      ),
    enabled: captured && expanded !== null,
  });
  const allColumns = result.column_directory.map((c: any) => ({
    id: c.id,
    label: `${c.left_column ?? tr("Missing")} ↔ ${c.right_column ?? tr("Missing")}`,
  }));
  return (
    <div id="quality-records">
      <Card
        title={tr("Record inspection")}
        subtitle={tr("Frozen evidence from this execution; no source queries are performed")}
      >
        <p className={`notice ${captured ? "" : "warning"}`}>
          {tr((
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
          )[evidence.status] ?? evidence.status)}{" "}
          {evidence.reason && reason(evidence.reason)}
        </p>
        {evidence.expires_at && (
          <p>{tr("Retention: 30 days · expires")}{" "}
            {new Date(evidence.expires_at).toLocaleString(locale, {
              timeZone: "America/Sao_Paulo",
            })}{" "}
            · {tr("captured")} {formatNumber(evidence.stored_positions)} /{" "}
            {formatNumber(evidence.selected_positions)}{tr(" positions")}</p>
        )}
        {captured && (
          <>
            <div className="form-grid">
              <label>{tr("Record state")}<select
                  aria-label={tr("Record state")}
                  value={state}
                  onChange={(e) => setFilters(e.target.value, column)}
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
                      {tr(labels[v])}
                    </option>
                  ))}
                </select>
              </label>
              <label>{tr("Affected column")}<select
                  aria-label={tr("Affected column")}
                  value={column}
                  onChange={(e) => setFilters(state, e.target.value)}
                >
                  <option value="">{tr("All columns")}</option>
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
              <label>{tr("Exact key (JSON array; strings preserve precision)")}<input
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  aria-describedby="evidence-key-help"
                />
              </label>
              <small id="evidence-key-help">{tr("Component order:")}{" "}
                {result.key_validation[0]?.columns.join(" + ")}{tr(". Include every component, preserving case and spaces.")}</small>
              <div className="form-footer">
                <Button type="submit">{tr("Search key")}</Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setKeyInput("");
                    setKeyFilter("");
                    setFilters("all", "");
                  }}
                >{tr("Clear filters")}</Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={exporting}
                  onClick={async () => {
                    setExporting(true);
                    setExportError(null);
                    try {
                      const data = await api(
                        `/runs/${runId}/quality/export?${filters}`,
                      );
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(data, null, 2)], {
                          type: "application/json",
                        }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `evidence-${runId}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (error) {
                      setExportError(error);
                    } finally {
                      setExporting(false);
                    }
                  }}
                >
                  {exporting ? tr("Preparing…") : tr("Download captured records")}
                </Button>
              </div>
            </form>
            <ErrorBox error={records.error || record.error || exportError} />
            {(state !== "all" || column || keyFilter) && (
              <p className="quality-chips" aria-label={tr("Active filters")}>
                {state !== "all" && <span>{tr("Record state")}: {tr(labels[state])}</span>}
                {column && <span>{tr("Affected column")}: {allColumns.find((c: any) => c.id === column)?.label}</span>}
                {keyFilter && <span>{tr("Exact key")}: {keyFilter}</span>}
              </p>
            )}
            {records.isPending ? (
              <Loading />
            ) : records.data?.items.length ? (
              <>
                <p>
                  {formatNumber(records.data.total)}{tr(" captured records match these filters.")}</p>
                <div className="table-scroll" aria-busy={records.isPlaceholderData}>
                  <table>
                    <thead>
                      <tr>
                        <th>{tr("Key")}</th>
                        <th>{tr("State")}</th>
                        <th>{tr("Affected fields")}</th>
                        <th>{tr("Details")}</th>
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
                            <td>{tr(labels[item.state])}</td>
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
                              >{tr("Inspect record")}</Button>
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
                                          <th>{tr("Column A / B")}</th>
                                          <th>{tr("Source A")}</th>
                                          <th>{tr("Source B")}</th>
                                          <th>{tr("State")}</th>
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
                                              {c.left_column ?? tr("Missing")} ↔{" "}
                                              {c.right_column ?? tr("Missing")}
                                            </td>
                                            <td>
                                              <Value value={c.left} />
                                            </td>
                                            <td>
                                              <Value value={c.right} />
                                            </td>
                                            <td>{tr(labels[c.status])}</td>
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
              <Empty title={tr("No captured records match these filters")} />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
