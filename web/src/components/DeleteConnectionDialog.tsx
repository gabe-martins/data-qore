import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError, type Model } from "../api";
import { Badge, Button, ErrorBox, Loading, Pagination } from "./common";
import { Dialog, DialogContent } from "./ui/dialog";

export function DeleteConnectionDialog({ connection, onClose, onDeleted, returnFocus }: {
  connection: Model<"ConnectionOut">;
  onClose: () => void;
  onDeleted: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [datasetOffset, setDatasetOffset] = useState(0);
  const [comparisonOffset, setComparisonOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const deleted = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ["connection-dependencies", connection.id, datasetOffset, comparisonOffset],
    queryFn: () => api<Model<"ConnectionDependenciesOut">>(
      `/connections/${connection.id}/dependencies?dataset_limit=20&dataset_offset=${datasetOffset}&comparison_limit=20&comparison_offset=${comparisonOffset}`,
    ),
    // Always check again when opening a confirmation, including cached previews.
    staleTime: 0,
    retry: false,
  });
  async function remove() {
    if (locked.current || q.isFetching || !q.data?.can_delete || q.error) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await api<Model<"ConnectionDeletedOut">>(`/connections/${connection.id}`, {
        method: "DELETE", body: JSON.stringify({}),
      });
      deleted.current = true;
      onDeleted();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.status === 409) {
        setDatasetOffset(0);
        setComparisonOffset(0);
        await q.refetch();
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !locked.current) onClose(); }}>
      <DialogContent title="Delete connection" description="Review registered dependencies before permanently deleting this connection."
        returnFocus={() => deleted.current ? returnFocus() : null}>
        <div aria-busy={busy}>
          <p><strong>{connection.name}</strong> <span className="muted">· {connection.connector}</span></p>
          <ErrorBox error={q.error || error} />
          {q.isPending ? <Loading /> : q.error ? (
            <Button variant="outline" onClick={() => void q.refetch()}>Retry dependency check</Button>
          ) : q.data && <>
            <section aria-label="Registered datasets" className="connection-dependencies">
              <h3>Catalog datasets ({q.data.datasets.total})</h3>
              {q.data.datasets.items.length ? <ul>
                {q.data.datasets.items.map(d => <li key={d.id}>
                  <Link to={`/datasets/${d.id}`} onClick={onClose}>
                    {[d.catalog_name, d.schema_name, d.table_name].filter(Boolean).join(".")}
                  </Link>{d.table_type && <span className="muted"> · {d.table_type}</span>}
                </li>)}
              </ul> : <p className="muted">No registered datasets.</p>}
              <Pagination total={q.data.datasets.total} offset={datasetOffset} setOffset={setDatasetOffset} />
            </section>
            <section aria-label="Linked comparisons" className="connection-dependencies">
              <h3>Comparisons ({q.data.comparisons.total})</h3>
              {q.data.comparisons.items.length ? <ul>
                {q.data.comparisons.items.map(c => <li key={c.id}>
                  <Link to={`/comparisons/${c.id}`} onClick={onClose}>{c.name}</Link>{" "}
                  <Badge value={c.is_active ? "active" : "inactive"} />
                </li>)}
              </ul> : <p className="muted">No linked comparisons.</p>}
              <Pagination total={q.data.comparisons.total} offset={comparisonOffset} setOffset={setComparisonOffset} />
            </section>
            {!q.data.can_delete ? <p className="notice warning" role="status">
              This connection is in use and cannot be deleted. Close this dialog and use Deactivate on its card to disable it. Datasets, comparisons, history and schedules will be preserved.
            </p> : <p className="notice">No dependencies found. Confirm to permanently delete this connection.</p>}
          </>}
          <div className="form-footer">
            <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button disabled={busy || q.isFetching || !!q.error || !q.data?.can_delete} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete connection"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
