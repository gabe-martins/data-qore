import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PublicError, type Auth } from "./auth.js";
import type { DB } from "./db.js";
import type { Config } from "./config.js";

export const cronSchema = z.object({
  cron_expression: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(100).default("America/Sao_Paulo"),
}).strict();
export const scheduleSchema = cronSchema.extend({
  name: z.string().trim().min(1).max(255),
  comparison_id: z.uuid(),
  is_active: z.boolean().default(true),
});
export const schedulePatchBaseSchema = scheduleSchema.extend({ timezone: z.string().trim().min(1).max(100), is_active: z.boolean() }).partial();
export const schedulePatchSchema = schedulePatchBaseSchema.refine(v => Object.keys(v).length > 0);
export const scheduleOutSchema = scheduleSchema.extend({ id: z.uuid(), next_run_at: z.iso.datetime(), created_at: z.iso.datetime(), updated_at: z.iso.datetime() });
export const dispatchOutSchema = z.object({ id: z.uuid(), schedule_id: z.uuid(), comparison_id: z.uuid(),
  scheduled_for: z.iso.datetime(), status: z.enum(["pending", "dispatched", "skipped", "failed"]),
  attempts: z.number().int(), run_id: z.uuid().nullable(), error_code: z.string().nullable(),
  finished_at: z.iso.datetime().nullable(), created_at: z.iso.datetime() });

export function nextDates(expression: string, timezone: string, after = new Date(), count = 3) {
  // Traditional numeric/name fields only: no seconds, macros, H, L, W, # or shell commands.
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some(f => !/^[\dA-Za-z*,/\-]+$/.test(f)) ||
      /[HLW]/i.test(fields.join("").replace(/(?:JUL|WED|THU)/gi, "")))
    throw new PublicError(422, "invalid_cron", "Use five cron fields: minute hour day-of-month month day-of-week.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
    const iterator = CronExpressionParser.parse(fields.join(" "), { tz: timezone, currentDate: after });
    return Array.from({ length: count }, () => iterator.next().toDate());
  } catch {
    throw new PublicError(422, "invalid_cron", "Invalid cron expression, timezone, or expression with no future date.");
  }
}

export class EngineCallError extends Error {
  constructor(public code: string, public retryable: boolean) { super(code); }
}

