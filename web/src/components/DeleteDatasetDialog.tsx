import { useLanguage } from "../i18n/LanguageProvider";
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
  const { t: tr } = useLanguage();
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
    <DialogContent title={tr("Delete dataset")} description={tr("Review linked comparisons. Source tables and data will remain unchanged.")}
      returnFocus={() => deleted.current ? returnFocus() : null}>
      <div className="dataset-delete-dialog" aria-busy={busy}>
        <p className="dataset-delete-location"><strong>{[dataset.catalog_name,dataset.schema_name,dataset.table_name].filter(Boolean).join(".")}</strong></p>
        <ErrorBox error={q.error || error} />
        {q.isPending ? <Loading /> : q.error ? <Button variant="outline" onClick={() => void q.refetch()}>{tr("Retry dependency check")}</Button> : q.data && <>
          <p className="muted dataset-delete-location">{tr("Connection: ")}{q.data.dataset.connection_name}</p>
          <section aria-label={tr("Linked comparisons")} className="connection-dependencies">
            <h3>{tr("Comparisons (")}{q.data.comparisons.total})</h3>
            {q.data.comparisons.items.length ? <ul>{q.data.comparisons.items.map(c => <li key={c.id}>
              <Link to={`/comparisons/${c.id}`} onClick={onClose}>{c.name}</Link>{" "}
              <Badge value={c.is_active ? "active" : "inactive"} />{" "}
              <span className="muted">{[c.current && tr("Current"),c.historical && tr("Historical")].filter(Boolean).join(" · ")}</span>
            </li>)}</ul> : <p className="muted">{tr("No linked comparisons.")}</p>}
            <Pagination total={q.data.comparisons.total} offset={offset} setOffset={setOffset} />
          </section>
          {!!q.data.comparisons.total && <p className="notice warning" role="status">{tr("This dataset is used by current or historical comparisons and cannot be deleted. Inactive comparisons also block deletion.")}</p>}
          {!q.data.can_delete && <Button variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>{tr("Refresh dependencies")}</Button>}
          {q.data.can_delete && <p className="notice warning">{tr("This permanently deletes the dataset registration.")}</p>}
        </>}
        <div className="form-footer">
          <Button variant="outline" disabled={busy} onClick={onClose}>{tr("Cancel")}</Button>
          <Button disabled={busy || q.isFetching || !!q.error || !q.data?.can_delete} onClick={() => void remove()}>
            {busy ? tr("Deleting…") : tr("Delete dataset")}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
