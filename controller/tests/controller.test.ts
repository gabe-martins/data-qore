import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { Auth, PublicError } from "../src/auth.js";
const isolated = process.env.DATAQORE_ISOLATED_TEST === "1";
const cfg = isolated ? loadConfig() : null;
const db = cfg ? database(cfg.databaseUrl) : null;
after(async () => {
  await db?.$disconnect();
});
const origin = process.env.WEB_ORIGIN!;
const base = process.env.DATAQORE_CONTROLLER_URL!;
const email = "admin@dataqore.test",
  password = "DataQore-test-password-2026";
test("environment target is authenticated, validated, persisted and audited", { skip: !isolated }, async () => {
  assert.equal((await call("/environment-settings")).status,401);
  const entry=await login();
  const token=entry.body.access_token;
  const update=(value: unknown)=>fetch(base+"/api/v1/environment-settings",{
    method:"PATCH",headers:{Origin:origin,"Content-Type":"application/json",Authorization:"Bearer "+token},
    body:JSON.stringify({comparison_target_percentage:value}),
  });
  try {
    for(const value of ["-1","101","95.00001","NaN","Infinity","1e2",95])assert.equal((await update(value)).status,422);
    for(const value of ["0","100","97.1234"]){
      const response=await update(value);assert.equal(response.status,200);
      const body=await response.json();
      assert.equal(body.comparison_target_percentage,Number(value).toFixed(4));
      const read=await call("/environment-settings",undefined,token);
      assert.deepEqual(await read.json(),body);
      const row=await db!.environmentSettings.findUniqueOrThrow({where:{id:true}});
      assert.equal(row.comparisonTargetPercentage.toFixed(4),body.comparison_target_percentage);
    }
    assert.ok(await db!.auditLog.count({where:{action:"environment_settings_updated",outcome:"success"}}));
  }finally{assert.equal((await update("95")).status,200);}
});
async function call(
  path: string,
  body?: unknown,
  token?: string,
  cookie?: string,
  originOverride?: string,
) {
  return fetch(base + "/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: originOverride ?? origin,
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function login() {
  const res = await call("/auth/login", { email, password });
  assert.equal(res.status, 200, await res.clone().text());
  return {
    body: await res.json(),
    cookie: res.headers.get("set-cookie")!.split(";")[0],
  };
}
test(
  "authentication, cookie flags, rotation, replay, logout and guards",
  { skip: !isolated },
  async () => {
    assert.equal((await call("/connections")).status, 401);
    assert.equal(
      (await call("/auth/login", { email, password: "wrong" })).status,
      401,
    );
    assert.equal(
      (
        await call(
          "/auth/login",
          { email, password },
          undefined,
          undefined,
          "http://untrusted.test",
        )
      ).status,
      403,
    );
    const first = await login();
    assert.equal(
      (await call("/auth/me", undefined, first.body.access_token)).status,
      200,
    );
    const raw = await call("/auth/refresh", {}, undefined, first.cookie);
    assert.equal(raw.status, 200);
    const second = await raw.json();
    const secondCookie = raw.headers.get("set-cookie")!;
    assert.match(secondCookie, /HttpOnly/i);
    assert.match(secondCookie, /SameSite=Strict/i);
    assert.match(secondCookie, /Path=\/api\/v1\/auth/i);
    assert.equal(
      (await call("/auth/me", undefined, first.body.access_token)).status,
      401,
    );
    assert.equal(
      (await call("/auth/refresh", {}, undefined, first.cookie)).status,
      401,
    );
    assert.equal(
      (await call("/auth/me", undefined, second.access_token)).status,
      401,
    );
    const fresh = await login();
    assert.equal(
      (await call("/auth/logout", {}, fresh.body.access_token)).status,
      200,
    );
    assert.equal(
      (await call("/connections", undefined, fresh.body.access_token)).status,
      401,
    );
  },
);
test(
  "access expiry and password replacement revoke sessions",
  { skip: !isolated },
  async () => {
    const auth = new Auth(db!, { ...cfg!, accessSeconds: 1 });
    const entry = await auth.login({ email, password }, randomUUID());
    await new Promise((r) => setTimeout(r, 1200));
    await assert.rejects(
      auth.authorize("Bearer " + entry.body.access_token),
      PublicError,
    );
    const a = new Auth(db!, cfg!);
    const l = await a.login({ email, password }, randomUUID());
    const session = await a.authorize("Bearer " + l.body.access_token);
    const next = "Changed-test-password-2026";
    await a.change(
      session,
      { current_password: password, new_password: next },
      randomUUID(),
    );
    await assert.rejects(a.authorize("Bearer " + l.body.access_token));
    const changed = await a.login({ email, password: next }, randomUUID());
    await a.change(
      await a.authorize("Bearer " + changed.body.access_token),
      { current_password: next, new_password: password },
      randomUUID(),
    );
  },
);
test(
  "proxy preserves precision, validation and resource errors without leaking secrets",
  { skip: !isolated },
  async () => {
    const l = await login();
    const t = l.body.access_token;
    const catalog = await call("/connectors", undefined, t);
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).length, 6);
    const invalid = await call(
      "/connections",
      {
        name: "invalid",
        connector: "postgresql",
        credentials: { database: "source", password: "PRIVATE_SECRET" },
      },
      t,
    );
    assert.equal(invalid.status, 422);
    assert.doesNotMatch(await invalid.text(), /PRIVATE_SECRET|Traceback/);
    const missing = await call("/connections/" + randomUUID(), undefined, t);
    assert.equal(missing.status, 404);
    const audit = await db!.auditLog.findMany();
    assert.ok(audit.length > 0);
    assert.doesNotMatch(
      JSON.stringify(audit),
      /PRIVATE_SECRET|DataQore-test-password/,
    );
  },
);
test(
  "concurrent refresh consumes a token once and replay revokes the replacement",
  { skip: !isolated },
  async () => {
    const auth = new Auth(db!, cfg!);
    const a = await auth.login({ email, password }, randomUUID());
    const responses = await Promise.allSettled([
      auth.refresh(a.refresh, randomUUID()),
      auth.refresh(a.refresh, randomUUID()),
    ]);
    assert.equal(responses.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(responses.filter((r) => r.status === "rejected").length, 1);
    const accepted = responses.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<any>;
    await assert.rejects(
      auth.authorize("Bearer " + accepted.value.body.access_token),
    );
  },
);
test(
  "controller enforces auth rate limits independently of browser sessions",
  { skip: !isolated },
  async () => {
    const { createApp } = await import("../src/app.js");
    const { app } = await createApp(cfg!, db!);
    try {
      const f = app.getHttpAdapter().getInstance();
      for (let n = 0; n < 20; n++) {
        const r = await f.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { origin },
          payload: { email: "invalid" },
        });
        assert.equal(r.statusCode, 422);
      }
      const blocked = await f.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin },
        payload: { email, password },
      });
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.json().code, "rate_limited");
    } finally {
      await app.close();
    }
  },
);
test(
  "proxy forwards only the internal key and preserves Decimal strings; transport errors are sanitized",
  { skip: !isolated },
  async () => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const { createApp } = await import("../src/app.js");
    const exact = "12345678901234567890.12345678901234567890";
    let seen = 0;
    const source = createServer((req, res) => {
      assert.equal(req.headers["x-api-key"], cfg!.engineKey);
      assert.equal(req.headers.authorization, undefined);
      seen++;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/connections/test") {
        res.statusCode = 503;
        res.end(JSON.stringify({
          code: "source_authentication_failed",
          message: "PRIVATE_DRIVER_MESSAGE",
        }));
        return;
      }
      res.end(
        JSON.stringify({
          items: [{ value: exact }],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      );
    });
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    const port = (source.address() as any).port;
    const { app, auth } = await createApp(
      { ...cfg!, engineUrl: `http://127.0.0.1:${port}` },
      db!,
    );
    const a = await auth.login({ email, password }, randomUUID());
    const f = app.getHttpAdapter().getInstance();
    try {
      const response = await f.inject({
        method: "GET",
        url: "/api/v1/metrics?dataset_id=" + randomUUID(),
        headers: { authorization: "Bearer " + a.body.access_token },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().items[0].value, exact);
      assert.equal(seen, 1);
      assert.doesNotMatch(response.body, new RegExp(cfg!.engineKey));
      const sourceFailure = await f.inject({
        method: "POST",
        url: "/api/v1/connections/test",
        headers: { authorization: "Bearer " + a.body.access_token },
        payload: {},
      });
      assert.equal(sourceFailure.statusCode, 503);
      assert.equal(sourceFailure.json().code, "source_authentication_failed");
      assert.match(sourceFailure.json().message, /username and password/);
      assert.doesNotMatch(sourceFailure.body, /PRIVATE_DRIVER_MESSAGE/);
      await new Promise<void>((r) => source.close(() => r()));
      const failed = await f.inject({
        method: "GET",
        url: "/api/v1/connections",
        headers: { authorization: "Bearer " + a.body.access_token },
      });
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.json().code, "engine_unavailable");
    } finally {
      source.close();
      await app.close();
    }
  },
);
