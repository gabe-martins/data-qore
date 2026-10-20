import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError, type Model } from "../api";
import { Badge, Button, ErrorBox, Loading, Pagination } from "./common";
import { Dialog, DialogContent } from "./ui/dialog";

export function DeleteComparisonDialog({comparison,onClose,onDeleted,returnFocus}: {
  comparison: Pick<Model<"ComparisonOut">,"id"|"name"|"is_active">;
  onClose: () => void;
  onDeleted: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [offset,setOffset]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<unknown>(null);
  const locked=useRef(false),deleted=useRef(false);
  const cache=useQueryClient();
  const q=useQuery({queryKey:["comparison-dependencies",comparison.id,offset],staleTime:0,retry:false,
    queryFn:()=>api<Model<"ComparisonDeletionPreviewOut">>(`/comparisons/${comparison.id}/dependencies?schedule_limit=20&schedule_offset=${offset}`)});
  async function remove() {
    if(locked.current || q.isFetching || q.error || !q.data?.can_delete)return;
    locked.current=true;setBusy(true);setError(null);
    try {
      await api<Model<"ComparisonDeletedOut">>(`/comparisons/${comparison.id}`,{method:"DELETE",body:JSON.stringify({})});
      deleted.current=true;
      onDeleted();
      for(const key of ["comparisons","comparison","comparison-runs","comparison-latest-success","overview","quality-trend",
        "runs","run","result","metrics","profiles","dataset-dependencies","connection-dependencies","schedule-comparisons"])
        void cache.invalidateQueries({queryKey:[key]});
    } catch(e) {
      setError(e);
      if(e instanceof ApiError && e.status===409) {setOffset(0);await q.refetch();}
    } finally {locked.current=false;setBusy(false);}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!locked.current)onClose();}}>
    <DialogContent title="Delete comparison" description="Review schedules and execution history before permanently deleting this comparison."
      returnFocus={()=>deleted.current?returnFocus():null}>
      <div className="comparison-delete-dialog" aria-busy={busy}>
        <p className="dataset-delete-location"><strong>{comparison.name}</strong> <Badge value={comparison.is_active?"active":"inactive"}/></p>
        <ErrorBox error={q.error||error}/>
        {q.isPending?<Loading/>:q.error?<Button variant="outline" onClick={()=>void q.refetch()}>Retry dependency check</Button>:q.data&&<>
          <section aria-label="Linked schedules" className="connection-dependencies">
            <h3>Schedules ({q.data.schedules.total})</h3>
            {q.data.schedules.items.length?<ul>{q.data.schedules.items.map(s=><li key={s.id}>
              <Link to={`/schedules?comparison_id=${s.comparison_id}`} onClick={onClose}>{s.name}</Link>{" "}
              <Badge value={s.is_active?"active":"inactive"}/>{" "}
              <span className="muted">{[s.current&&"Current",s.historical&&"Historical"].filter(Boolean).join(" · ")}</span>
            </li>)}</ul>:<p className="muted">No linked schedules.</p>}
            <Pagination total={q.data.schedules.total} offset={offset} setOffset={setOffset}/>
          </section>
          <section aria-label="Comparison execution history" className="connection-dependencies">
            <h3>Execution history</h3>
            <dl className="dataset-delete-counts">
              <div><dt>Runs</dt><dd>{q.data.history.runs}</dd></div>
              <div><dt>Results</dt><dd>{q.data.history.results}</dd></div>
              <div><dt>Column profiles</dt><dd>{q.data.history.column_profiles}</dd></div>
              <div><dt>Metrics</dt><dd>{q.data.history.metrics}</dd></div>
            </dl>
          </section>
          {!!q.data.schedules.total&&<p className="notice warning" role="status">This comparison has current or historical schedules and cannot be deleted. Paused schedules also block deletion.</p>}
          {!!q.data.active_runs&&<p className="notice warning" role="status">{q.data.active_runs} queued or running run(s). Wait for them to finish before deleting.</p>}
          {!q.data.can_delete&&<Button variant="outline" disabled={q.isFetching} onClick={()=>void q.refetch()}>Refresh dependencies</Button>}
          {q.data.can_delete&&<p className="notice warning" role="status">This permanently deletes the comparison and all its runs, results, column profiles and metrics. This cannot be undone. Datasets, connections, individual profile history and source data will remain unchanged.</p>}
        </>}
        <div className="form-footer">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy||q.isFetching||!!q.error||!q.data?.can_delete} onClick={()=>void remove()}>{busy?"Deleting…":"Delete comparison and run history"}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
