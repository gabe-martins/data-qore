import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { database } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { userPatchSchema, groupPatchSchema } from "../src/access.js";
import { Auth, hashPassword } from "../src/auth.js";
import { engineSpec } from "../src/openapi.js";
import { profiles, routePermission } from "../src/permissions.js";
const isolated = process.env.DATAQORE_ISOLATED_TEST === "1";
const db = isolated ? database(loadConfig().databaseUrl) : null;
after(async () => { await db?.$disconnect(); });
const password = "Temporary-access-test-2026";
const replacement = "Replaced-access-test-2026";

test("patch payloads never supply defaults for omitted fields", () => {
  assert.throws(() => userPatchSchema.parse({}));
  assert.throws(() => groupPatchSchema.parse({}));
  assert.deepEqual(userPatchSchema.parse({ display_name: "Edited" }), { display_name: "Edited" });
  assert.deepEqual(groupPatchSchema.parse({ profile: "viewer" }), { profile: "viewer" });
});

test("every engine and local operation has an explicit authorization policy", () => {
  for (const [path, operations] of Object.entries(engineSpec.paths) as [string, any][]) {
    if (!path.startsWith("/v1/")) continue;
    for (const method of Object.keys(operations)) if (["get", "post", "patch", "delete"].includes(method))
      assert.ok(routePermission(method, "/api" + path), `${method} ${path}`);
  }
  assert.equal(routePermission("post", "/api/v1/future-resource"), undefined);
  assert.equal(routePermission("get", "/api/v1/users/:id"), undefined);
});

