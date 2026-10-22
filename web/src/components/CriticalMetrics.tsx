import { Card, Stat, percent, Badge } from "./common";
export function Rate({
  value,
  lowerIsBetter = false,
}: {
  value: any;
  lowerIsBetter?: boolean;
}) {
  if (!value) return <span>Not evaluated</span>;
  return (
    <>
      <strong
        className={
          value.percentage == null
            ? ""
            : Number(value.percentage) === (lowerIsBetter ? 0 : 100) &&
                !value.not_evaluated
              ? "metric-good"
              : "metric-attention"
        }
      >
        {value.percentage == null
          ? "Not evaluated"
          : percent(String(value.percentage))}
      </strong>
      <small className="muted" style={{ display: "block" }}>
        {value.numerator.toLocaleString("en-US")} /{" "}
        {value.denominator.toLocaleString("en-US")} evaluated ·{" "}
        {value.not_evaluated.toLocaleString("en-US")} not evaluated · coverage{" "}
        {value.coverage_percentage == null
          ? "—"
          : percent(String(value.coverage_percentage))}
      </small>
      {value.reason && (
        <small>{String(value.reason).replaceAll("_", " ")}</small>
      )}
    </>
  );
}
export function CriticalMetrics({ result }: { result: any }) {
  const m = result.metrics,
    c = m.row_count_match,
    k = m.key_coverage;
  const row = m.row_match_rate;
  const columns = [...m.column_match_rate].sort(
    (a: any, b: any) =>
      b.different_values +
      b.unknown_values -
      (a.different_values + a.unknown_values),
  );
  const differingColumns = columns.filter((v: any) => v.different_values > 0);
  const blockedColumns = columns.filter((v: any) => v.unknown_values > 0);
  return (
    <>
      <Card title="Result interpretation" className="metric-summary">
        <Badge value={result.summary.status} />
        {result.sources?.length === 2 && (
          <p className="metric-sources">
            {result.sources[0].table} <span aria-label="compared with">↔</span>{" "}
            {result.sources[1].table}
          </p>
        )}
        <div className="metric-summary-grid">
          <div>
            <span className="muted">Matching rows</span>
            <strong className="metric-summary-value">
              {row.percentage == null
                ? "Not evaluated"
                : percent(row.percentage)}
            </strong>
            <span>
              {row.numerator.toLocaleString("en-US")} /{" "}
              {row.denominator.toLocaleString("en-US")} evaluated
            </span>
          </div>
          <div>
            <span className="muted">Evaluation coverage</span>
            <strong className="metric-summary-value">
              {row.coverage_percentage == null
                ? "Not evaluated"
                : percent(row.coverage_percentage)}
            </strong>
            <span>
              {row.denominator.toLocaleString("en-US")} /{" "}
              {row.total.toLocaleString("en-US")} selected positions
            </span>
          </div>
          <div>
            <span className="muted">Different rows</span>
            <strong className="metric-summary-value">
              {row.different_rows.toLocaleString("en-US")}
            </strong>
            <span>
              {row.not_evaluated.toLocaleString("en-US")} not evaluated
            </span>
          </div>
        </div>
        {row.total === 0 ? (
          <p className="notice warning">
            No row positions are available for evaluation. Review the scope and
            comparison key diagnostics below.
          </p>
        ) : row.not_evaluated > 0 ? (
          <p className="notice warning">
            Partial evaluation: the match rate applies only to{" "}
            {row.denominator.toLocaleString("en-US")} evaluated positions.{" "}
            {row.not_evaluated.toLocaleString("en-US")} positions remain
            unknown; they are not counted as equal or different without
            evidence.
          </p>
        ) : (
          <p className="notice success">
            All {row.total.toLocaleString("en-US")} selected row positions were
            evaluated. {row.numerator.toLocaleString("en-US")} match and{" "}
            {row.different_rows.toLocaleString("en-US")} differ.
          </p>
        )}
        {differingColumns.length > 0 && (
          <p>
            <strong>Differences by column:</strong>{" "}
            {differingColumns
              .map(
                (v: any) =>
                  `${v.left_column ?? "Missing"} ↔ ${v.right_column ?? "Missing"} (${v.different_values.toLocaleString("en-US")})`,
              )
              .join(" · ")}
          </p>
        )}
        {blockedColumns.length > 0 && (
          <p>
            <strong>Columns requiring review:</strong>{" "}
            {blockedColumns
              .map(
                (v: any) =>
                  `${v.left_column ?? "Missing"} ↔ ${v.right_column ?? "Missing"}`,
              )
              .join(" · ")}
          </p>
        )}
      </Card>
      <p className="notice">
        Counts and key integrity cover the entire selected scope. Key coverage,
        row and column match rates describe the selected key sample. They do not
        prove equality of entire tables.
      </p>
      <Card title="Row Count Match" subtitle="Entire selected scope">
        <div className="stats-grid">
          <Stat
            label="Source A"
            value={c.reference_count.toLocaleString("en-US")}
          />
          <Stat
            label="Source B"
            value={c.target_count.toLocaleString("en-US")}
          />
          <Stat
            label="Absolute difference"
            value={c.absolute_difference.toLocaleString("en-US")}
          />
          <Stat
            label="Difference relative to A"
            value={
              c.percentage_difference == null
                ? "Not evaluated"
                : percent(String(c.percentage_difference))
            }
          />
        </div>
        <p>
          Signed difference (B − A): {c.signed_difference} ·{" "}
          {c.equal ? "Equal counts" : "Different counts"}
          {c.reason && ` · ${c.reason.replaceAll("_", " ")}`}
        </p>
        {c.equal && (
          <p className="notice success">
            Counts match. A 0% count difference means equal volumes.
          </p>
        )}
      </Card>
      <Card
        title="Row Match Rate"
        subtitle="Equal records / evaluated row positions"
      >
        <Rate value={m.row_match_rate} />
        <p>
          {m.row_match_rate.different_rows} different ·{" "}
          {m.row_match_rate.unknown_rows} unknown ·{" "}
          {m.row_match_rate.missing_rows} missing
        </p>
      </Card>
      <Card
        title="Key Coverage"
        subtitle={`${k.selected_keys} selected keys from both sources`}
      >
        <div className="form-grid">
          <section>
            <h3>A → B</h3>
            <Rate value={k.reference_to_target} />
            <p>{k.missing_in_target} missing in B</p>
          </section>
          <section>
            <h3>B → A</h3>
            <Rate value={k.target_to_reference} />
            <p>{k.missing_in_reference} missing in A</p>
          </section>
        </div>
        <p>{k.unavailable_in_both} selected keys unavailable in both sources</p>
      </Card>
      <Card
        title="Duplicate Key Rate"
        subtitle="Excess duplicate rows / non-null key rows · entire selected scope"
      >
        <div className="form-grid">
          {m.duplicate_key_rate.map((d: any) => (
            <section key={d.source}>
              <h3>Source {d.source === 1 ? "A" : "B"}</h3>
              <Rate value={d} lowerIsBetter />
              {d.percentage != null &&
                Number(d.percentage) === 0 &&
                d.null_key_rows === 0 && (
                  <p className="metric-good">
                    No duplicate or null keys found. Here, 0% is the expected
                    result.
                  </p>
                )}
              <p>
                Key: {d.columns.join(", ") || "Unavailable"} ·{" "}
                {d.duplicate_groups ?? "—"} duplicate groups ·{" "}
                {d.null_key_rows ?? "—"} rows with a null key
              </p>
            </section>
          ))}
        </div>
      </Card>
      <Card
        title="Column Match Rate"
        subtitle="Equal values / evaluated positions per column"
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Column A</th>
                <th>Column B</th>
                <th>Match rate</th>
                <th>Different</th>
                <th>Unknown</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((v: any, i: number) => (
                <tr key={i}>
                  <td>{v.left_column ?? "Missing"}</td>
                  <td>{v.right_column ?? "Missing"}</td>
                  <td>
                    <Rate value={v} />
                  </td>
                  <td>{v.different_values}</td>
                  <td>{v.unknown_values}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Selection and consistency">
        <p>
          Excluded columns A:{" "}
          {result.comparison_options?.excluded_columns?.left?.join(", ") ||
            "None"}{" "}
          · B:{" "}
          {result.comparison_options?.excluded_columns?.right?.join(", ") ||
            "None"}
        </p>
        {(["left", "right"] as const).map((side) =>
          Object.entries(
            result.comparison_options?.timestamp_timezones?.[side] ?? {},
          ).map(([column, zone]) => (
            <p key={`${side}.${column}`}>
              Timestamp {side === "left" ? "A" : "B"}.{column}: {String(zone)}
            </p>
          )),
        )}
        <p>
          Seed: <code>{String(result.sampling_plan.seed)}</code> · requested{" "}
          {result.sampling_plan.requested_keys} keys · selected{" "}
          {result.sampling_plan.selected_keys} · {result.sampling_plan.method}
        </p>
        <p>{result.sampling_plan.repeatability}</p>
        {result.sampling_plan.method === "percentage" && (
          <p>
            {result.sampling_plan.percentage}% of{" "}
            {result.sampling_plan.percentage_base} rows (larger source scope),
            not of the key union.
          </p>
        )}
        {result.resolved_scope?.period && (
          <p>
            Period: {result.resolved_scope.period.start} →{" "}
            {result.resolved_scope.period.end} (end exclusive) ·{" "}
            {result.resolved_scope.period.timezone}
          </p>
        )}
        <ul>
          {result.warnings.map((v: string, i: number) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}
