import { z } from "zod";
import { IdentityCrypto } from "./identity.js";
import type { DB } from "./db.js";
import { hashPassword, passwordSchema, PublicError } from "./auth.js";
import { profiles, profilePermissions, profileLabels } from "./permissions.js";

const name = z.string().trim().min(1).max(255);
export const groupSchema = z.object({ name, description: z.string().trim().max(1000).default(""), profile: z.enum(profiles) }).strict();
export const groupPatchSchema = z.object({ name: name.optional(), description: z.string().trim().max(1000).optional(), profile: z.enum(profiles).optional() }).strict().refine(v => Object.keys(v).length > 0);
export const userSchema = z.object({ email: z.email().max(320).transform(v => v.toLowerCase()), display_name: name,
  group_id: z.uuid(), temporary_password: passwordSchema, is_active: z.boolean().default(true) }).strict();
export const userPatchSchema = z.object({ email: z.email().max(320).transform(v => v.toLowerCase()).optional(), display_name: name.optional(), group_id: z.uuid().optional(), is_active: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0);
export const resetSchema = z.object({ temporary_password: passwordSchema }).strict();
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20), offset: z.coerce.number().int().min(0).default(0), search: z.string().trim().max(255).default("") }).strict();
export const groupOut = (g: any) => ({ id: g.id, name: g.name, description: g.description, profile: g.profile,
  profile_label: profileLabels[g.profile as typeof profiles[number]], permissions: profilePermissions[g.profile as typeof profiles[number]], user_count: g._count?.users });
export const userOut = (u: any) => ({ id: u.id, email: u.email, display_name: u.displayName, group_id: u.groupId,
  group: groupOut(u.group), is_active: u.isActive, must_change_password: u.mustChangePassword, created_at: u.createdAt, updated_at: u.updatedAt });
