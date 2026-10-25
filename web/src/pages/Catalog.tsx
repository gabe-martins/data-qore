import { useLanguage } from "../i18n/LanguageProvider";
import { Allowed, useCan } from "../lib/access";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Database, RefreshCw, Trash2 } from "lucide-react";
import { DeleteDatasetDialog } from "../components/DeleteDatasetDialog";
import { api, allPages, post, type Model, type Page } from "../api";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  JsonView,
  Loading,
  PageTitle,
  Pagination,
  Stat,
} from "../components/common";
export function Catalog() {
  const canExplore = useCan("catalog.read");
  return canExplore ? <LiveCatalog /> : <RegisteredDatasets />;
}
function RegisteredDatasets() {
  const { t: tr } = useLanguage();
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ["registered-datasets", offset], queryFn: () => api<Page<Model<"DatasetOut">>>("/datasets?limit=20&offset=" + offset) });
  return <><PageTitle title={tr("Catalog")} subtitle={tr("Registered datasets available for comparison.")} /><ErrorBox error={q.error} />{q.isPending ? <Loading /> : <Card title={tr("Registered datasets")}>{q.data?.items.map(d => <p key={d.id}><Link to={`/datasets/${d.id}`}>{[d.catalog_name, d.schema_name, d.table_name].filter(Boolean).join(".")}</Link></p>)}<Pagination total={q.data?.total ?? 0} offset={offset} setOffset={setOffset} /></Card>}</>;
}
function LiveCatalog() {
  const { t: tr } = useLanguage();
  const [connection, setConnection] = useState("");
  const [catalog, setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [offset, setOffset] = useState(0);
  const [datasetOffset, setDatasetOffset] = useState(0);
  const [deleting, setDeleting] = useState<Model<"DatasetOut"> | null>(null);
  const connectionSelect = useRef<HTMLSelectElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const cache = useQueryClient();
  const connections = useQuery({
    queryKey: ["catalog-connections"],
    queryFn: () => allPages<Model<"ConnectionOut">>("/connections"),
  });
  const databricks =
    connections.data?.items.find((c) => c.id === connection)?.connector ===
    "databricks";
  const catalogs = useQuery({
    queryKey: ["catalogs", connection],
    queryFn: () => allPages<string>(`/connections/${connection}/catalogs`),
    enabled: !!connection && databricks,
  });
  const schemas = useQuery({
    queryKey: ["schemas", connection, catalog],
    queryFn: () =>
      allPages<string>(
        `/connections/${connection}/schemas${databricks ? "?catalog=" + encodeURIComponent(catalog) : ""}`,
      ),
    enabled: !!connection && (!databricks || !!catalog),
  });
  const tables = useQuery({
    queryKey: ["tables", connection, catalog, schema, offset],
    queryFn: () =>
      api<Page<Model<"TableOut">>>(
        `/connections/${connection}/tables?limit=20&offset=${offset}${databricks ? "&catalog=" + encodeURIComponent(catalog) : ""}${schema ? "&schema=" + encodeURIComponent(schema) : ""}`,
      ),
    enabled: !!connection && (!databricks || (!!catalog && !!schema)),
  });
  const datasets = useQuery({
    queryKey: ["datasets", datasetOffset],
    queryFn: () =>
      api<Page<Model<"DatasetOut">>>(
        "/datasets?limit=20&offset=" + datasetOffset,
      ),
  });
  return (
    <>
      <PageTitle
        title={tr("Catalog")}
        subtitle={tr("Explore live source metadata and register tables for comparison.")}
      />
      <ErrorBox
        error={
          error ||
          connections.error ||
          catalogs.error ||
          schemas.error ||
          tables.error ||
          datasets.error
        }
      />
      <Card title={tr("Source catalog")}>
        <div className="form-grid">
          <label>{tr("Connection")}<select
              ref={connectionSelect}
              aria-label={tr("Connection")}
              value={connection}
              onChange={(e) => {
                setConnection(e.target.value);
                setCatalog("");
                setSchema("");
                setOffset(0);
              }}
            >
              <option value="">{tr("Select a connection")}</option>
              {connections.data?.items
                .filter((c) => c.is_active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          {databricks && (
            <label>{tr("Catalog")}<select
                aria-label={tr("Unity catalog")}
                value={catalog}
                onChange={(e) => {
                  setCatalog(e.target.value);
                  setSchema("");
                  setOffset(0);
                }}
              >
                <option value="">{tr("Select a catalog")}</option>
                {catalogs.data?.items.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <label>{tr("Schema")}<select
              aria-label={tr("Schema")}
              value={schema}
              disabled={!connection || (databricks && !catalog)}
              onChange={(e) => {
                setSchema(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">
                {databricks ? tr("Select a schema") : tr("All schemas")}
              </option>
              {schemas.data?.items.filter(Boolean).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        {!connection ? (
          <Empty title={tr("Choose a source")}>{tr("Only table metadata is queried. No rows are displayed.")}</Empty>
        ) : databricks && (!catalog || !schema) ? (
          <Empty title={tr("Choose a catalog and schema")}>{tr("Select the Unity Catalog location to list tables and views.")}</Empty>
        ) : tables.isPending ? (
          <Loading />
        ) : tables.data?.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{tr("Schema")}</th>
                    <th>{tr("Table / view")}</th>
                    {databricks && <th>{tr("Type")}</th>}
                    <th>{tr("Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.data.items.map((t) => (
                    <tr key={t.schema_name + "." + t.table_name}>
                      <td>
                        {[t.catalog_name, t.schema_name]
                          .filter(Boolean)
                          .join(".") || "—"}
                      </td>
                      <td>
                        <Database size={15} /> {t.table_name}
                      </td>
                      {databricks && <td>{t.table_type}</td>}
                      <td>
                        <Button
                          variant="outline"
                          disabled={!!busy}
                          onClick={async () => {
                            setBusy(t.table_name);
                            setError(null);
                            try {
                              await post("/datasets", {
                                connection_id: connection,
                                catalog_name: t.catalog_name,
                                schema_name: t.schema_name,
                                table_name: t.table_name,
                              });
                              await cache.invalidateQueries({
                                queryKey: ["datasets"],
                              });
                            } catch (e) {
                              setError(e);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          {busy === t.table_name
                            ? tr("Registering…")
                            : tr("Register dataset")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={tables.data.total}
              offset={offset}
              setOffset={setOffset}
            />
          </>
        ) : (
          <Empty title={tr("No tables available")}>{tr("Check the selected schema and source permissions.")}</Empty>
        )}
      </Card>
      <Card
        title={tr("Registered datasets")}
        subtitle={tr("Open a dataset to inspect metadata and create comparisons.")}
      >
        {datasets.isPending ? (
          <Loading />
        ) : datasets.data?.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{tr("Table / view")}</th>
                    <th>{tr("Type")}</th>
                    <th>{tr("Location")}</th>
                    <th>{tr("Metadata")}</th>
                    <th>{tr("Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {datasets.data.items.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link to={"/datasets/" + d.id}>{d.table_name}</Link>
                      </td>
                      <td>{(d.metadata as any)?.table_type ?? "—"}</td>
                      <td>
                        {[d.catalog_name, d.schema_name]
                          .filter(Boolean)
                          .join(".") || "—"}
                      </td>
                      <td>
                        {Object.keys((d.metadata as any)?.columns ?? {}).length}{" "}{tr("columns")}</td>
                      <td>
                        <Button
                          variant="outline"
                          onClick={() => setDeleting(d)}
                        >
                          <Trash2 size={16} aria-hidden="true" />{tr(" Delete")}</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={datasets.data.total}
              offset={datasetOffset}
              setOffset={setDatasetOffset}
            />
          </>
        ) : (
          <Empty title={tr("No registered datasets")}>{tr("Choose a table from the source catalog.")}</Empty>
        )}
      </Card>
      {deleting && (
        <DeleteDatasetDialog
          dataset={deleting}
          onClose={() => setDeleting(null)}
          returnFocus={() => connectionSelect.current}
          onDeleted={() => {
            setDeleting(null);
            setDatasetOffset(0);
            for (const key of [
              "datasets",
              "wizard-datasets",
              "connections",
              "catalog-connections",
              "connection-dependencies",
              "runs",
              "overview",
            ])
              void cache.invalidateQueries({ queryKey: [key] });
            cache.removeQueries({ queryKey: ["dataset", deleting.id] });
          }}
        />
      )}
    </>
  );
}
export function DatasetDetail() {
  const { t: tr, locale } = useLanguage();
  const { id } = useParams();
  const cache = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["dataset", id],
    queryFn: () => api<Model<"DatasetOut">>(`/datasets/${id}`),
  });
  const d = q.data;
  const columns = (d?.metadata?.columns ?? {}) as Record<string, any>;
  return (
    <>
      <PageTitle
        title={d?.table_name ?? tr("Dataset")}
        subtitle={tr("Source metadata and comparison identity.")}
        action={
          <Allowed permission="datasets.manage"><Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post(`/datasets/${id}/refresh`, {});
                await cache.invalidateQueries({ queryKey: ["dataset", id] });
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={16} />{" Refresh metadata"}</Button></Allowed>
        }
      />
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loading />
      ) : (
        d && (
          <>
            <Card title={tr("Dataset")}>
              <p>
                {[d.catalog_name, d.schema_name, d.table_name]
                  .filter(Boolean)
                  .join(".")}
              </p>
              <p>{Object.keys(columns).length}{tr(" columns")}</p>
              <Button asChild>
                <Link to="/comparisons/new">{tr("New comparison")}</Link>
              </Button>
            </Card>
            <Card title={tr("Column metadata")}>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{tr("Column")}</th>
                      <th>{tr("Type")}</th>
                      <th>{tr("Nullable")}</th>
                      <th>{tr("Primary key")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(columns).map(([name, info]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{info.type}</td>
                        <td>{locale === "pt-BR" && typeof info.nullable === "boolean" ? tr(info.nullable ? "Yes" : "No") : String(info.nullable ?? tr("Unknown"))}</td>
                        <td>{info.primary_key ? tr("Yes") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            {d.metadata.table_details && (
              <Card title={tr("Table details")}>
                <JsonView value={d.metadata.table_details} />
              </Card>
            )}
          </>
        )
      )}
    </>
  );
}
