export function targetState(
  rate:
    | {
        percentage?: unknown;
        numerator?: number;
        denominator?: number;
        not_evaluated?: number;
      }
    | null
    | undefined,
  target: string | null | undefined,
) {
  if (target == null) return { label: "Target disabled", state: "neutral" };
  if (!rate || rate.percentage == null || !rate.denominator)
    return { label: "Not evaluated", state: "neutral" };
  const actual =
      rate.numerator == null
        ? Number(rate.percentage)
        : (rate.numerator * 100) / rate.denominator,
    minimum = Number(target);
  if (!Number.isFinite(actual) || !Number.isFinite(minimum))
    return { label: "Unavailable", state: "neutral" };
  if (actual < minimum) return { label: "Below target", state: "below" };
  if (rate.not_evaluated)
    return { label: "Partial · above target", state: "partial" };
  return { label: "Target met", state: "met" };
}
