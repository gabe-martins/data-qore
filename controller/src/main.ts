import { loadConfig } from "./config.js";
import { database } from "./db.js";
import { createApp } from "./app.js";
import { Scheduler } from "./schedules.js";
const config = loadConfig();
const db = database(config.databaseUrl);
try {
  const { app, auth } = await createApp(config, db);
  await db.schedule.count(); // Migration must already exist; never apply DDL at runtime.
  const scheduler = new Scheduler(db, config, auth);
  await app.listen(3000, "127.0.0.1");
  scheduler.start();
  console.log("DataQore controller: http://127.0.0.1:3000");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app
        .close()
        .then(() => scheduler.stop())
        .then(() => db.$disconnect())
        .then(() => process.exit(0));
    });
} catch {
  await db.$disconnect();
  console.error(
    "Controller startup failed. Check local configuration and dependencies.",
  );
  process.exit(1);
}
