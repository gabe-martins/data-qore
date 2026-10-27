import { z } from "zod";
import type { DB } from "./db.js";
import type { IdentityCrypto } from "./identity.js";
import { hashPassword, passwordSchema, PublicError } from "./auth.js";

export const initialSetupSchema = z.object({
  display_name: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  password: passwordSchema,
}).strict();

const completed = () => new PublicError(409, "setup_complete", "Initial setup is already complete. Sign in with your account.");

export async function createInitialAdministrator(db: DB, identity: IdentityCrypto, input: unknown, requestId: string) {
  const values = initialSetupSchema.parse(input);
  if (await db.user.count()) throw completed();
  const passwordHash = await hashPassword(values.password);
  await db.$transaction(async tx => {
    // Same lock as the recovery CLI: concurrent visitors/CLI cannot both win.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(80420,1)`;
    if (await tx.user.count()) throw completed();
    let group = await tx.accessGroup.findFirst({ where: { profile: "platform_admin" }, orderBy: { createdAt: "asc" } });
    if (!group) group = await tx.accessGroup.create({ data: { name: "Platform Administrators", profile: "platform_admin" } });
    const user = await tx.user.create({ data: {
      ...identity.seal(values.email, values.display_name), passwordHash,
      groupId: group.id, mustChangePassword: false,
    } });
    await tx.auditLog.create({ data: {
      actorUserId: user.id, action: "admin_created", resourceType: "user",
      resourceId: user.id, outcome: "success", requestId,
    } });
  }, { isolationLevel: "ReadCommitted" });
  return values;
}
