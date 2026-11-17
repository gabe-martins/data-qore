import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLanguage } from "../../i18n/LanguageProvider";
import { api, type Model, type Page } from "../../api";
import { Button, Card, Empty, ErrorBox, Loading, Pagination } from "../common";
import { Rate } from "../CriticalMetrics";
import { Explain, IntervalNote, Status, kindLabels, labels } from "./shared";

function Change({ current, previous }: { current: unknown; previous: unknown }) {
  const { locale } = useLanguage();
  const change = Number(current) - Number(previous);
  return (
    <span className="quality-delta" data-trend={!change ? "same" : change > 0 ? "better" : "worse"}>
      {!change ? "=" : `${change > 0 ? "▲" : "▼"} ${Math.abs(change).toLocaleString(locale, { maximumFractionDigits: 2 })} pp`}
    </span>
  );
}

/** Why the values differ: the kinds of proven differences, most frequent first. */
function KindChips({ statistics }: { statistics: any }) {
  const { t: tr, formatNumber } = useLanguage();
  const kinds = Object.entries<number>(statistics?.difference_kinds ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!kinds.length) return null;
  return (
    <span className="quality-chips">
      {kinds.map(([kind, n]) => (
        <span key={kind}>
          {tr(kindLabels[kind] ?? kind)} · {formatNumber(n)}
        </span>
      ))}
    </span>
  );
}

function ColumnDetail({ statistics }: { statistics: any }) {
  const { t: tr, formatNumber, decimal } = useLanguage();
  if (!statistics) return null;
  const n = statistics.numeric_difference;
  return (
    <>
      <p>
        {tr("NULL values in paired records: A {0} · B {1}", {
          0: formatNumber(statistics.null_values.reference),
          1: formatNumber(statistics.null_values.target),
        })}
      </p>
      {n && (
        <p>
          {tr("Numeric differences (B − A) in {0} values: mean {1} · mean absolute {2} · largest {3} · B greater in {4}, A greater in {5}", {
            0: formatNumber(n.compared_differences),
            1: decimal(n.mean_signed_difference),
            2: decimal(n.mean_absolute_difference),
            3: decimal(n.max_absolute_difference),
            4: formatNumber(n.target_greater),
            5: formatNumber(n.reference_greater),
          })}
        </p>
      )}
    </>
  );
}

export function ColumnAnalysis({
  runId,
  result,
  captured,
  hasPrevious,
  inspect,
}: {
  runId: string;
  result: any;
  captured: boolean;
  hasPrevious: boolean;
  inspect: (state?: string, column?: string) => void;
}) {
  const { t: tr, locale, formatNumber } = useLanguage();
  const [typed, setTyped] = useState(""),
    [search, setSearch] = useState(""),
    [columnStatus, setColumnStatus] = useState("all"),
    [sort, setSort] = useState("differences"),
    [columnOffset, setColumnOffset] = useState(0);
  // Query once the reader pauses typing, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(typed);
      setColumnOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const columnQuery = new URLSearchParams({
    limit: "50",
    offset: String(columnOffset),
    search,
    status: columnStatus,
    sort,
  });
  const cols = useQuery({
    queryKey: ["quality-columns", runId, columnQuery.toString()],
    queryFn: () =>
      api<Page<Model<"QualityColumnOut">>>(
        `/runs/${runId}/quality/columns?${columnQuery}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <div id="quality-columns">
      <Card
        title={tr("Column analysis")}
        subtitle={tr("Filters, ordering and pagination are applied by the backend")}
      >
        <div className="form-grid">
          <label>{tr("Search columns")}<input
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <label>{tr("Column status")}<select
              aria-label={tr("Column status")}
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
                  {v === "all" ? tr("All columns") : tr(labels[v] ?? v)}
                </option>
              ))}
            </select>
          </label>
          <label>{tr("Order columns")}<select
              aria-label={tr("Order columns")}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setColumnOffset(0);
              }}
            >
              <option value="differences">{tr("Most differences / unknowns")}</option>
              <option value="name">{tr("Column name")}</option>
              <option value="match">{tr("Lowest match rate")}</option>
            </select>
          </label>
        </div>
        <ErrorBox error={cols.error} />
        {cols.isPending ? (
          <Loading />
        ) : !cols.data?.items.length ? (
          <Empty title={tr("No columns match these filters")}>{tr("Adjust the search or the status filter.")}</Empty>
        ) : (
          <>
            <div className="table-scroll" aria-busy={cols.isPlaceholderData}>
              <table>
                <thead>
                  <tr>
                    <th>{tr("Column A / B")}</th>
                    <th>{tr("Match rate")}</th>
                    {hasPrevious && <th>{tr("Change")}</th>}
                    <th>{tr("Differences")}</th>
                    <th>{tr("Status")}</th>
                    <th>{tr("Inspect")}</th>
                  </tr>
                </thead>
                <tbody>
                  {cols.data?.items.map((c: any) => (
                    <tr key={c.id}>
                      <td>
                        <details>
                          <summary>
                            {c.left_column ?? tr("Missing")} ↔{" "}
                            {c.right_column ?? tr("Missing")}
                          </summary>
                          <p>{tr("Types: ")}{c.left_type ?? tr("Missing")} /{" "}
                            {c.right_type ?? tr("Missing")}
                          </p>
                          <ColumnDetail statistics={c.statistics} />
                          <Explain
                            metric={c.metric}
                            formula={
                              c.metric.formula ??
                              "Unavailable: unpaired column"
                            }
                            description={tr("Equal values divided by evaluated positions; a missing record counts as a difference. Unknown values reduce evaluation coverage.")}
                            tolerances={result.sampling_plan}
                          />
                        </details>
                      </td>
                      <td>
                        <Rate value={c.metric} />
                        <IntervalNote interval={c.statistics?.interval} />
                      </td>
                      {hasPrevious && (
                        <td>
                          {c.previous_percentage == null || c.metric.percentage == null ? (
                            <span className="muted">—</span>
                          ) : (
                            <Change current={c.metric.percentage} previous={c.previous_percentage} />
                          )}
                        </td>
                      )}
                      <td>
                        {formatNumber(c.metric.different_values)}
                        <small className="muted">
                          {" "}
                          · {formatNumber(c.metric.not_evaluated)}{tr(" not evaluated")}</small>
                        <KindChips statistics={c.statistics} />
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
                        >{tr("Inspect column")}</Button>
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
  );
}
