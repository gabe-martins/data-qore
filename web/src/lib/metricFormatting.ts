import { translate, type Locale } from "../i18n/core.ts";
/** Keep unavailable and very small observed rates distinct from a real zero. */
export function formatPercent(value: unknown, locale: Locale = "en-US"): string {
  const metric =
    value && typeof value === "object" && "percentage" in value
      ? (value as {
          percentage: unknown;
          numerator?: number;
          denominator?: number;
        })
      : null;
  const raw = metric ? metric.percentage : value;
  if (raw == null) return translate("Not evaluated", locale);
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    (typeof raw === "string" && !raw.trim())
  )
    return translate("Unavailable", locale);
  const number = Number(raw);
  if (!Number.isFinite(number)) return translate("Unavailable", locale);
  if (
    number === 0 &&
    (metric?.numerator ?? 0) > 0 &&
    (metric?.denominator ?? 0) > 0
  )
    return locale === "pt-BR" ? "<0,0001%" : "<0.0001%";
  if (number > 0 && number < 0.0001) return locale === "pt-BR" ? "<0,0001%" : "<0.0001%";
  return `${number.toLocaleString(locale, { maximumFractionDigits: number > 0 && number < 0.01 ? 4 : 2 })}%`;
}
