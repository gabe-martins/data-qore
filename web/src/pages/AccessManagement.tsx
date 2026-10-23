import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, allPages, post, patch, type Page } from "../api";
import { profileLabels, profileDescriptions } from "../lib/access";
import { Button, Card, ErrorBox, Loading, PageTitle, Pagination } from "../components/common";
import { Dialog, DialogContent } from "../components/ui/dialog";
type Group = { id: string; name: string; description: string; profile: string; permissions: string[]; user_count?: number };
type Account = { id: string; email: string; display_name: string; group_id: string; group: Group; is_active: boolean; must_change_password: boolean };
type Audit = { id: string; actor_user_id: string | null; action: string; resource_type: string; resource_id: string | null; request_id: string; outcome: string; created_at: string };
type View = "users" | "groups" | "audit";
export function AccessManagement({ view }: { view: View }) {
  return <Management key={view} view={view} />;
}
function Management({ view }: { view: View }) {
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Account | Group | "new" | null>(null);
  const [resetting, setResetting] = useState<Account | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; path: string; method: "POST" | "DELETE" } | null>(null);
  const [profile, setProfile] = useState("viewer");
  const [notice, setNotice] = useState("");
  const endpoint = view === "audit" ? "audit-log" : view;
  const query = useQuery({ queryKey: ["access", view, search, offset], queryFn: () => api<Page<Account | Group | Audit>>(`/${endpoint}?limit=20&offset=${offset}&search=${encodeURIComponent(search)}`) });
  const groups = useQuery({ queryKey: ["access", "group-options"], queryFn: () => allPages<Group>("/groups"), enabled: view === "users" });
  async function execute(work: () => Promise<unknown>, message: string) {
    setBusy(true); setError(null); setNotice("");
    try { await work(); setEditing(null); setResetting(null); setConfirmation(null); setNotice(message); await cache.invalidateQueries({ queryKey: ["access"] }); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  function edit(row: Account | Group | "new") { setError(null); setEditing(row); setProfile(row !== "new" && "profile" in row ? row.profile : "viewer"); }
  const user = editing && editing !== "new" && "email" in editing ? editing : null;
  const group = editing && editing !== "new" && "profile" in editing ? editing : null;
  return <>
    <PageTitle title={view === "audit" ? "Security audit" : view === "users" ? "Users" : "Groups"}
      subtitle={view === "users" ? "Each user belongs to one group and inherits its access profile." : view === "groups" ? "Groups organize teams; their profile determines platform permissions." : "Administrative changes and denied access attempts."}
      action={view !== "audit" ? <Button onClick={() => edit("new")}>New {view === "users" ? "user" : "group"}</Button> : undefined} />
    <ErrorBox error={query.error || groups.error || (!editing && !resetting && !confirmation ? error : null)} />
    {notice && <p role="status">{notice}</p>}
    <Card><label>Search<input value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} /></label>
      {query.isPending ? <Loading /> : <div className="table-scroll"><table><thead><tr>
        {view === "users" ? <><th>Name</th><th>Email</th><th>Group / profile</th><th>Status</th><th>Actions</th></> : view === "groups" ? <><th>Name</th><th>Profile</th><th>Users</th><th>Actions</th></> : <><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th><th>Request</th></>}
      </tr></thead><tbody>{query.data?.items.map(row => {
        if (view === "users") { const u = row as Account; return <tr key={u.id}><td>{u.display_name}</td><td>{u.email}</td><td>{u.group.name} / {profileLabels[u.group.profile]}</td><td>{u.is_active ? "Active" : "Inactive"}{u.must_change_password ? " · Password change required" : ""}</td><td>
          <Button variant="outline" onClick={() => edit(u)}>Edit user</Button>{" "}<Button variant="outline" onClick={() => { setError(null); setResetting(u); }}>Reset password</Button>{" "}<Button variant="outline" onClick={() => setConfirmation({ title: "Revoke sessions", description: `Sign out every session for ${u.email}?`, path: `/users/${u.id}/revoke-sessions`, method: "POST" })}>Revoke sessions</Button>
        </td></tr>; }
        if (view === "groups") { const g = row as Group; return <tr key={g.id}><td>{g.name}<p>{g.description}</p></td><td>{profileLabels[g.profile]}</td><td>{g.user_count}</td><td><Button variant="outline" onClick={() => edit(g)}>Edit group</Button>{" "}<Button variant="outline" disabled={!!g.user_count} onClick={() => setConfirmation({ title: "Delete group", description: `Delete the empty group ${g.name}?`, path: `/groups/${g.id}`, method: "DELETE" })}>Delete group</Button></td></tr>; }
        const a = row as Audit; return <tr key={a.id}><td>{new Date(a.created_at).toLocaleString()}</td><td>{a.actor_user_id ?? "Unauthenticated"}</td><td>{a.action}</td><td>{a.resource_type} {a.resource_id}</td><td>{a.outcome}</td><td>{a.request_id}</td></tr>;
      })}</tbody></table>{query.data?.total === 0 && <p>No records found.</p>}</div>}
      <Pagination total={query.data?.total ?? 0} offset={offset} setOffset={setOffset} />
    </Card>
    <Dialog open={editing !== null} onOpenChange={open => { if (!open && !busy) setEditing(null); }}>
      {editing && <DialogContent title={`${editing === "new" ? "New" : "Edit"} ${view === "users" ? "user" : "group"}`} description={view === "users" ? "Access comes from the selected group. Temporary passwords must be delivered through your approved external channel." : "Changing a profile signs out all group members. Review its permissions before saving."}>
        <ErrorBox error={error} />
        <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
          const body = view === "users" ? { display_name: String(f.get("name")), email: String(f.get("email")), group_id: String(f.get("group")), is_active: f.get("active") === "on", ...(editing === "new" ? { temporary_password: String(f.get("password")) } : {}) } : { name: String(f.get("name")), description: String(f.get("description")), profile };
          void execute(() => editing === "new" ? post(`/${view}`, body) : patch(`/${view}/${editing!.id}`, body), "Changes saved.");
        }}>
          <label>Name<input name="name" required maxLength={255} defaultValue={user?.display_name ?? group?.name ?? ""} /></label>
          {view === "users" ? <>
            <label>Email<input name="email" type="email" required maxLength={320} defaultValue={user?.email ?? ""} /></label>
            <label>Group<select name="group" required defaultValue={user?.group_id ?? ""}><option value="" disabled>Select group</option>{groups.data?.items.map(g => <option key={g.id} value={g.id}>{g.name} — {profileLabels[g.profile]}</option>)}</select></label>
            <p className="muted">Only Platform Administrators can change access. Deactivation signs out all sessions.</p>
            <label><input type="checkbox" name="active" defaultChecked={user?.is_active ?? true} /> Active</label>
            {editing === "new" && <label>Temporary password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>}
          </> : <>
            <label>Description<textarea name="description" maxLength={1000} defaultValue={group?.description ?? ""} /></label>
            <label>Access profile<select value={profile} onChange={e => setProfile(e.target.value)}>{Object.entries(profileLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <p role="status">{profileDescriptions[profile]}</p>
          </>}
          <div className="form-footer"><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy}>{busy ? "Saving…" : "Save"}</Button></div>
        </form>
      </DialogContent>}
    </Dialog>
    <Dialog open={!!resetting} onOpenChange={open => { if (!open && !busy) setResetting(null); }}>
      {resetting && <DialogContent title="Reset password" description={`Set a temporary password for ${resetting.email}. All sessions will be revoked; a password change is required on next access.`}>
        <ErrorBox error={error} /><form onSubmit={e => { e.preventDefault(); const temporary_password = String(new FormData(e.currentTarget).get("password")); void execute(() => post(`/users/${resetting.id}/reset-password`, { temporary_password }), "Password reset. Deliver the temporary password through your approved external channel."); }}>
          <label>Temporary password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label><Button disabled={busy}>Reset password</Button>
        </form>
      </DialogContent>}
    </Dialog>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
      {confirmation && <DialogContent title={confirmation.title} description={confirmation.description}><ErrorBox error={error} /><Button disabled={busy} onClick={() => void execute(() => api(confirmation.path, { method: confirmation.method, ...(confirmation.method === "POST" ? { body: "{}" } : {}) }), "Operation completed.")}>Confirm</Button></DialogContent>}
    </Dialog>
  </>;
}
