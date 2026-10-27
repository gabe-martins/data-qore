import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { database } from "../src/db.js";

test("first visitor creates the only initial administrator; origin, validation and concurrent claims are enforced", {
  skip: process.env.DATAQORE_FIRST_RUN_TEST !== "1",
}, async () => {
  const config = loadConfig(), db = database(config.databaseUrl);
  assert.equal(await db.user.count(), 0, "Disposable empty installation required");
  const { app } = await createApp(config, db);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}/api/v1/auth`;
  const state = async () => (await fetch(base + "/setup")).json();
  const claim = (body: unknown, origin = config.webOrigin) => fetch(base + "/setup", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const input = { display_name: "First Administrator", email: "first@example.test", password: "initial-setup-test-password" };
  try {
    assert.deepEqual(await state(), { required: true });
    assert.equal((await claim(input, "http://other-host:8080")).status, 403);
    assert.equal((await claim({ ...input, password: "short" })).status, 422);
    assert.equal((await claim({ ...input, profile: "platform_admin" })).status, 422);
    const attempts = await Promise.all([claim(input), claim({ ...input, email: "second@example.test" })]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
    const winner = attempts.find(r => r.status === 201)!;
    assert.match(winner.headers.get("set-cookie")!, /HttpOnly/i);
    const session = await winner.json();
    assert.equal(session.user.profile, "platform_admin");
    assert.equal(session.user.must_change_password, false);
    assert.ok(session.user.permissions.includes("access.manage"));
    assert.deepEqual(await state(), { required: false });
    assert.equal((await claim(input)).status, 409);
    assert.equal(await db.user.count(), 1);
    const stored = await db.user.findFirstOrThrow();
    assert.ok(stored.identityCiphertext.startsWith("dqpii:1:"));
    assert.ok(!JSON.stringify(stored).includes("@example.test"));
    assert.ok(stored.passwordHash.startsWith("$argon2id$"));
    const me = await fetch(base + "/me", { headers: { Authorization: `Bearer ${session.access_token}` } });
    assert.equal(me.status, 200);
    const audit = await db.auditLog.count({ where: { action: "admin_created", resourceId: stored.id } });
    assert.equal(audit, 1);
    await db.user.update({ where: { id: stored.id }, data: { isActive: false } });
    assert.deepEqual(await state(), { required: false }, "Disabled accounts must not reopen first-run registration");
  } finally {
    await app.close();
    await db.$disconnect();
  }
});
