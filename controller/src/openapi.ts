import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./config.js";
import { z } from "zod";
import { loginSchema, changeSchema } from "./auth.js";
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
  return spec;
}
