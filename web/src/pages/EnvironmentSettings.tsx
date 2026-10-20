import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, patch, type Model } from "../api";
import { Button, Card, ErrorBox, Loading, PageTitle } from "../components/common";

export function EnvironmentSettings() {
  const cache = useQueryClient();
  const q = useQuery({ queryKey: ["environment-settings"], queryFn: () => api<Model<"EnvironmentSettingsOut">>("/environment-settings") });
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (q.data) setTarget(q.data.comparison_target_percentage); }, [q.data]);
  return <>
    <PageTitle title="Environment settings" subtitle="Shared settings for this DataQore environment." />
    <ErrorBox error={error || q.error} />
    {q.isPending ? <Loading /> : q.data && <Card title="Comparison agreement target">
      <form onSubmit={async event => {
        event.preventDefault(); setError(null); setSaved(false); setBusy(true);
        try {
          const value = target.trim().replace(",", ".");
          if (!/^(?:100(?:\.0{1,4})?|\d{1,2}(?:\.\d{1,4})?)$/.test(value)) throw new Error("Enter a percentage from 0 to 100 with up to four decimal places.");
          const updated = await patch<Model<"EnvironmentSettingsOut">>("/environment-settings", { comparison_target_percentage: value });
          cache.setQueryData(["environment-settings"], updated);
          await cache.invalidateQueries({ queryKey: ["environment-settings"] });
          setSaved(true);
        } catch (e) { setError(e); } finally { setBusy(false); }
      }}>
        <label>Agreement target (%)<input aria-label="Agreement target (%)" inputMode="decimal" value={target} onChange={e => { setTarget(e.target.value); setSaved(false); }} required aria-describedby="target-help" /></label>
        <p id="target-help" className="muted">A global reference line for the Overview chart. This percentage measures agreement between evaluated sample positions, not whole-table accuracy. Changing it does not modify comparisons, tolerances, runs or schedules.</p>
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button>
        {saved && <p role="status">Environment settings saved.</p>}
      </form>
    </Card>}
  </>;
}
