import { useLanguage } from "../i18n/LanguageProvider";
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
  const { t: tr, locale, reason } = useLanguage();
  if (!value) return <span>{tr("Not evaluated")}</span>;
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
          {value.percentage == null ? tr("Not evaluated") : percent(value, locale)}
        </strong>
      )}
      <small className="muted" style={{ display: "block" }}>
        {value.numerator.toLocaleString(locale)} /{" "}
        {value.denominator.toLocaleString(locale)}{tr(" evaluated ·")}{" "}
        {value.not_evaluated.toLocaleString(locale)}{tr(" not evaluated · coverage")}{" "}
        {value.coverage_percentage == null
          ? "—"
          : percent(String(value.coverage_percentage), locale)}
      </small>
      {value.reason && (
        <small>{reason(String(value.reason))}</small>
      )}
    </>
  );
}
