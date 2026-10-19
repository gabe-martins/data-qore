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
const COOKIE = "dataqore_refresh";
const messages: Record<string, string> = {
  not_found: "Resource not found.",
  validation_error: "Invalid payload or parameters.",
  resource_conflict: "Duplicate resource or conflicting references.",
  connection_inactive: "This connection is inactive.",
  comparison_inactive: "This comparison is inactive.",
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
  storage_unavailable: "Engine storage is unavailable.",
  source_table_not_found: "Table not found in the current catalog.",
};
export async function createApp(config: Config, db: DB) {
  const auth = new Auth(db, config);
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
        return (await auth.authorize(req.headers.authorization)).user;
      },
    ],
    [
      "post",
      "/api/v1/auth/logout",
      async (req, res) => {
        await auth.logout(
          await auth.authorize(req.headers.authorization),
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
          await auth.authorize(req.headers.authorization),
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
      if (!["get", "post", "patch"].includes(method)) continue;
      operations.push([
        method,
        "/api" + path.replace(/\{([^}]+)\}/g, ":$1"),
        async (req, res) => {
          const session = await auth.authorize(req.headers.authorization);
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
          let response: Response;
          try {
            response = await fetch(target, {
              method: method.toUpperCase(),
              headers,
              body:
                method === "get" ? undefined : JSON.stringify(req.body ?? {}),
              signal: AbortSignal.timeout(45000),
              redirect: "error",
            });
          } catch {
            if (method !== "get")
              await auth.audit(
                `${method}:${path}`,
                "failure",
                session.user.id,
                req.id,
                "engine",
              );
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
        if (path.startsWith("/api/v1/auth/")) res.status(200);
        return handler(req, res);
      },
    });
    const d = Object.getOwnPropertyDescriptor(Api.prototype, name)!;
    RequestMapping({
      path,
      method: RequestMethod[method.toUpperCase() as "GET" | "POST" | "PATCH"],
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
