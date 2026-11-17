import { useLanguage } from "../../i18n/LanguageProvider";
import type { Model } from "../../api";
import { Button, Card } from "../common";
import { Status } from "./shared";

export function Diagnosis({
  quality,
  captured,
  state,
  inspect,
}: {
  quality: Model<"QualityOut">;
  captured: boolean;
  state: string;
  inspect: (state?: string, column?: string) => void;
}) {
  const { t: tr, formatNumber, reason } = useLanguage();
  return (
    <Card
      title={tr("Divergence diagnosis")}
      subtitle={tr("Categories can overlap. Counts must not be summed as distinct records.")}
    >
      <div className="quality-diagnostics">
        {quality.diagnostics.map((d: any) => (
          <div
            key={d.id}
            data-selected={!!d.record_state && state === d.record_state}
          >
            <strong>{tr(d.label)}</strong>
            <span>
              {d.count == null ? tr("Unavailable") : formatNumber(d.count)} ·{" "}
              {reason(d.scope)}
            </span>
            <Status
              value={
                d.count == null
                  ? "not_calculated"
                  : d.count
                    ? d.severity
                    : "passed"
              }
            />
            {d.record_state && captured ? (
              <Button
                type="button"
                variant="outline"
                aria-pressed={state === d.record_state}
                onClick={() => inspect(d.record_state)}
              >{tr("Inspect records")}</Button>
            ) : (
              <small className="muted">
                {d.record_state
                  ? tr("Record evidence unavailable")
                  : tr("Full-scope / technical diagnostic; individual aligned evidence does not identify these violations.")}
              </small>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
