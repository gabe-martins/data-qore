import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./config.js";
import { z } from "zod";
import { environmentSettingsPatch, environmentSettingsOut } from "./environment-settings.js";
import { loginSchema, changeSchema } from "./auth.js";
import { cronSchema, scheduleSchema, schedulePatchBaseSchema, scheduleOutSchema, dispatchOutSchema } from "./schedules.js";
export const engineSpec = JSON.parse(
  readFileSync(resolve(root, "docs/openapi-engine.json"), "utf8"),
);
const user = {
  type: "object",
  required: ["id", "email", "display_name", "role"],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    display_name: { type: "string" },
    role: { type: "string" },
  },
};
const token = {
  type: "object",
  required: ["access_token", "expires_in", "user"],
  properties: {
    access_token: { type: "string" },
    expires_in: { type: "integer" },
    user,
  },
};
export function openapi() {
  const spec = structuredClone(engineSpec);
  spec.info = { title: "DataQore App Controller", version: "1.0.0" };
  spec.paths = {};
  spec.components.securitySchemes = {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  };
  for (const [path, operations] of Object.entries(engineSpec.paths) as [
    string,
    any,
  ][]) {
    if (!path.startsWith("/v1/")) continue;
    spec.paths["/api" + path] = operations;
    for (const op of Object.values(operations) as any[])
      op.security = [{ bearerAuth: [] }];
  }
  for (const [path, method, body, response, publicRoute] of [
    ["login", "post", z.toJSONSchema(loginSchema), token, true],
    ["refresh", "post", null, token, true],
    ["logout", "post", null, { type: "object" }, false],
    ["me", "get", null, user, false],
    [
      "change-password",
      "post",
      z.toJSONSchema(changeSchema),
      { type: "object" },
      false,
    ],
  ] as const) {
    spec.paths["/api/v1/auth/" + path] = {
      [method]: {
        tags: ["auth"],
        security: publicRoute ? [] : [{ bearerAuth: [] }],
        ...(body
          ? {
              requestBody: {
                required: true,
                content: { "application/json": { schema: body } },
              },
            }
          : {}),
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: response } },
          },
          "401": { description: "Unauthorized" },
        },
      },
    };
  }
  spec.components.schemas.ScheduleOut = z.toJSONSchema(scheduleOutSchema);
  spec.components.schemas.EnvironmentSettingsOut = z.toJSONSchema(environmentSettingsOut);
  spec.paths["/api/v1/environment-settings"] = Object.fromEntries(["get", "patch"].map(method => [method, {
    tags: ["environment"], security: [{ bearerAuth: [] }],
    ...(method === "patch" ? { requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(environmentSettingsPatch) } } } } : {}),
    responses: { "200": { description: "Environment settings", content: { "application/json": { schema: { $ref: "#/components/schemas/EnvironmentSettingsOut" } } } },
      "401": { description: "Unauthorized" }, "403": { description: "Forbidden" }, "422": { description: "Invalid percentage" }, "503": { description: "Settings unavailable" } },
  }]));
  spec.components.schemas.ScheduleDispatchOut = z.toJSONSchema(dispatchOutSchema);
  const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
  const page = (name: string) => ({ type: "object", required: ["items", "total", "limit", "offset"], properties: {
    items: { type: "array", items: ref(name) }, total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } } });
  const query = (name: string, type = "integer") => ({ name, in: "query", required: false, schema: { type } });
  for (const [path, method, body, response, status] of [
    ["/schedules/preview", "post", z.toJSONSchema(cronSchema), { type: "object", required: ["cron_expression", "timezone", "next_runs"], properties: { cron_expression: { type: "string" }, timezone: { type: "string" }, next_runs: { type: "array", items: { type: "string", format: "date-time" } } } }, "200"],
    ["/schedules", "get", null, page("ScheduleOut"), "200"],
    ["/schedules", "post", z.toJSONSchema(scheduleSchema), ref("ScheduleOut"), "201"],
    ["/schedules/{id}", "get", null, ref("ScheduleOut"), "200"],
    ["/schedules/{id}", "patch", z.toJSONSchema(schedulePatchBaseSchema), ref("ScheduleOut"), "200"],
    ["/schedules/{id}/dispatches", "get", null, page("ScheduleDispatchOut"), "200"],
  ] as const) {
    const parameters: any[] = path.includes("{id}") ? [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }] : [];
    if (method === "get" && (!path.includes("{id}") || path.endsWith("dispatches"))) parameters.push(query("limit"), query("offset"));
    if (path === "/schedules" && method === "get") parameters.push(query("comparison_id", "string"), query("search", "string"));
    spec.paths["/api/v1" + path] ??= {};
    spec.paths["/api/v1" + path][method] = {
      tags: ["schedules"], security: [{ bearerAuth: [] }], parameters,
      ...(body ? { requestBody: { required: true, content: { "application/json": { schema: body } } } } : {}),
      responses: { [status]: { description: "Success", content: { "application/json": { schema: response } } },
        "401": { description: "Unauthorized" }, "404": { description: "Not found" }, "409": { description: "Conflict" }, "422": { description: "Invalid expression or payload" }, "503": { description: "Engine unavailable" } },
    };
  }
  return spec;
}
