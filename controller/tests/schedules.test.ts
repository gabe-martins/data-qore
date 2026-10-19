import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nextDates, schedulePatchSchema, Scheduler, Schedules, EngineCallError } from "../src/schedules.js";
import { Auth } from "../src/auth.js";
import { database } from "../src/db.js";
import { loadConfig } from "../src/config.js";

test("traditional cron, timezone, names, steps, leap days and DOM/DOW OR", () => {
  const at = new Date("2026-10-18T12:00:00Z");
  assert.equal(nextDates("0 8 * * 1-5", "America/Sao_Paulo", at)[0].toISOString(), "2026-10-19T11:00:00.000Z");
  assert.equal(nextDates("*/15 * * * *", "UTC", at)[0].toISOString(), "2026-10-18T12:15:00.000Z");
  assert.equal(nextDates("0 8 * JUL WED", "UTC", at)[0].toISOString(), "2027-07-07T08:00:00.000Z");
  assert.equal(nextDates("0 0 29 2 *", "UTC", at)[0].toISOString(), "2028-02-29T00:00:00.000Z");
  assert.equal(nextDates("0 8 20 * 1", "UTC", at)[0].toISOString(), "2026-10-19T08:00:00.000Z");
  const dst = nextDates("0 8 * * *", "America/New_York", new Date("2026-10-31T13:00:00Z"));
  assert.equal(dst[0].toISOString(), "2026-11-01T13:00:00.000Z");
  assert.deepEqual(schedulePatchSchema.parse({ is_active: false }), { is_active: false });
});
test("invalid cron never accepts commands, extensions, seconds or invalid timezones", () => {
  for (const cron of ["* * * * * *", "@daily", "0 25 * * *", "0 8 * * * curl example.com", "H * * * *", "0 8 L * *", "0 8 * * 1#2", "0 0 31 2 *"])
    assert.throws(() => nextDates(cron, "UTC"), /invalid_cron/);
  assert.throws(() => nextDates("0 8 * * *", "Invalid/Zone"), /invalid_cron/);
});

test("durable scheduler claims once, recovers ambiguous acceptance, pauses, skips busy runs and handles downtime", { skip: process.env.DATAQORE_ISOLATED_TEST !== "1" }, async () => {
  const config = loadConfig(), db = database(config.databaseUrl), auth = new Auth(db, config);
  const now = new Date();
  const user = await db.user.findFirstOrThrow();
  const target = randomUUID();
  const create = (name: string) => db.schedule.create({ data: { name, comparisonId: target, cronExpression: "* * * * *", timezone: "UTC", nextRunAt: new Date(now.getTime() - 3600000), createdBy: user.id } });
  const ids: string[] = [];
  try {
    const schedule = await create("Concurrency"); ids.push(schedule.id);
    const accepted = new Map<string, string>();
    let first = true;
    const fake = async (_: any, _path: string, method = "GET", key?: string) => {
      if (method === "GET") return { total: 0 };
      assert.ok(key?.startsWith("schedule:"));
      if (!accepted.has(key!)) accepted.set(key!, randomUUID());
      if (first) { first = false; throw new EngineCallError("engine_unavailable", true); }
      return { id: accepted.get(key!) };
    };
    await Promise.all([new Scheduler(db, config, auth, fake).tick(now), new Scheduler(db, config, auth, fake).tick(now)]);
    assert.equal(await db.scheduleDispatch.count({ where: { scheduleId: schedule.id } }), 1);
    let dispatch = await db.scheduleDispatch.findFirstOrThrow({ where: { scheduleId: schedule.id } });
    assert.equal(dispatch.status, "pending"); assert.equal(dispatch.enqueueStarted, true);
    assert.equal(accepted.size, 1);
    // Pausing after ambiguous acceptance must recover the original run, not enqueue another.
    await db.schedule.update({ where: { id: schedule.id }, data: { isActive: false } });
    await db.scheduleDispatch.update({ where: { id: dispatch.id }, data: { retryAt: now } });
    await new Scheduler(db, config, auth, fake).tick(now);
    dispatch = await db.scheduleDispatch.findUniqueOrThrow({ where: { id: dispatch.id } });
    assert.equal(dispatch.status, "dispatched"); assert.equal(dispatch.runId, [...accepted.values()][0]);
    assert.equal(accepted.size, 1);
    await new Scheduler(db, config, auth, fake).tick(now);
    assert.equal(accepted.size, 1);
    const future = await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
    assert.ok(future.nextRunAt > now);

    const busy = await create("Busy"); ids.push(busy.id);
    const busyCall = async (_: any, _path: string, method = "GET") => { assert.equal(method, "GET"); return { total: 1 }; };
    await new Scheduler(db, config, auth, busyCall).tick(now);
    const skipped = await db.scheduleDispatch.findFirstOrThrow({ where: { scheduleId: busy.id } });
    assert.equal(skipped.status, "skipped"); assert.equal(skipped.errorCode, "comparison_busy");
    await db.schedule.update({ where: { id: busy.id }, data: { isActive: false } });

    const paused = await create("Paused before enqueue"); ids.push(paused.id);
    const unavailable = async () => { throw new EngineCallError("engine_unavailable", true); };
    await new Scheduler(db, config, auth, unavailable).tick(now);
    const pending = await db.scheduleDispatch.findFirstOrThrow({ where: { scheduleId: paused.id } });
    assert.equal(pending.enqueueStarted, false);
    await db.schedule.update({ where: { id: paused.id }, data: { isActive: false } });
    await db.scheduleDispatch.update({ where: { id: pending.id }, data: { retryAt: now } });
    await new Scheduler(db, config, auth, fake).tick(now);
    assert.equal((await db.scheduleDispatch.findUniqueOrThrow({ where: { id: pending.id } })).status, "skipped");

    const stale = await create("Expired claim"); ids.push(stale.id);
    await db.schedule.update({ where: { id: stale.id }, data: { nextRunAt: new Date(now.getTime() + 3600000) } });
    const claim = await db.scheduleDispatch.create({ data: { scheduleId: stale.id, comparisonId: target, scheduledFor: now,
      retryAt: now, leaseUntil: new Date(now.getTime() - 1000), claimToken: randomUUID(), enqueueStarted: true, attempts: 1 } });
    await new Scheduler(db, config, auth, fake).tick(now);
    assert.equal((await db.scheduleDispatch.findUniqueOrThrow({ where: { id: claim.id } })).status, "dispatched");

    const cancel = await create("Pause during preflight"); ids.push(cancel.id);
    const service = new Schedules(db, config, auth);
    const pauseDuringGet = async (_: any, _path: string, method = "GET") => {
      assert.equal(method, "GET", "A paused dispatch must not reach POST");
      await service.update(cancel.id, { is_active: false }, user.id, randomUUID());
      return { total: 0 };
    };
    await new Scheduler(db, config, auth, pauseDuringGet).tick(now);
    assert.equal((await db.scheduleDispatch.findFirstOrThrow({ where: { scheduleId: cancel.id } })).status, "skipped");

    const exhausted = await create("Bounded retries"); ids.push(exhausted.id);
    for (let n = 0; n < 5; n++) {
      await db.scheduleDispatch.updateMany({ where: { scheduleId: exhausted.id }, data: { retryAt: now } });
      await new Scheduler(db, config, auth, unavailable).tick(now);
    }
    const failed = await db.scheduleDispatch.findFirstOrThrow({ where: { scheduleId: exhausted.id } });
    assert.equal(failed.status, "failed"); assert.equal(failed.attempts, 5);
  } finally { await db.schedule.deleteMany({ where: { id: { in: ids } } }); await db.$disconnect(); }
});

