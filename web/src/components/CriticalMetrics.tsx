import { percent } from "./common";
export function Rate({
  value,
  lowerIsBetter = false,
  showValue = true,
}: {
  value: any;
  lowerIsBetter?: boolean;
  showValue?: boolean;
}) {
  if (!value) return <span>Not evaluated</span>;
  return (
    <>
      {showValue && (
        <strong
          className={
            value.percentage == null
              ? ""
              : Number(value.percentage) === (lowerIsBetter ? 0 : 100) &&
                  (!lowerIsBetter || value.numerator === 0) &&
                  !value.not_evaluated
                ? "metric-good"
                : "metric-attention"
          }
        >
          {value.percentage == null ? "Not evaluated" : percent(value)}
        </strong>
      )}
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
