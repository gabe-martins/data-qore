import { IdentityCrypto } from "../src/identity.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { database } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
if (process.env.DATAQORE_ISOLATED_TEST !== "1")
  throw Error("Disposable fixture required.");
const c = loadConfig();
const db = database(c.databaseUrl);
if (!(await db.user.count()))
  await db.user.create({
    data: {
      ...new IdentityCrypto(c.identityKey).seal("admin@dataqore.test", "Test Administrator"),
      groupId: (await db.accessGroup.findFirstOrThrow({ where: { profile: "platform_admin" } })).id,
      passwordHash: await hashPassword("DataQore-test-password-2026"),
    },
  });
const { app } = await createApp(c, db);
await app.listen(Number(process.env.TEST_CONTROLLER_PORT), "127.0.0.1");
process.stdout.write("TEST_CONTROLLER_READY\n");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.$disconnect())
      .then(() => process.exit(0));
  });
