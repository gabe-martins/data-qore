import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import argon2 from "argon2";
import { z } from "zod";
import type { DB } from "./db.js";
import type { Config } from "./config.js";
export class PublicError extends Error {
  constructor(
    public status: number,
    public code: string,
    public publicMessage: string,
  ) {
    super(code);
  }
}
export const passwordSchema = z.string().min(12).max(128);
export const loginSchema = z
  .object({ email: z.email().max(320), password: z.string().min(1).max(128) })
  .strict();
export const changeSchema = z
  .object({
    current_password: z.string().min(1).max(128),
    new_password: passwordSchema,
  })
  .strict();
export const hashPassword = (p: string) =>
  argon2.hash(p, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const safeUser = (u: {
  id: string;
  email: string;
  displayName: string;
  role: string;
}) => ({ id: u.id, email: u.email, display_name: u.displayName, role: u.role });
const unauthorized = () =>
  new PublicError(
    401,
    "unauthorized",
    "Invalid credentials or expired session.",
  );
export class Auth {
  private secret: Uint8Array;
  private dummy: Promise<string>;
  constructor(
    public db: DB,
    private config: Config,
  ) {
    this.secret = new TextEncoder().encode(config.jwtSecret);
    this.dummy = hashPassword(randomBytes(32).toString("hex"));
  }
  async audit(
    action: string,
    outcome: "success" | "failure",
    actor: string | null,
    requestId: string,
    resourceType = "auth",
    resourceId?: string,
  ) {
    try {
      await this.db.auditLog.create({
        data: {
          actorUserId: actor,
          action,
          outcome,
          requestId,
          resourceType,
          resourceId,
        },
      });
    } catch {
      process.stderr.write(
        JSON.stringify({ code: "audit_unavailable", request_id: requestId }) +
          "\n",
      );
    }
  }
  async token(user: Parameters<typeof safeUser>[0], sessionId: string) {
    const access_token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("dataqore-controller")
      .setAudience("dataqore-web")
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessSeconds}s`)
      .sign(this.secret);
    return {
      access_token,
      token_type: "Bearer",
      expires_in: this.config.accessSeconds,
      user: safeUser(user),
    };
  }
  async login(input: unknown, requestId: string) {
    const { email, password } = loginSchema.parse(input);
    const user = await this.db.user.findFirst({
      where: { email: { equals: email.trim(), mode: "insensitive" } },
    });
    const valid = await argon2.verify(
      user?.passwordHash ?? (await this.dummy),
      password,
    );
    if (!valid || !user?.isActive) {
      await this.audit("login", "failure", null, requestId);
      throw unauthorized();
    }
    const refresh = randomBytes(48).toString("base64url");
    const session = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app.users WHERE id=${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current?.isActive || current.passwordHash !== user.passwordHash)
        throw unauthorized();
      return tx.authSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: digest(refresh),
          expiresAt: new Date(Date.now() + this.config.refreshSeconds * 1000),
        },
      });
    });
    await this.audit("login", "success", user.id, requestId);
    return {
      body: await this.token(user, session.id),
      refresh,
      expires: session.expiresAt,
    };
  }
  async refresh(raw: string | undefined, requestId: string) {
    if (!raw || raw.length > 256) throw unauthorized();
    const tokenHash = digest(raw);
    const replacement = randomBytes(48).toString("base64url");
    const result = await this.db.$transaction(async (tx) => {
      const found = await tx.authSession.findUnique({
        where: { refreshTokenHash: tokenHash },
        select: { userId: true },
      });
      if (!found) return { invalid: true } as const;
      await tx.$queryRaw`SELECT id FROM app.users WHERE id=${found.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM app.auth_sessions WHERE refresh_token_hash=${tokenHash} FOR UPDATE`;
      const old = await tx.authSession.findUnique({
        where: { refreshTokenHash: tokenHash },
        include: { user: true },
      });
      if (!old) return { invalid: true } as const;
      if (old.revokedAt) {
        await tx.authSession.updateMany({
          where: { userId: old.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { invalid: true } as const;
      }
      if (old.expiresAt <= new Date() || !old.user.isActive)
        return { invalid: true } as const;
      await tx.authSession.update({
        where: { id: old.id },
        data: { revokedAt: new Date() },
      });
      const next = await tx.authSession.create({
        data: {
          userId: old.userId,
          refreshTokenHash: digest(replacement),
          expiresAt: old.expiresAt,
        },
      });
      return { user: old.user, session: next } as const;
    });
    if ("invalid" in result) {
      await this.audit("refresh", "failure", null, requestId);
      throw unauthorized();
    }
    return {
      body: await this.token(result.user, result.session.id),
      refresh: replacement,
      expires: result.session.expiresAt,
    };
  }
  async authorize(header?: string) {
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    let payload;
    try {
      ({ payload } = await jwtVerify(header.slice(7), this.secret, {
        algorithms: ["HS256"],
        issuer: "dataqore-controller",
        audience: "dataqore-web",
      }));
    } catch {
      throw unauthorized();
    }
    if (typeof payload.sid !== "string" || typeof payload.sub !== "string")
      throw unauthorized();
    const session = await this.db.authSession.findUnique({
      where: { id: payload.sid },
      include: { user: true },
    });
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      !session.user.isActive
    )
      throw unauthorized();
    return { user: safeUser(session.user), sessionId: session.id };
  }
  async logout(
    session: { user: { id: string }; sessionId: string },
    requestId: string,
  ) {
    await this.db.authSession.updateMany({
      where: { id: session.sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit("logout", "success", session.user.id, requestId);
  }
  async change(
    session: { user: { id: string } },
    input: unknown,
    requestId: string,
  ) {
    const p = changeSchema.parse(input);
    const u = await this.db.user.findUniqueOrThrow({
      where: { id: session.user.id },
    });
    if (!(await argon2.verify(u.passwordHash, p.current_password)))
      throw unauthorized();
    const hash = await hashPassword(p.new_password);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app.users WHERE id=${u.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: u.id } });
      if (!current?.isActive || current.passwordHash !== u.passwordHash)
        throw unauthorized();
      await tx.user.update({
        where: { id: u.id },
        data: { passwordHash: hash, updatedAt: new Date() },
      });
      await tx.authSession.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    await this.audit("change_password", "success", u.id, requestId);
  }
}