const missing = () => new PublicError(404, "not_found", "Resource not found.");
// Serialize all access changes, including CLI bootstrap. Recheck the actor after acquiring it.
export async function accessTransaction<T>(db: DB, actor: { user: { id: string }; sessionId: string }, work: (tx: any) => Promise<T>) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(80420,1)`;
    const session = await tx.authSession.findUnique({ where: { id: actor.sessionId }, include: { user: { include: { group: true } } } });
    if (!session || session.userId !== actor.user.id || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive || session.user.mustChangePassword || session.user.group.profile !== "platform_admin")
      throw new PublicError(403, "forbidden", "Access administration is not allowed.");
    const result = await work(tx);
    if (!await tx.user.count({ where: { isActive: true, group: { profile: "platform_admin" } } }))
      throw new PublicError(409, "last_administrator", "Keep at least one active platform administrator.");
    return result;
  }, { timeout: 15000 });
}
export function accessOperations(db: DB, identity: IdentityCrypto): [string, string, (req: any, res: any) => Promise<any>][] {
  async function mutate(req: any, action: string, resourceType: string, work: (tx: any) => Promise<any>) {
    return accessTransaction(db, req.access, async tx => {
      const result = await work(tx);
      await tx.auditLog.create({ data: { actorUserId: req.access.user.id, action, resourceType,
        resourceId: result.id, requestId: req.id, outcome: "success" } });
      return result;
    });
  }
  async function group(tx: any, id: string) {
    const g = await tx.accessGroup.findUnique({ where: { id } });
    if (!g) throw missing(); return g;
  }
  async function user(tx: any, id: string) {
    await tx.$queryRaw`SELECT id FROM app.users WHERE id=${id}::uuid FOR UPDATE`;
    const u = await tx.user.findUnique({ where: { id }, include: { group: true } });
    if (!u) throw missing(); return u;
  }
  const revoke = (tx: any, userId: string) => tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return [
    ["get", "/api/v1/users", async req => {
      const q = pageSchema.parse(req.query), search = q.search.toLowerCase();
      // Filter decrypted, authorized rows before pagination; never index plaintext PII.
      return db.$transaction(async tx => {
        const items: any[] = []; let total = 0, cursor: string | undefined;
        while (true) {
          const rows = await tx.user.findMany({ include: { group: true }, take: 200,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
          for (const stored of rows) {
            const u = identity.open(stored);
            if (search && !u.email.toLowerCase().includes(search) && !u.displayName.toLowerCase().includes(search)) continue;
            if (total >= q.offset && items.length < q.limit) items.push(userOut(u));
            total++;
          }
          if (rows.length < 200) break;
          cursor = rows[rows.length - 1].id;
        }
        return { items, total, limit: q.limit, offset: q.offset };
      }, { isolationLevel: "RepeatableRead", timeout: 15000 });
    }],
    ["post", "/api/v1/users", async (req, res) => {
      const v = userSchema.parse(req.body), passwordHash = await hashPassword(v.temporary_password);
      const result = await mutate(req, "user:create", "user", async tx => {
        await group(tx, v.group_id);
        return userOut(identity.open(await tx.user.create({ data: { ...identity.seal(v.email, v.display_name), groupId: v.group_id, passwordHash, isActive: v.is_active, mustChangePassword: true }, include: { group: true } })));
      }); res.status(201); return result;
    }],
    ["patch", "/api/v1/users/:id", async req => {
      const id = z.uuid().parse(req.params.id), v = userPatchSchema.parse(req.body);
      return mutate(req, "user:update", "user", async tx => {
        const old = identity.open(await user(tx, id)); if (v.group_id) await group(tx, v.group_id);
        const row = await tx.user.update({ where: { id }, data: { ...((v.email !== undefined || v.display_name !== undefined) ? identity.seal(v.email ?? old.email, v.display_name ?? old.displayName, id) : {}), groupId: v.group_id, isActive: v.is_active, updatedAt: new Date() }, include: { group: true } });
        if ((v.group_id !== undefined && v.group_id !== old.groupId) || v.is_active === false) await revoke(tx, id);
        return userOut(identity.open(row));
      });
    }],
    ["post", "/api/v1/users/:id/reset-password", async req => {
      const id = z.uuid().parse(req.params.id), v = resetSchema.parse(req.body), passwordHash = await hashPassword(v.temporary_password);
      return mutate(req, "user:reset_password", "user", async tx => {
        await user(tx, id); await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true, updatedAt: new Date() } }); await revoke(tx, id); return { id, status: "ok" };
      });
    }],
    ["post", "/api/v1/users/:id/revoke-sessions", async req => {
      const id = z.uuid().parse(req.params.id); z.object({}).strict().parse(req.body ?? {});
      return mutate(req, "user:revoke_sessions", "user", async tx => { await user(tx, id); await revoke(tx, id); return { id, status: "ok" }; });
    }],
    ["get", "/api/v1/groups", async req => {
      const q = pageSchema.parse(req.query), where = { name: { contains: q.search, mode: "insensitive" as const } };
      const [rows, total] = await db.$transaction([db.accessGroup.findMany({ where, include: { _count: { select: { users: true } } }, take: q.limit, skip: q.offset, orderBy: [{ name: "asc" }, { id: "asc" }] }), db.accessGroup.count({ where })]);
      return { items: rows.map(groupOut), total, limit: q.limit, offset: q.offset };
    }],
    ["post", "/api/v1/groups", async (req, res) => {
      const v = groupSchema.parse(req.body); const result = await mutate(req, "group:create", "group", async tx => groupOut(await tx.accessGroup.create({ data: v }))); res.status(201); return result;
    }],
    ["patch", "/api/v1/groups/:id", async req => {
      const id = z.uuid().parse(req.params.id), v = groupPatchSchema.parse(req.body);
      return mutate(req, "group:update", "group", async tx => {
        const old = await group(tx, id);
        // Same lock order as login/change/reset: user before session.
        if (v.profile && v.profile !== old.profile) await tx.$queryRaw`SELECT id FROM app.users WHERE group_id=${id}::uuid ORDER BY id FOR UPDATE`;
        const row = await tx.accessGroup.update({ where: { id }, data: { ...v, updatedAt: new Date() } });
        if (v.profile && v.profile !== old.profile) await tx.authSession.updateMany({ where: { user: { groupId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
        return groupOut(row);
      });
    }],
    ["delete", "/api/v1/groups/:id", async req => {
      const id = z.uuid().parse(req.params.id);
      return mutate(req, "group:delete", "group", async tx => {
        await group(tx, id); if (await tx.user.count({ where: { groupId: id } })) throw new PublicError(409, "group_in_use", "Move all users before deleting this group.");
        await tx.accessGroup.delete({ where: { id } }); return { id, status: "ok" };
      });
    }],
    ["get", "/api/v1/audit-log", async req => {
      const q = pageSchema.parse(req.query), where = { action: { contains: q.search, mode: "insensitive" as const } };
      const [items, total] = await db.$transaction([db.auditLog.findMany({ where, take: q.limit, skip: q.offset, orderBy: [{ createdAt: "desc" }, { id: "asc" }] }), db.auditLog.count({ where })]);
      return { items: items.map(a => ({ id: a.id, actor_user_id: a.actorUserId, action: a.action, resource_type: a.resourceType, resource_id: a.resourceId, request_id: a.requestId, outcome: a.outcome, created_at: a.createdAt })), total, limit: q.limit, offset: q.offset };
    }],
  ];
}
