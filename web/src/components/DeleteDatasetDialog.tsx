import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError, type Model } from "../api";
import { Badge, Button, ErrorBox, Loading, Pagination } from "./common";
import { Dialog, DialogContent } from "./ui/dialog";

export function DeleteDatasetDialog({dataset, onClose, onDeleted, returnFocus}: {
  dataset: Model<"DatasetOut">;
  onClose: () => void;
  onDeleted: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = useRef(false);
  const deleted = useRef(false);
  const q = useQuery({
    queryKey: ["dataset-dependencies", dataset.id, offset],
    queryFn: () => api<Model<"DatasetDependenciesOut">>(`/datasets/${dataset.id}/dependencies?comparison_limit=20&comparison_offset=${offset}`),
    staleTime: 0,
    retry: false,
  });
  const history = q.data?.profile_history;
  async function remove() {
    if (locked.current || q.isFetching || q.error || !q.data?.can_delete) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await api<Model<"DatasetDeletedOut">>(`/datasets/${dataset.id}`, {method:"DELETE", body:JSON.stringify({})});
      deleted.current = true;
      onDeleted();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.status === 409) {
        setOffset(0);
        await q.refetch();
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={open => {if (!open && !locked.current) onClose();}}>
    <DialogContent title="Delete dataset" description="Review dependencies and profile history. Source tables and data will remain unchanged."
      returnFocus={() => deleted.current ? returnFocus() : null}>
      <div className="dataset-delete-dialog" aria-busy={busy}>
        <p className="dataset-delete-location"><strong>{[dataset.catalog_name,dataset.schema_name,dataset.table_name].filter(Boolean).join(".")}</strong></p>
        <ErrorBox error={q.error || error} />
        {q.isPending ? <Loading /> : q.error ? <Button variant="outline" onClick={() => void q.refetch()}>Retry dependency check</Button> : q.data && <>
          <p className="muted dataset-delete-location">Connection: {q.data.dataset.connection_name}</p>
          <section aria-label="Linked comparisons" className="connection-dependencies">
            <h3>Comparisons ({q.data.comparisons.total})</h3>
            {q.data.comparisons.items.length ? <ul>{q.data.comparisons.items.map(c => <li key={c.id}>
              <Link to={`/comparisons/${c.id}`} onClick={onClose}>{c.name}</Link>{" "}
              <Badge value={c.is_active ? "active" : "inactive"} />{" "}
              <span className="muted">{[c.current && "Current",c.historical && "Historical"].filter(Boolean).join(" · ")}</span>
            </li>)}</ul> : <p className="muted">No linked comparisons.</p>}
            <Pagination total={q.data.comparisons.total} offset={offset} setOffset={setOffset} />
          </section>
          <section aria-label="Individual profile history" className="connection-dependencies">
            <h3>Individual profile history</h3>
            <dl className="dataset-delete-counts">
              <div><dt>Profile runs</dt><dd>{history!.runs}</dd></div>
              <div><dt>Results</dt><dd>{history!.results}</dd></div>
              <div><dt>Column profiles</dt><dd>{history!.column_profiles}</dd></div>
              <div><dt>Metrics</dt><dd>{history!.metrics}</dd></div>
            </dl>
          </section>
          {!!q.data.comparisons.total && <p className="notice warning" role="status">This dataset is used by current or historical comparisons and cannot be deleted. Inactive comparisons also block deletion.</p>}
          {!!q.data.active_profile_runs && <p className="notice warning" role="status">{q.data.active_profile_runs} queued or running profile(s). Wait for them to finish, then refresh the dependency check.</p>}
          {!q.data.can_delete && <Button variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>Refresh dependencies</Button>}
          {q.data.can_delete && <p className="notice warning" role="status">{history!.runs
            ? "This permanently deletes the dataset registration and all its individual profile runs, results, column profiles and metrics. This cannot be undone."
            : "This permanently deletes the dataset registration. No profile history was found."} Source tables and data will remain unchanged.</p>}
        </>}
        <div className="form-footer">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || q.isFetching || !!q.error || !q.data?.can_delete} onClick={() => void remove()}>
            {busy ? "Deleting…" : history?.runs ? "Delete dataset and profile history" : "Delete dataset"}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
