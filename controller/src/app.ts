import "reflect-metadata";
import {
  Controller,
  Module,
  Get,
  Post,
  Req,
  Res,
  RequestMethod,
  RequestMapping,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { Auth, PublicError } from "./auth.js";
import type {
  paths as EnginePaths,
  components as EngineComponents,
} from "./engine-api.js";
import { engineSpec, openapi } from "./openapi.js";
import { z } from "zod";
import { accessOperations } from "./access.js";
import { routePermission, selfServicePaths, publicPaths } from "./permissions.js";
import { lockComparisons } from "./comparison-lock.js";
import { Schedules, cronSchema, nextDates, scheduleOut, dispatchOut } from "./schedules.js";
const COOKIE = "dataqore_refresh";
const messages: Record<string, string> = {
  catalog_required: "Select a Databricks catalog and schema.",
  source_databricks_authentication_failed: "Databricks rejected authentication. Check the token or service principal credentials.",
  source_databricks_permission_denied: "Databricks denied read access. Check warehouse, catalog, schema and SELECT permissions.",
  source_databricks_catalog_access_denied: "The connection identity is missing USE CATALOG on the selected Databricks catalog. Ask its owner to grant access; a successful connection test does not verify data permissions.",
  source_databricks_schema_access_denied: "The connection identity is missing USE SCHEMA on the selected Databricks schema. Ask its owner to grant access, and check SELECT on the required tables or views.",
  source_databricks_warehouse_unavailable: "Databricks SQL Warehouse is unavailable. Check its HTTP path and availability.",
  source_databricks_query_timeout: "The Databricks operation timed out. Check warehouse availability and query cost.",
  source_databricks_unavailable: "Unable to read Databricks. Check connection settings and permissions.",
  source_numeric_precision_unsupported: "This Databricks decimal parameter exceeds 38 digits of precision.",
  invalid_comparison_options: "Review the scope, mapping and business key against source metadata.",
  invalid_column_mapping: "Each existing column can be mapped only once. Review both sides.",
  incompatible_column_mapping: "The selected columns have incompatible types. Mapping does not convert values.",
  invalid_business_key: "Select distinct mapped columns with compatible key types and use key alignment.",
  invalid_excluded_columns: "Choose existing columns once per source for exclusion.",
  comparison_key_excluded: "Identity columns cannot be excluded. Choose a different business key first.",
  no_comparable_columns: "Keep at least one column for comparison.",
  invalid_timestamp_timezone: "Timezone interpretation applies only to existing timestamps without a timezone. Use a valid IANA timezone.",
  conflicting_timestamp_timezone: "Use the same timezone for this column in the period and value comparison.",
  scope_column_not_found: "A scope column is missing. Refresh the dataset and review its filters.",
  invalid_scope_type: "The scope column types do not preserve equivalent criteria on both sources.",
  invalid_scope_value: "A filter value or operator is incompatible with its column type. Decimal values must use a dot.",
  invalid_scope_period: "Use increasing period bounds with explicit offsets, or complete calendar dates.",
  ambiguous_scope_period: "The timestamp boundary is ambiguous in the selected timezone. Choose unambiguous bounds.",
  naive_timezone_required: "Specify how timestamps without a timezone must be interpreted on each source.",
  source_timezone_required: "MySQL TIMESTAMP scopes require UTC interpretation; comparison sessions read these columns in UTC.",
  source_scope_encoding_invalid: "SQLite scope values must match declared numeric/text types or canonical ISO date/timestamp encoding, with at most six fractional digits.",
  scope_parameter_budget_exceeded: "Reduce the number of filter values to stay within the query parameter budget.",
  source_schema_changed: "Source metadata changed. Refresh the datasets and review the comparison.",
  sample_limit_exceeded: "Requested sample exceeds 10,000 keys. Reduce the number of keys or percentage.",
  sample_cell_budget_exceeded: "Requested sample exceeds the cell budget. Reduce the sample or increase the capture budget.",
  sample_byte_budget_exceeded: "Captured keys or records exceed the byte budget. Reduce the sample or increase the capture budget.",
  metadata_unavailable: "Refresh the dataset metadata before comparing.",
  comparison_key_unavailable: "No compatible PK / non-null UNIQUE key is available. Select mapped business-key columns.",
  not_found: "Resource not found.",
  validation_error: "Invalid payload or parameters.",
  resource_conflict: "Duplicate resource or conflicting references.",
  connection_in_use: "This connection is in use. Deactivate it instead.",
  dataset_in_use: "This dataset is used by current or historical comparisons and cannot be deleted.",
  connection_inactive: "This connection is inactive.",
  comparison_inactive: "This comparison is inactive.",
  comparison_busy: "Wait for queued or running comparisons to finish before deleting.",
  comparison_scheduled: "This comparison has current or historical schedules and cannot be deleted.",
  idempotency_conflict: "This key was used for another request.",
  driver_unavailable: "The driver is not installed on the engine.",
  source_unavailable:
    "Unable to access the source. Check configuration, permissions and connectivity.",
  source_authentication_failed:
    "PostgreSQL rejected authentication. Check the source username and password.",
  source_access_denied:
    "PostgreSQL rejected access. Check pg_hba.conf and the source user/database combination.",
  source_database_not_found:
    "The specified database does not exist on the PostgreSQL server.",
  source_permission_denied:
    "The source account does not have permission for this read operation.",
  source_host_unresolved:
    "Unable to resolve the source host. Enter only its hostname or IP address.",
  source_connection_refused:
    "The source refused the connection. Check the host, port and PostgreSQL listener.",
  source_connection_timeout:
    "The source connection timed out. Check network access and firewall rules.",
  source_network_unreachable:
    "The source network is unreachable. Check connectivity and firewall rules.",
  source_tls_error:
    "Source SSL negotiation failed. Check the SSL mode and server certificates.",
  source_mssql_certificate_invalid:
    "SQL Server certificate validation failed. Configure a trusted certificate, or explicitly enable Trust server certificate for this local connection.",
  source_server_unavailable:
    "The source PostgreSQL server is not accepting connections right now.",
  source_query_timeout:
    "The source query exceeded its time limit.",
  sqlite_path_not_allowed:
    "Select an existing SQLite file inside the allowed directory.",
  connection_decryption_failed:
    "Unable to decrypt this connection. Check the original encryption key.",
  encryption_key_version_unavailable:
    "The original encryption key version is unavailable.",
  result_not_ready: "This run has no completed result.",
  evidence_expired: "Individual record evidence expired after 30 days. Aggregated results remain available.",
  evidence_not_captured: "This execution has no available record evidence. Historical results are not reconstructed from current source data.",
  evidence_unavailable: "Record evidence is unavailable. Check the evidence encryption key configuration.",
  storage_unavailable: "Engine storage is unavailable.",
  source_table_not_found: "Table not found in the current catalog.",
};
export async function createApp(config: Config, db: DB) {
  const auth = new Auth(db, config);
  const schedules = new Schedules(db, config, auth);
  const adapter = new FastifyAdapter({
    logger: false,
    bodyLimit: 1048576,
    requestTimeout: 60000,
    genReqId: () => randomUUID(),
  });
  @Controller()
  class Api {
    @Get("/health/live") live() {
      return { status: "ok" };
    }
    @Get("/health/ready") async ready() {
      const r = await db.$queryRaw<
        { current_user: string }[]
      >`SELECT current_user`;
      if (r[0]?.current_user !== "srv_dataqore_app")
        throw new PublicError(
          503,
          "runtime_role_invalid",
          "The controller requires its restricted runtime account.",
        );
      await db.user.count();
      return { status: "ok" };
    }
    @Get("/api/openapi.json") spec() {
      return openapi();
    }
  }
  const before = async (req: any, res: any) => {
    res.header("X-Request-ID", req.id);
    res.header("Cache-Control", "no-store");
    res.header("X-Content-Type-Options", "nosniff");
    if ((req.routeOptions?.url ?? req.url).startsWith("/api/v1/auth/") && req.method !== "GET") {
      if (req.headers.origin !== config.webOrigin)
        throw new PublicError(
          403,
          "origin_rejected",
          "Request origin is not allowed.",
        );
    }
  };
  function setCookie(res: any, value: string, expires: Date) {
    res.setCookie(COOKIE, value, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.webOrigin.startsWith("https:"),
      path: "/api/v1/auth",
      expires,
    });
  }
  function clearCookie(res: any) {
    res.clearCookie(COOKIE, { path: "/api/v1/auth" });
  }
  const operations: [string, string, (req: any, res: any) => Promise<any>][] = [
    ...accessOperations(db),
    ["post", "/api/v1/schedules/preview", async (req, res) => {
      const v = cronSchema.parse(req.body);
      res.status(200);
      return { cron_expression: v.cron_expression, timezone: v.timezone, next_runs: nextDates(v.cron_expression, v.timezone).map(d => d.toISOString()) };
    }],
    ["get", "/api/v1/schedules", async (req) => {
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20), offset: z.coerce.number().int().min(0).default(0), comparison_id: z.uuid().optional(), search: z.string().max(255).default("") }).strict().parse(req.query);
      const where = { ...(q.comparison_id ? { comparisonId: q.comparison_id } : {}), name: { contains: q.search, mode: "insensitive" as const } };
      const [items, total] = await db.$transaction([db.schedule.findMany({ where, take: q.limit, skip: q.offset, orderBy: [{ createdAt: "desc" }, { id: "asc" }] }), db.schedule.count({ where })]);
      return { items: items.map(scheduleOut), total, limit: q.limit, offset: q.offset };
    }],
    ["post", "/api/v1/schedules", async (req, res) => {
      const session = req.access;
      const row = await schedules.create(req.body, session.user.id, req.id);
      res.status(201); return row;
    }],
    ["get", "/api/v1/schedules/:id", async req => {
      const id = z.uuid().parse(req.params.id);
      const row = await db.schedule.findUnique({ where: { id } });
      if (!row) throw new PublicError(404, "not_found", "Schedule not found.");
      return scheduleOut(row);
    }],
    ["patch", "/api/v1/schedules/:id", async req => {
      const session = req.access;
      return schedules.update(z.uuid().parse(req.params.id), req.body, session.user.id, req.id);
    }],
    ["get", "/api/v1/schedules/:id/dispatches", async req => {
      const scheduleId = z.uuid().parse(req.params.id);
      if (!(await db.schedule.findUnique({ where: { id: scheduleId } }))) throw new PublicError(404, "not_found", "Schedule not found.");
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20), offset: z.coerce.number().int().min(0).default(0) }).strict().parse(req.query);
      const where = { scheduleId };
      const [items, total] = await db.$transaction([db.scheduleDispatch.findMany({ where, take: q.limit, skip: q.offset, orderBy: [{ scheduledFor: "desc" }, { id: "asc" }] }), db.scheduleDispatch.count({ where })]);
      return { items: items.map(dispatchOut), total, limit: q.limit, offset: q.offset };
    }],
    [
      "post",
      "/api/v1/auth/login",
      async (req, res) => {
        const r = await auth.login(req.body, req.id);
        setCookie(res, r.refresh, r.expires);
        return r.body;
      },
    ],
    [
      "post",
      "/api/v1/auth/refresh",
      async (req, res) => {
        try {
          const r = await auth.refresh(req.cookies[COOKIE], req.id);
          setCookie(res, r.refresh, r.expires);
          return r.body;
        } catch (e) {
          clearCookie(res);
          throw e;
        }
      },
    ],
    [
      "get",
      "/api/v1/auth/me",
      async (req) => {
        return req.access.user;
      },
    ],
    [
      "post",
      "/api/v1/auth/logout",
      async (req, res) => {
        await auth.logout(
          req.access,
          req.id,
        );
        clearCookie(res);
        return { status: "ok" };
      },
    ],
    [
      "post",
      "/api/v1/auth/change-password",
      async (req, res) => {
        await auth.change(
          req.access,
          req.body,
          req.id,
        );
        clearCookie(res);
        return { status: "ok" };
      },
    ],
  ];
  for (const [path, methods] of Object.entries(engineSpec.paths) as [
    keyof EnginePaths,
    any,
  ][]) {
    if (!path.startsWith("/v1/")) continue;
    for (const method of Object.keys(methods)) {
      if (!["get", "post", "patch", "delete"].includes(method)) continue;
      operations.push([
        method,
        "/api" + path.replace(/\{([^}]+)\}/g, ":$1"),
        async (req, res) => {
          const session = req.access;
          const headers: Record<string, string> = {
            "X-API-Key": config.engineKey,
            "Content-Type": "application/json",
          };
          const key = req.headers["idempotency-key"];
          if (key) {
            if (typeof key !== "string" || key.length > 200)
              throw new PublicError(
                422,
                "validation_error",
                "Invalid idempotency key.",
              );
            headers["Idempotency-Key"] = key;
          }
          const target = new URL(config.engineUrl + req.raw.url.slice(4));
          const preview = path === "/v1/comparisons/{identifier}/dependencies" && method === "get";
          const deletingComparison = path === "/v1/comparisons/{identifier}" && method === "delete";
          const comparisonId = preview || deletingComparison ? z.uuid().parse(req.params.identifier).toLowerCase() : undefined;
          const scheduleWhere = comparisonId ? { OR: [{ comparisonId }, { dispatches: { some: { comparisonId } } }] } : undefined;
          const pagination = preview ? z.object({
            schedule_limit: z.coerce.number().int().min(1).max(200).default(20),
            schedule_offset: z.coerce.number().int().min(0).default(0),
          }).strict().parse(req.query) : undefined;
          if (preview) { target.searchParams.delete("schedule_limit"); target.searchParams.delete("schedule_offset"); }
          let response: Response;
          try {
            const forward = () => fetch(target, {
              method: method.toUpperCase(),
              headers,
              body:
                method === "get" ? undefined : JSON.stringify(req.body ?? {}),
              signal: AbortSignal.timeout(45000),
              redirect: "error",
            });
            response = deletingComparison ? await db.$transaction(async tx => {
              await lockComparisons(tx, [comparisonId!]);
              if (await tx.schedule.count({ where: scheduleWhere }))
                throw new PublicError(409, "comparison_scheduled", messages.comparison_scheduled);
              return forward();
            }, { timeout: 60000 }) : await forward();
          } catch (error) {
            if (method !== "get")
              await auth.audit(
                `${method}:${path}`,
                "failure",
                session.user.id,
                req.id,
                "engine",
              );
            if (error instanceof PublicError) throw error;
            throw new PublicError(
              503,
              "engine_unavailable",
              "The engine did not respond. Check the run history before retrying a job.",
            );
          }
          let data: any;
          try {
            data = await response.json();
          } catch {
            throw new PublicError(
              502,
              "invalid_engine_response",
              "Invalid engine response.",
            );
          }
          if (method === "get" && path.startsWith("/v1/runs/") && (path.includes("/quality/records") || path.endsWith("/quality/export"))) {
            await auth.audit(path.endsWith("/export") ? "evidence:export" : "evidence:read", response.ok ? "success" : "failure", session.user.id, req.id, "run", req.params.identifier);
            res.header("Cache-Control", "no-store");
          }
          if (preview && response.ok) {
            const schedules = await db.$transaction(async tx => {
              const total = await tx.schedule.count({ where: scheduleWhere });
              const rows = await tx.schedule.findMany({ where: scheduleWhere,
                orderBy: [{ name: "asc" }, { id: "asc" }], take: pagination!.schedule_limit, skip: pagination!.schedule_offset,
                select: { id: true, name: true, isActive: true, comparisonId: true,
                  dispatches: { where: { comparisonId }, select: { id: true }, take: 1 } } });
              return { items: rows.map(s => ({ id: s.id, name: s.name, is_active: s.isActive, comparison_id: s.comparisonId,
                current: s.comparisonId === comparisonId, historical: s.dispatches.length > 0 })),
                total, limit: pagination!.schedule_limit, offset: pagination!.schedule_offset };
            }, { isolationLevel: "RepeatableRead" });
            data = { ...data, schedules, can_delete: data.can_delete && schedules.total === 0 };
          }
          if (method !== "get")
            await auth.audit(
              `${method}:${path}`,
              response.ok ? "success" : "failure",
              session.user.id,
              req.id,
              "engine",
              typeof data.id === "string" ? data.id : undefined,
            );
          if (!response.ok) {
            const problem = data as Partial<
              EngineComponents["schemas"]["ErrorOut"]
            >;
            const code =
              typeof problem.code === "string" ? problem.code : "engine_error";
            throw new PublicError(
              response.status,
              code,
              messages[code] ?? "The engine could not complete this request.",
            );
          }
          res.status(response.status);
          return data;
        },
      ]);
    }
  }
  operations.forEach(([method, path, handler], i) => {
    const name = "route" + i;
    Object.defineProperty(Api.prototype, name, {
      value: async function (req: any, res: any) {
        const operation = `${method.toLowerCase()} ${path}`;
        if (!publicPaths.has(operation)) {
          const access = await auth.authorize(req.headers.authorization);
          req.access = access;
          const permission = routePermission(method, path);
          const passwordRequired = access.user.must_change_password && !selfServicePaths.has(operation);
          if (passwordRequired || (!selfServicePaths.has(operation) && (!permission || !access.user.permissions.includes(permission)))) {
            await auth.audit(`denied:${method}:${path}`, "failure", access.user.id, req.id, "authorization");
            throw new PublicError(403, passwordRequired ? "password_change_required" : "forbidden",
              passwordRequired ? "Change your temporary password before continuing." : "You do not have permission for this operation.");
          }
        }
        res.status(200);
        return handler(req, res);
      },
    });
    const d = Object.getOwnPropertyDescriptor(Api.prototype, name)!;
    RequestMapping({
      path,
      method: RequestMethod[method.toUpperCase() as "GET" | "POST" | "PATCH" | "DELETE"],
    })(Api.prototype, name, d);
    Req()(Api.prototype, name, 0);
    Res({ passthrough: true })(Api.prototype, name, 1);
  });
  @Module({ controllers: [Api] })
  class AppModule {}
  const server = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    { logger: false, abortOnError: false },
  );
  await server.register(cookie);
  await server.register(rateLimit, {
    global: true,
    max: 20,
    timeWindow: "1 minute",
    allowList: (req: any) =>
      !(req.method === "POST" && (req.routeOptions?.url ?? req.url).startsWith("/api/v1/auth/")),
  });
  const f = server.getHttpAdapter().getInstance();
  f.addHook("onRequest", before);
  const sendError = (error: any, req: any, res: any) => {
    const status =
      error instanceof PublicError
        ? error.status
        : ["P2002", "P2003"].includes(error.code) ? 409
        : error instanceof ZodError
          ? 422
          : error.statusCode === 429
            ? 429
            : error.getStatus?.() === 404
              ? 404
              : error.statusCode === 400
                ? 400
                : 500;
    res
      .status(status)
      .send({
        code:
          error instanceof PublicError
            ? error.code
            : status === 409 ? "resource_conflict"
            : status === 422 || status === 400
              ? "validation_error"
              : status === 429
                ? "rate_limited"
                : status === 404
                  ? "not_found"
                  : "internal_error",
        message:
          error instanceof PublicError
            ? error.publicMessage
            : status === 409 ? "Duplicate resource or conflicting references."
            : status === 422 || status === 400
              ? "Invalid payload or parameters."
              : status === 429
                ? "Too many attempts. Try again later."
                : status === 404
                  ? "Resource not found."
                  : "Unable to process the request.",
        request_id: req.id,
      });
  };
  server.useGlobalFilters({
    catch(error: any, host: any) {
      const ctx = host.switchToHttp();
      sendError(error, ctx.getRequest(), ctx.getResponse());
    },
  });
  await server.init();
  return { app: server, auth };
}
