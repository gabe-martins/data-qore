import { useLanguage } from "../i18n/LanguageProvider";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus, Search, Trash2 } from "lucide-react";
import { api, patch, post, type Model, type Page } from "../api";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  PageTitle,
  Pagination,
} from "../components/common";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { DeleteConnectionDialog } from "../components/DeleteConnectionDialog";
type Connection = Model<"ConnectionOut">;
export function Connections() {
  const { t: tr, locale } = useLanguage();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Connection | null | undefined>();
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const cache = useQueryClient();
  const newConnectionButton = useRef<HTMLButtonElement>(null);
  const q = useQuery({
    queryKey: ["connections", search, offset],
    queryFn: () =>
      api<Page<Connection>>(
        `/connections?limit=20&offset=${offset}&search=${encodeURIComponent(search)}`,
      ),
  });
  async function test(c: Connection) {
    setBusy(c.id);
    setError(null);
    try {
      await post(`/connections/${c.id}/test`);
      setTests((v) => ({ ...v, [c.id]: new Date().toISOString() }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <PageTitle
        title={tr("Connections")}
        subtitle={tr("Manage your data sources and validate access before analysis.")}
      />
      <div className="toolbar">
        <div className="search">
          <Search size={20} />
          <input
            aria-label={tr("Search connections")}
            placeholder={tr("Search connections…")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <Button ref={newConnectionButton} onClick={() => setEditing(null)}>
          <Plus size={18} />{tr("New connection")}</Button>
      </div>
      <ErrorBox error={q.error || error} />
      {q.isPending ? (
        <Loading />
      ) : q.data?.items.length ? (
        q.data.items.map((c) => (
          <Card key={c.id} className="connection-card">
            <div className="card-heading">
              <div className="resource-title">
                <span className="resource-icon">
                  <Database />
                </span>
                <div>
                  <h2>{c.name}</h2>
                  <span className="muted">{c.connector}</span>
                </div>
              </div>
              <Badge value={c.is_active ? "active" : "inactive"} />
            </div>
            <div className="connection-meta">
              <div>
                <span className="muted">{tr("Registered datasets")}</span>
                <strong>{c.dataset_count}</strong>
              </div>
              <div>
                <span className="muted">{tr("Credential access")}</span>
                <strong>{tr("Encrypted · write only")}</strong>
              </div>
            </div>
            <div className="card-bottom">
              <span className="muted small">
                {tests[c.id]
                  ? tr("Tested this session at {0}", {0: new Date(tests[c.id]).toLocaleTimeString(locale)})
                  : tr("Not tested in this session")}
              </span>
              <div className="actions">
                <Button variant="outline" onClick={() => setEditing(c)}>{tr("Edit")}</Button>
                <Button
                  variant="outline"
                  disabled={!c.is_active || busy === c.id}
                  onClick={() => test(c)}
                >
                  {busy === c.id ? tr("Testing…") : tr("Test")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await patch("/connections/" + c.id, {
                        is_active: !c.is_active,
                      });
                      await cache.invalidateQueries({
                        queryKey: ["connections"],
                      });
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  {c.is_active ? tr("Deactivate") : tr("Activate")}
                </Button>
                <Button variant="outline" onClick={() => setDeleting(c)}>
                  <Trash2 size={16} aria-hidden="true" />{tr(" Delete")}</Button>
              </div>
            </div>
          </Card>
        ))
      ) : (
        <Card>
          <Empty title={tr("No connections found")}>{tr("Add a read-only source to explore its catalog.")}</Empty>
        </Card>
      )}
      {q.data && (
        <Pagination
          total={q.data.total}
          offset={offset}
          setOffset={setOffset}
        />
      )}
      <Dialog
        open={editing !== undefined}
        onOpenChange={(v) => {
          if (!v) setEditing(undefined);
        }}
      >
        {editing !== undefined && (
          <ConnectionForm
            key={editing?.id ?? "new"}
            connection={editing}
            onSaved={() => {
              setEditing(undefined);
              void cache.invalidateQueries({ queryKey: ["connections"] });
            }}
          />
        )}
      </Dialog>
      {deleting && (
        <DeleteConnectionDialog
          connection={deleting}
          returnFocus={() => newConnectionButton.current}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setOffset(0);
            void cache.invalidateQueries({ queryKey: ["connections"] });
          }}
        />
      )}
    </>
  );
}
function ConnectionForm({
  connection,
  onSaved,
}: {
  connection: Connection | null;
  onSaved: () => void;
}) {
  const { t: tr } = useLanguage();
  const [connector, setConnector] = useState<string>(
    connection?.connector ?? "postgresql",
  );
  const [authType,setAuthType] = useState("pat");
  const [replace, setReplace] = useState(!connection);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(connection?.name ?? "");
  const drivers = useQuery({
    queryKey: ["connectors"],
    queryFn: () => api<Model<"ConnectorOut">[]>("/connectors"),
  });
  const ports: Record<string, number> = {
    postgresql: 5432,
    mysql: 3306,
    mssql: 1433,
    oracle: 1521,
  };
  function payload(form: HTMLFormElement) {
    const f = new FormData(form);
    if(connector === "databricks") return {connector,credentials:{hostname:f.get("hostname"),http_path:f.get("http_path"),auth_type:authType,
      ...(authType === "pat" ? {access_token:f.get("access_token")} : {client_id:f.get("client_id"),client_secret:f.get("client_secret")})}};
    const credentials: Record<string, unknown> = {
      database: f.get("database"),
    };
    if (connector !== "sqlite") {
      Object.assign(credentials, {
        hostname: f.get("hostname"),
        username: f.get("username"),
        password: f.get("password"),
        port: Number(f.get("port")),
      });
      if (["postgresql", "mysql", "oracle"].includes(connector)) credentials.sslmode = f.get("sslmode");
      if (connector === "mssql")
        credentials.trust_server_certificate = f.get("trust") === "on";
    }
    return { connector, credentials };
  }
  return (
    <DialogContent
      title={connection ? tr("Edit connection") : tr("New connection")}
      description={tr("Configure a read-only data source. Credentials are never returned by the API.")}
    >
      <form
        onChange={() => setMessage("")}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          setBusy(true);
          setError(null);
          try {
            if (connection)
              await patch("/connections/" + connection.id, {
                name,
                ...(replace ? { credentials: payload(form).credentials } : {}),
              });
            else await post("/connections", { name, ...payload(form) });
            onSaved();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label>{tr("Connection name")}<input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              placeholder={tr("e.g. sales_production")}
            />
          </label>
          <label>{tr("Database type")}<select
              aria-label={tr("Database type")}
              value={connector}
              disabled={!!connection}
              onChange={(e) => setConnector(e.target.value)}
            >
              {["postgresql", "mysql", "mssql", "oracle", "sqlite", "databricks"].map((c) => (
                <option key={c} value={c}>
                  {c}
                  {drivers.data?.find((d) => d.connector === c)?.available ===
                  false
                    ? tr(" — driver unavailable")
                    : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {connection && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />{tr("Replace all credentials")}</label>
        )}
        {replace && (
          <div key={connector}>
            <div className="form-grid">
              {connector !== "sqlite" && connector !== "databricks" && (
                <>
                  <label>{tr("Host / address")}<input
                      name="hostname"
                      required
                      placeholder="db.company.com"
                    />
                  </label>
                  <label>{tr("Port")}<input
                      name="port"
                      type="number"
                      min="1"
                      max="65535"
                      defaultValue={ports[connector]}
                      required
                    />
                  </label>
                  <label>{tr("User")}<input name="username" required autoComplete="off" />
                  </label>
                  <label>{tr("Password")}<input
                      name="password"
                      type="password"
                      required
                      autoComplete="new-password"
                    />
                  </label>
                </>
              )}
              {connector === "databricks" && <>
                <label>{tr("Server hostname")}<input name="hostname" required placeholder="workspace.azuredatabricks.net" autoComplete="off" /></label>
                <label>{tr("HTTP path")}<input name="http_path" required placeholder="/sql/1.0/warehouses/warehouse-id" autoComplete="off" /></label>
                <label>{tr("Authentication")}<select aria-label={tr("Databricks authentication")} value={authType} onChange={e=>setAuthType(e.target.value)}><option value="pat">{tr("Personal access token (PAT)")}</option><option value="oauth_m2m">{tr("OAuth M2M — service principal")}</option></select></label>
                {authType === "pat" ? <label>{tr("Access token")}<input name="access_token" type="password" required autoComplete="new-password" /></label> : <>
                  <label>{tr("Client ID")}<input name="client_id" required autoComplete="off" /></label>
                  <label>{tr("Client secret")}<input name="client_secret" type="password" required autoComplete="new-password" /></label>
                </>}
                <p className="notice">{tr("Use a Unity Catalog SQL Warehouse with read-only permissions. Choose catalog and schema in Catalog after saving. OAuth tokens renew automatically.")}</p>
              </>}
              {connector !== "databricks" && <>
              <label>
                {connector === "sqlite"
                  ? tr("SQLite file")
                  : connector === "oracle"
                    ? tr("Service name")
                    : tr("Database")}
                <input
                  name="database"
                  required
                  placeholder={
                    connector === "sqlite" ? "origin.sqlite" : "analytics"
                  }
                />
              </label>
              </>}
              {["postgresql", "mysql", "oracle"].includes(connector) && (
                <label>{tr("SSL mode")}<select name="sslmode" defaultValue="verify-full">
                    {[
                      "disable",
                      "allow",
                      "prefer",
                      "require",
                      "verify-ca",
                      "verify-full",
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {connector === "mssql" && (
              <label className="check-label">
                <input name="trust" type="checkbox" />{tr("Trust server certificate (explicit local exception)")}</label>
            )}
            {connector === "sqlite" && (
              <p className="notice">{tr("Select an existing file inside the engine’s SQLITE_ALLOWED_ROOT directory. File upload is not supported.")}</p>
            )}
          </div>
        )}
        <ErrorBox error={error} />
        {message && (
          <p className="notice success" role="status">
            {tr(message)}
          </p>
        )}
        <div className="form-footer">
          <span className="muted small">{tr("A read-only source account is recommended.")}</span>
          <Button
            type="button"
            variant="outline"
            aria-disabled={busy}
            onClick={async (e) => {
              if (busy) return;
              const form = e.currentTarget.form!;
              if (!form.reportValidity()) return;
              setBusy(true);
              setError(null);
              try {
                if (replace) await post("/connections/test", payload(form));
                else if (connection)
                  await post(`/connections/${connection.id}/test`);
                setMessage("Connection test succeeded.");
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? tr("Working…") : tr("Test connection")}
          </Button>
          <Button disabled={busy}>
            {connection ? tr("Save changes") : tr("Save connection")}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
