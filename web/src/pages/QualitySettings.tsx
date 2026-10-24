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
  const q = useQuery({
    queryKey: ["quality-settings"],
    queryFn: () => api<Model<"QualitySettingsOut">>("/settings/quality"),
  });
  return (
    <>
      <PageTitle
        title="Quality target"
        subtitle="Set the Row Match Rate target displayed in Overview."
      />
      <ErrorBox error={q.error} />
      {q.isPending ? <Loading /> : q.data && <TargetForm settings={q.data} />}
    </>
  );
}
function TargetForm({ settings }: { settings: Model<"QualitySettingsOut"> }) {
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
      title="Row Match Rate target"
      subtitle="One environment-wide minimum, shown against the recorded rate of every comparison."
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setSaved(false);
          try {
            const result = await patch<Model<"QualitySettingsOut">>(
              "/settings/quality",
              { row_match_target_percentage: enabled ? Number(value) : null },
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
          />
          Enable quality target
        </label>
        <label>
          Minimum Row Match Rate (%)
          <input
            type="number"
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
        <p className="muted">
          Current saved target:{" "}
          {settings.row_match_target_percentage == null
            ? "Disabled"
            : percent(settings.row_match_target_percentage)}
          . The initial target is 95%. You can choose any value from 0 to 100%
          or disable it.
        </p>
        <p className="notice">
          This target applies to Row Match Rate only. It does not replace
          volume, key integrity or coverage checks, and does not change saved
          analytical conclusions. The daily chart uses the current target as a
          reference for the entire displayed period.
        </p>
        {!canEdit && (
          <p className="muted">
            You can view this setting. A Quality Manager or Platform
            Administrator can update it.
          </p>
        )}
        <div className="actions">
          {canEdit && (
            <Button disabled={busy} type="submit">
              {busy ? "Saving…" : "Save target"}
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to="/">View Overview</Link>
          </Button>
        </div>
        {saved && <p role="status">Quality target saved.</p>}
      </form>
    </Card>
  );
}