test("real database: role matrix, upstream isolation, identity lifecycle and last administrator", { skip: !isolated }, async t => {
  const config = loadConfig();
  let forwarded = 0;
  const upstream = createServer((_req, res) => { forwarded++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ items: [], total: 0, limit: 20, offset: 0, can_delete: true })); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as any).port;
  // A newly discovered engine operation must remain denied even to administrators.
  engineSpec.paths["/v1/unmapped-access-test"] = { get: {} };
  const { app, auth } = await createApp({ ...config, engineUrl: `http://127.0.0.1:${port}` }, db!);
  delete engineSpec.paths["/v1/unmapped-access-test"];
  const f = app.getHttpAdapter().getInstance();
  const groupIds: string[] = [], userIds: string[] = [];
  const accounts: Record<string, any> = {};
  const original = await db!.user.findFirstOrThrow({ where: { isActive: true, group: { profile: "platform_admin" } } });
  const login = async (email: string, pass = password) => (await auth.login({ email, password: pass }, randomUUID())).body.access_token;
  const request = (token: string | null, method: string, path: string, payload?: any) => f.inject({ method: method as any, url: "/api/v1" + path, headers: { origin: config.webOrigin, ...(token ? { authorization: "Bearer " + token } : {}) }, ...(payload !== undefined ? { payload } : {}) });
  try {
    const hash = await hashPassword(password);
    for (const profile of profiles) {
      const group = await db!.accessGroup.create({ data: { name: `Access test ${profile} ${randomUUID()}`, profile } }); groupIds.push(group.id);
      const user = await db!.user.create({ data: { email: `${randomUUID()}@access.test`, displayName: profile, groupId: group.id, passwordHash: hash } }); userIds.push(user.id);
      accounts[profile] = { group, user, token: await login(user.email) };
    }
    const admin = accounts.platform_admin;
    await t.test("all engine methods deny unauthenticated access and enforce all four profiles before forwarding", async () => {
      const manager = ["/v1/comparison-summaries", "/v1/datasets", "/v1/datasets/{identifier}", "/v1/datasets/{identifier}/dependencies", "/v1/comparisons", "/v1/comparisons/{identifier}", "/v1/comparisons/{identifier}/dependencies"];
      const readOnly = ["/v1/overview", "/v1/overview/row-match-trend", "/v1/runs", "/v1/runs/{identifier}", "/v1/runs/{identifier}/result"];
      for (const [path, operations] of Object.entries(engineSpec.paths) as [string, any][]) {
        if (!path.startsWith("/v1/")) continue;
        for (const method of Object.keys(operations)) {
          if (!["get", "post", "patch", "delete"].includes(method)) continue;
          const url = path.replace("/v1", "").replace(/\{[^}]+\}/g, randomUUID());
          let before = forwarded;
          assert.equal((await request(null, method, url, method === "get" ? undefined : {})).statusCode, 401);
          assert.equal(forwarded, before);
          for (const profile of profiles) {
            const allowed = profile === "platform_admin" || profile === "developer" || (method === "get" && readOnly.includes(path)) || profile === "quality_manager" && (method === "get" && manager.includes(path) || method !== "get" && path.startsWith("/v1/comparisons"));
            before = forwarded;
            const res = await request(accounts[profile].token, method, url, method === "get" ? undefined : {});
            assert.equal(res.statusCode, allowed ? 200 : 403, `${profile} ${method} ${path}: ${res.body}`);
            assert.equal(forwarded - before, allowed ? 1 : 0);
          }
        }
      }
      const before = forwarded;
      assert.equal((await request(admin.token, "GET", "/unmapped-access-test")).statusCode, 403);
      assert.equal(forwarded, before);
      for (const profile of profiles) {
        const token = accounts[profile].token;
        assert.equal((await request(token, "POST", "/schedules/preview", { cron_expression: "0 * * * *" })).statusCode, profile === "viewer" ? 403 : 200);
        assert.equal((await request(token, "GET", "/schedules")).statusCode, profile === "viewer" ? 403 : 200);
        for (const [method, path] of [["POST", "/schedules"], ["PATCH", `/schedules/${randomUUID()}`]])
          assert.equal((await request(token, method, path, {})).statusCode, profile === "viewer" ? 403 : 422);
        for (const path of ["/users", "/groups", "/audit-log"])
          assert.equal((await request(token, "GET", path)).statusCode, profile === "platform_admin" ? 200 : 403);
        for (const [method, path] of [["POST", "/users"], ["POST", "/groups"], ["PATCH", `/users/${randomUUID()}`], ["PATCH", `/groups/${randomUUID()}`], ["POST", `/users/${randomUUID()}/reset-password`]])
          assert.equal((await request(token, method, path, {})).statusCode, profile === "platform_admin" ? 422 : 403);
      }
    });
    await t.test("create, strict inputs, duplicate email, temporary password and session revocation", async () => {
      const body = { email: `${randomUUID()}@access.test`, display_name: "Created user", group_id: accounts.viewer.group.id, temporary_password: password };
      const result = await request(admin.token, "POST", "/users", body); assert.equal(result.statusCode, 201, result.body);
      const created = result.json(); userIds.push(created.id);
      assert.doesNotMatch(result.body, /password_hash|passwordHash|Temporary-access/);
      assert.equal((await request(admin.token, "POST", "/users", { ...body, email: body.email.toUpperCase() })).statusCode, 409);
      assert.equal((await request(admin.token, "POST", "/users", { ...body, profile: "platform_admin" })).statusCode, 422);
      const token = await login(body.email);
      const current = await request(token, "GET", "/auth/me"); assert.equal(current.json().must_change_password, true);
      assert.equal(current.json().profile, "viewer"); assert.equal(current.json().role, undefined);
      assert.equal((await request(token, "GET", "/overview")).json().code, "password_change_required");
      assert.equal((await request(token, "POST", "/auth/change-password", { current_password: password, new_password: password })).statusCode, 422);
      assert.equal((await request(token, "POST", "/auth/change-password", { current_password: password, new_password: replacement })).statusCode, 200);
      assert.equal((await request(token, "GET", "/auth/me")).statusCode, 401);
      let next = await login(body.email, replacement);
      assert.equal((await request(next, "GET", "/overview")).statusCode, 200);
      assert.equal((await request(admin.token, "PATCH", `/users/${created.id}`, { group_id: accounts.developer.group.id })).statusCode, 200);
      assert.equal((await request(next, "GET", "/auth/me")).statusCode, 401);
      next = await login(body.email, replacement);
      assert.equal((await request(next, "GET", "/auth/me")).json().profile, "developer");
      assert.equal((await request(admin.token, "PATCH", `/groups/${accounts.developer.group.id}`, { profile: "viewer" })).statusCode, 200);
      assert.equal((await request(next, "GET", "/auth/me")).statusCode, 401);
      next = await login(body.email, replacement);
      assert.equal((await request(next, "POST", "/connections", {})).statusCode, 403);
      assert.equal((await request(admin.token, "POST", `/users/${created.id}/reset-password`, { temporary_password: password })).statusCode, 200);
      assert.equal((await request(next, "GET", "/auth/me")).statusCode, 401);
      next = await login(body.email);
      assert.equal((await request(next, "GET", "/auth/me")).json().must_change_password, true);
      assert.equal((await request(admin.token, "PATCH", `/users/${created.id}`, { is_active: false })).statusCode, 200);
      assert.equal((await request(next, "GET", "/auth/me")).statusCode, 401);
      await assert.rejects(login(body.email));
      assert.equal((await request(admin.token, "PATCH", `/users/${created.id}`, { display_name: "Still inactive" })).statusCode, 200);
      assert.equal((await db!.user.findUniqueOrThrow({ where: { id: created.id } })).isActive, false);
      assert.equal((await request(admin.token, "PATCH", `/users/${created.id}`, { is_active: true })).statusCode, 200);
      next = await login(body.email);
      assert.equal((await request(next, "POST", "/auth/logout", {})).statusCode, 200);
      next = await login(accounts.quality_manager.user.email);
      assert.equal((await request(admin.token, "POST", `/users/${accounts.quality_manager.user.id}/revoke-sessions`, {})).statusCode, 200);
      assert.equal((await request(next, "GET", "/auth/me")).statusCode, 401);
    });
    await t.test("group CRUD and audit are atomic and omit secrets", async () => {
      const result = await request(admin.token, "POST", "/groups", { name: `Empty ${randomUUID()}`, profile: "viewer" }); assert.equal(result.statusCode, 201);
      const group = result.json(); groupIds.push(group.id);
      assert.equal((await request(admin.token, "POST", "/groups", { name: group.name.toUpperCase(), profile: "viewer" })).statusCode, 409);
      assert.equal((await request(admin.token, "PATCH", `/groups/${group.id}`, { description: "Changed" })).statusCode, 200);
      assert.equal((await request(admin.token, "PATCH", `/groups/${group.id}`, { profile: "quality_manager" })).statusCode, 200);
      assert.equal((await db!.accessGroup.findUniqueOrThrow({ where: { id: group.id } })).description, "Changed");
      assert.equal((await request(admin.token, "DELETE", `/groups/${accounts.viewer.group.id}`)).statusCode, 409);
      assert.equal((await request(admin.token, "DELETE", `/groups/${group.id}`)).statusCode, 200);
      const audit = await request(admin.token, "GET", "/audit-log?limit=200"); assert.equal(audit.statusCode, 200);
      assert.ok(audit.json().items.some((a: any) => a.action === "user:create"));
      assert.ok(audit.json().items.some((a: any) => a.action.startsWith("denied:")));
      assert.doesNotMatch(audit.body, /Temporary-access-test|Replaced-access-test|passwordHash|refreshTokenHash/);
    });
    await t.test("concurrent self-demotions preserve the final administrator and rollback rejected audit", async () => {
      // Existing fixture admin stays restorable; only this disposable DB is used.
      await db!.user.update({ where: { id: original.id }, data: { isActive: false } });
      const second = await db!.user.create({ data: { email: `${randomUUID()}@access.test`, displayName: "Second admin", passwordHash: hash, groupId: admin.group.id } }); userIds.push(second.id);
      const secondToken = await login(second.email);
      const results = await Promise.all([
        request(admin.token, "PATCH", `/users/${admin.user.id}`, { group_id: accounts.viewer.group.id }),
        request(secondToken, "PATCH", `/users/${second.id}`, { group_id: accounts.viewer.group.id }),
      ]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
      assert.equal(await db!.user.count({ where: { isActive: true, group: { profile: "platform_admin" } } }), 1);
      const winner = results[0].statusCode === 409 ? admin : { user: second, token: secondToken, group: admin.group };
      assert.equal((await request(winner.token, "PATCH", `/groups/${winner.group.id}`, { profile: "viewer" })).statusCode, 409);
      assert.equal((await request(winner.token, "PATCH", `/users/${winner.user.id}`, { is_active: false })).statusCode, 409);
      assert.equal((await request(winner.token, "GET", "/auth/me")).statusCode, 200);
      const successful = await db!.auditLog.count({ where: { actorUserId: winner.user.id, action: "user:update", resourceId: winner.user.id } });
      assert.equal(successful, 0);
    });
  } finally {
    await db!.user.update({ where: { id: original.id }, data: { isActive: original.isActive } });
    await db!.user.deleteMany({ where: { id: { in: userIds } } });
    await db!.accessGroup.deleteMany({ where: { id: { in: groupIds } } });
    await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
