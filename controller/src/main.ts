import { loadConfig } from "./config.js";
import { database } from "./db.js";
import { createApp } from "./app.js";
const config = loadConfig();
const db = database(config.databaseUrl);
try {
  const { app } = await createApp(config, db);
  await app.listen(3000, "127.0.0.1");
  console.log("DataQore controller: http://127.0.0.1:3000");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app
        .close()
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