test("authenticated schedule API and real scheduled run use the engine queue", { skip: process.env.DATAQORE_ISOLATED_TEST !== "1" }, async () => {
  const config = loadConfig(), db = database(config.databaseUrl), auth = new Auth(db, config);
  const engine = async (path: string, body: unknown) => {
    const r = await fetch(config.engineUrl + "/v1" + path, { method: "POST", headers: { "X-API-Key": config.engineKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(r.ok, await r.clone().text()); return r.json() as any;
  };
  const client = async (path: string, body?: unknown, token?: string, method = "POST") => fetch(process.env.DATAQORE_CONTROLLER_URL + "/api/v1" + path, {
    method, headers: { "Content-Type": "application/json", Origin: config.webOrigin, ...(token ? { Authorization: "Bearer " + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let id: string | undefined;
  try {
    assert.equal((await client("/schedules/preview", { cron_expression: "* * * * *" })).status, 401);
    const login = await client("/auth/login", { email: "admin@dataqore.test", password: "DataQore-test-password-2026" });
    const token = (await login.json() as any).access_token; assert.ok(token);
    const left = await engine("/connections", { name: "Scheduled left", connector: "sqlite", credentials: { database: "left.sqlite" } });
    const right = await engine("/connections", { name: "Scheduled right", connector: "sqlite", credentials: { database: "right.sqlite" } });
    const a = await engine("/datasets", { connection_id: left.id, schema_name: "", table_name: "records" });
    const b = await engine("/datasets", { connection_id: right.id, schema_name: "", table_name: "records" });
    const comparison = await engine("/comparisons", { name: "Scheduled acceptance", left_dataset_id: a.id, right_dataset_id: b.id });
    const preview = await client("/schedules/preview", { cron_expression: "0 8 * * 1-5", timezone: "America/Sao_Paulo" }, token);
    assert.equal(preview.status, 200); assert.equal(((await preview.json()) as any).next_runs.length, 3);
    assert.equal((await client("/schedules/preview", { cron_expression: "* * * * * *" }, token)).status, 422);
    const created = await client("/schedules", { name: "Acceptance schedule", comparison_id: comparison.id, cron_expression: "0 8 * * 1-5", timezone: "America/Sao_Paulo" }, token);
    assert.equal(created.status, 201); id = ((await created.json()) as any).id;
    const now = new Date(); await db.schedule.update({ where: { id }, data: { nextRunAt: new Date(now.getTime() - 60000) } });
    await new Scheduler(db, config, auth).tick(now);
    const dispatch = await db.scheduleDispatch.findFirstOrThrow({ where: { scheduleId: id } });
    assert.equal(dispatch.status, "dispatched"); assert.ok(dispatch.runId);
    await new Scheduler(db, config, auth).tick(now);
    assert.equal(await db.scheduleDispatch.count({ where: { scheduleId: id } }), 1);
    const history = await client(`/schedules/${id}/dispatches`, undefined, token, "GET");
    assert.equal(history.status, 200); assert.equal(((await history.json()) as any).items[0].run_id, dispatch.runId);
    for (let n = 0; n < 100; n++) {
      const r = await fetch(config.engineUrl + "/v1/runs/" + dispatch.runId, { headers: { "X-API-Key": config.engineKey } });
      const run = await r.json() as any;
      if (run.status === "succeeded") break;
      assert.notEqual(run.status, "failed"); assert.ok(n < 99); await new Promise(r => setTimeout(r, 200));
    }
    const paused = await client("/schedules/" + id, { is_active: false }, token, "PATCH");
    assert.equal(paused.status, 200); assert.equal(((await paused.json()) as any).is_active, false);
  } finally { if (id) await db.schedule.delete({ where: { id } }); await db.$disconnect(); }
});