export async function engineCall(config: Config, path: string, method = "GET", key?: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(config.engineUrl + "/v1" + path, {
      method, redirect: "error", signal: AbortSignal.timeout(45000),
      headers: { "X-API-Key": config.engineKey, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
  } catch { throw new EngineCallError("engine_unavailable", true); }
  let data: any;
  try { data = await response.json(); } catch { throw new EngineCallError("invalid_engine_response", true); }
  if (!response.ok) {
    const allowed = ["connection_inactive", "comparison_inactive", "not_found", "idempotency_conflict", "storage_unavailable"];
    throw new EngineCallError(allowed.includes(data.code) ? data.code : "engine_error", response.status >= 500);
  }
  return data;
}

export function scheduleOut(s: any) {
  return { id: s.id, name: s.name, comparison_id: s.comparisonId, cron_expression: s.cronExpression,
    timezone: s.timezone, is_active: s.isActive, next_run_at: s.nextRunAt,
    created_at: s.createdAt, updated_at: s.updatedAt };
}
export function dispatchOut(d: any) {
  return { id: d.id, schedule_id: d.scheduleId, comparison_id: d.comparisonId,
    scheduled_for: d.scheduledFor, status: d.status, attempts: d.attempts, run_id: d.runId,
    error_code: d.errorCode, finished_at: d.finishedAt, created_at: d.createdAt };
}

export class Schedules {
  constructor(private db: DB, private config: Config, private auth: Auth) {}
  async target(id: string) {
    try { return await engineCall(this.config, "/comparisons/" + id); }
    catch (e) {
      if (e instanceof EngineCallError)
        throw new PublicError(e.code === "not_found" ? 404 : 503, e.code, "Unable to access the comparison. Check the engine and selected comparison.");
      throw e;
    }
  }
  async create(input: unknown, actor: string, requestId: string) {
    const v = scheduleSchema.parse(input);
    const [next] = nextDates(v.cron_expression, v.timezone);
    const comparison = await this.target(v.comparison_id);
    if (v.is_active && !comparison.is_active)
      throw new PublicError(409, "comparison_inactive", "Activate the comparison before enabling its schedule.");
    const row = await this.db.schedule.create({ data: { name: v.name, comparisonId: v.comparison_id,
      cronExpression: v.cron_expression, timezone: v.timezone, isActive: v.is_active, nextRunAt: next, createdBy: actor } });
    await this.auth.audit("schedule:create", "success", actor, requestId, "schedule", row.id);
    return scheduleOut(row);
  }
  async update(id: string, input: unknown, actor: string, requestId: string) {
    const v = schedulePatchSchema.parse(input);
    const old = await this.db.schedule.findUnique({ where: { id } });
    if (!old) throw new PublicError(404, "not_found", "Schedule not found.");
    const cron = v.cron_expression ?? old.cronExpression, tz = v.timezone ?? old.timezone;
    const [next] = nextDates(cron, tz);
    const target = v.comparison_id ?? old.comparisonId;
    if (v.is_active === true || target !== old.comparisonId) {
      const comparison = await this.target(target);
      if ((v.is_active ?? old.isActive) && !comparison.is_active)
        throw new PublicError(409, "comparison_inactive", "Activate the comparison before enabling its schedule.");
    }
    const row = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM app.schedules WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.schedule.findUnique({ where: { id } });
      if (!current) throw new PublicError(404, "not_found", "Schedule not found.");
      // Avoid overwriting another editor's full definition after remote validation.
      if (current.updatedAt.getTime() !== old.updatedAt.getTime())
        throw new PublicError(409, "resource_conflict", "Schedule changed. Reload before saving.");
      if (v.is_active === false || v.cron_expression !== undefined || v.timezone !== undefined || v.comparison_id !== undefined) {
        await tx.scheduleDispatch.updateMany({ where: { scheduleId: id, status: "pending", enqueueStarted: false },
          data: { status: "skipped", errorCode: "schedule_changed", finishedAt: new Date() } });
      }
      return tx.schedule.update({ where: { id }, data: { name: v.name, comparisonId: target,
        cronExpression: cron, timezone: tz, isActive: v.is_active, updatedAt: new Date(),
        ...(v.cron_expression !== undefined || v.timezone !== undefined || v.comparison_id !== undefined || v.is_active === true ? { nextRunAt: next } : {}) } });
    });
    await this.auth.audit("schedule:update", "success", actor, requestId, "schedule", id);
    return scheduleOut(row);
  }
}

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private current?: Promise<void>;
  constructor(private db: DB, private config: Config, private auth: Auth,
    private call: typeof engineCall = engineCall) {}
  start() {
    this.timer = setInterval(() => this.trigger(), 15000);
    this.timer.unref(); this.trigger();
  }
  private trigger() {
    if (this.current) return;
    this.current = this.tick().catch(() => {
      process.stderr.write('{"code":"scheduler_unavailable"}\n');
    }).finally(() => { this.current = undefined; });
  }
  async stop() { if (this.timer) clearInterval(this.timer); await this.current; }
  async tick(now = new Date()) {
    await this.db.$transaction(async tx => {
      const due = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM app.schedules
        WHERE is_active AND next_run_at <= ${now} ORDER BY next_run_at, id FOR UPDATE SKIP LOCKED LIMIT 20`;
      for (const { id } of due) {
        const schedule = (await tx.schedule.findUnique({ where: { id } }))!;
        // One overdue occurrence after downtime, never a burst of all missed minutes.
        const [next] = nextDates(schedule.cronExpression, schedule.timezone, now);
        await tx.scheduleDispatch.create({ data: { scheduleId: id, comparisonId: schedule.comparisonId,
          scheduledFor: schedule.nextRunAt, retryAt: now } });
        await tx.schedule.update({ where: { id }, data: { nextRunAt: next } });
      }
    });
    for (let n = 0; n < 20; n++) {
      const token = randomUUID();
      const dispatch = await this.db.$transaction(async tx => {
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM app.schedule_dispatches
          WHERE status='pending' AND retry_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
          ORDER BY scheduled_for, id FOR UPDATE SKIP LOCKED LIMIT 1`;
        if (!rows.length) return null;
        return tx.scheduleDispatch.update({ where: { id: rows[0].id }, data: {
          claimToken: token, leaseUntil: new Date(Date.now() + 180000), attempts: { increment: 1 } } });
      });
      if (!dispatch) break;
      let status = "dispatched", errorCode: string | null = null, runId: string | null = null;
      let retry = false;
      try {
        const schedule = await this.db.schedule.findUnique({ where: { id: dispatch.scheduleId } });
        // A retry must recover a potentially accepted request even after pausing/editing.
        if (!dispatch.enqueueStarted && (!schedule?.isActive || schedule.comparisonId !== dispatch.comparisonId)) {
          status = "skipped"; errorCode = "schedule_inactive";
        } else {
          let busy = false;
          if (!dispatch.enqueueStarted) {
            for (const state of ["queued", "running"]) {
              const runs = await this.call(this.config, `/runs?comparison_id=${dispatch.comparisonId}&status=${state}&limit=1`);
              if (runs.total > 0) { busy = true; break; }
            }
          }
          if (busy) { status = "skipped"; errorCode = "comparison_busy"; }
          else {
            const claimed = await this.db.scheduleDispatch.updateMany({ where: { id: dispatch.id, status: "pending", claimToken: token }, data: { enqueueStarted: true } });
            if (!claimed.count) continue;
            const run = await this.call(this.config, `/comparisons/${dispatch.comparisonId}/runs`, "POST", "schedule:" + dispatch.id);
            runId = z.uuid().parse(run.id);
          }
        }
      } catch (e) {
        errorCode = e instanceof EngineCallError ? e.code : "invalid_engine_response";
        retry = (!(e instanceof EngineCallError) || e.retryable) && dispatch.attempts < 5;
        status = retry ? "pending" : "failed";
      }
      const changed = await this.db.scheduleDispatch.updateMany({ where: { id: dispatch.id, status: "pending", claimToken: token }, data: {
        status, runId, errorCode, leaseUntil: null, claimToken: null,
        retryAt: new Date(Date.now() + Math.min(300, 30 * 2 ** (dispatch.attempts - 1)) * 1000),
        finishedAt: retry ? null : new Date() } });
      if (changed.count && status !== "pending")
        await this.auth.audit("schedule:dispatch", status === "failed" ? "failure" : "success", null, randomUUID(), "schedule", dispatch.scheduleId);
    }
  }
}
