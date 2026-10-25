import { useLanguage } from "../i18n/LanguageProvider";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, patch, type Model } from "../api";
import { useCan } from "../lib/access";
import {
  Button,
  Card,
  ErrorBox,
  Loading,
  PageTitle,
  percent,
} from "../components/common";
export function QualitySettings() {
  const { t: tr } = useLanguage();
  const q = useQuery({
    queryKey: ["quality-settings"],
    queryFn: () => api<Model<"QualitySettingsOut">>("/settings/quality"),
  });
  return (
    <>
      <PageTitle
        title={tr("Quality target")}
        subtitle={tr("Set the Row Match Rate target displayed in Overview.")}
      />
      <ErrorBox error={q.error} />
      {q.isPending ? <Loading /> : q.data && <TargetForm settings={q.data} />}
    </>
  );
}
function TargetForm({ settings }: { settings: Model<"QualitySettingsOut"> }) {
  const { t: tr, locale } = useLanguage();
  const canEdit = useCan("quality_settings.manage"),
    cache = useQueryClient();
  const [enabled, setEnabled] = useState(
    settings.row_match_target_percentage != null,
  );
  const [value, setValue] = useState(
    settings.row_match_target_percentage ?? "95",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [saved, setSaved] = useState(false);
  return (
    <Card
      title={tr("Row Match Rate target")}
      subtitle={tr("One environment-wide minimum, shown against the recorded rate of every comparison.")}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setSaved(false);
          try {
            const numeric = Number(value.replace(",", "."));
            if (enabled && (!/^\d+(?:[.,]\d{1,4})?$/.test(value) || !Number.isFinite(numeric) || numeric < 0 || numeric > 100)) throw new Error("Enter a value from 0 to 100 with at most four decimal places.");
            const result = await patch<Model<"QualitySettingsOut">>(
              "/settings/quality",
              { row_match_target_percentage: enabled ? Number(value.replace(",", ".")) : null },
            );
            setSaved(true);
            cache.setQueryData(["quality-settings"], result);
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        <label className="check-label">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canEdit || busy}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setSaved(false);
            }}
          />{tr("Enable quality target")}</label>
        <label>{tr("Minimum Row Match Rate (%)")}<input
            type="text"
            inputMode="decimal"
            pattern="[0-9]+([.,][0-9]{1,4})?"
            required={enabled}
            min="0"
            max="100"
            step="0.0001"
            value={value}
            disabled={!enabled || !canEdit || busy}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <p className="muted">{tr("Current saved target:")}{" "}
          {settings.row_match_target_percentage == null
            ? tr("Disabled")
            : percent(settings.row_match_target_percentage, locale)}{tr(". The initial target is 95%. You can choose any value from 0 to 100% or disable it.")}</p>
        <p className="notice">{tr("This target applies to Row Match Rate only. It does not replace volume, key integrity or coverage checks, and does not change saved analytical conclusions. The daily chart uses the current target as a reference for the entire displayed period.")}</p>
        {!canEdit && (
          <p className="muted">{tr("You can view this setting. A Quality Manager or Platform Administrator can update it.")}</p>
        )}
        <div className="actions">
          {canEdit && (
            <Button disabled={busy} type="submit">
              {busy ? tr("Saving…") : tr("Save target")}
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to="/">{tr("View Overview")}</Link>
          </Button>
        </div>
        {saved && <p role="status">{tr("Quality target saved.")}</p>}
      </form>
    </Card>
  );
}
