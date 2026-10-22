import { Card, Stat, percent, Badge } from "./common";
export function Rate({ value }: { value: any }) {
  if (!value) return <span>Not evaluated</span>;
  return (
    <>
      <strong>
        {value.percentage == null
          ? "Not evaluated"
          : percent(String(value.percentage))}
      </strong>
      <small className="muted" style={{ display: "block" }}>
        {value.numerator} / {value.denominator} evaluated ·{" "}
        {value.not_evaluated} not evaluated · coverage{" "}
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
  return (
    <>
      <p className="notice">
        Counts and key integrity cover the entire selected scope. Key coverage,
        row and column match rates describe the selected key sample. They do not
        prove equality of entire tables.
      </p>
      <Card title="Row Count Match" subtitle="Entire selected scope">
        <div className="stats-grid">
          <Stat label="Source A" value={c.reference_count} />
          <Stat label="Source B" value={c.target_count} />
          <Stat label="Absolute difference" value={c.absolute_difference} />
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
              <Rate value={d} />
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
              {m.column_match_rate.map((v: any, i: number) => (
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
        <Badge value={result.summary.status} />
      </Card>
    </>
  );
}
