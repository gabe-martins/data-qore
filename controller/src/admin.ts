import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { database } from "./db.js";
import { hashPassword, passwordSchema } from "./auth.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";
import { databaseFailure } from "./diagnostics.js";
async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw Error("Use an interactive terminal.");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    const onData = (data: Buffer) => {
      for (const char of decoder.write(data)) {
        if (char === "\u0003") {
          finish();
          reject(Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    function finish() {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }
    process.stdin.on("data", onData);
    // Disable terminal echo and attach the reader before displaying the prompt.
    process.stdout.write(prompt);
  });
}
const command = process.argv[2];
if (!["create", "reset-password"].includes(command)) {
  console.error("Usage: npm run admin:create OR npm run admin:reset-password");
  process.exit(1);
}
const db = database(loadConfig().databaseUrl);
try {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = z
    .email()
    .parse((await rl.question("Administrator email: ")).trim().toLowerCase());
  const name =
    command === "create"
      ? z
          .string()
          .trim()
          .min(1)
          .max(255)
          .parse(await rl.question("Display name: "))
      : "";
  rl.close();
  const password = passwordSchema.parse(
    await secret("Password (at least 12 characters, hidden): "),
  );
  if ((await secret("Confirm password (hidden): ")) !== password)
    throw Error("Passwords do not match.");
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(80420,1)`;
    const existing = await tx.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, group: { profile: "platform_admin" } },
    });
    let user;
    if (command === "create") {
      if (await tx.user.count())
        throw Error("An administrator already exists.");
      let group = await tx.accessGroup.findFirst({ where: { profile: "platform_admin" }, orderBy: { createdAt: "asc" } });
      if (!group) group = await tx.accessGroup.create({ data: { name: "Platform Administrators", profile: "platform_admin" } });
      user = await tx.user.create({ data: { email, displayName: name, passwordHash, groupId: group.id } });
    } else {
      if (!existing) throw Error("Administrator not found.");
      await tx.$queryRaw`SELECT id FROM app.users WHERE id=${existing.id}::uuid FOR UPDATE`;
      user = await tx.user.update({
        where: { id: existing.id },
        data: { passwordHash, mustChangePassword: true, updatedAt: new Date() },
      });
      await tx.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await tx.auditLog.create({
      data: {
        actorUserId: user.id,
        action: command === "create" ? "admin_created" : "password_reset",
        resourceType: "user",
        resourceId: user.id,
        outcome: "success",
        requestId: randomUUID(),
      },
    });
  });
  console.log("Administrator updated successfully.");
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? "Invalid input. Use a valid email and a password of 12–128 characters."
      : error instanceof Error &&
          [
            "An administrator already exists.",
            "Administrator not found.",
            "Passwords do not match.",
            "Cancelled.",
            "Use an interactive terminal.",
          ].includes(error.message)
        ? error.message
        : databaseFailure(error),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
