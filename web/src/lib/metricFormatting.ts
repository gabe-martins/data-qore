/** Keep unavailable and very small observed rates distinct from a real zero. */
export function formatPercent(value: unknown): string {
  const metric =
    value && typeof value === "object" && "percentage" in value
      ? (value as {
          percentage: unknown;
          numerator?: number;
          denominator?: number;
        })
      : null;
  const raw = metric ? metric.percentage : value;
  if (raw == null) return "Not evaluated";
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    (typeof raw === "string" && !raw.trim())
  )
    return "Unavailable";
  const number = Number(raw);
  if (!Number.isFinite(number)) return "Unavailable";
  if (
    number === 0 &&
    (metric?.numerator ?? 0) > 0 &&
    (metric?.denominator ?? 0) > 0
  )
    return "<0.0001%";
  if (number > 0 && number < 0.0001) return "<0.0001%";
  return `${number.toLocaleString("en-US", { maximumFractionDigits: number > 0 && number < 0.01 ? 4 : 2 })}%`;
}
