import { z } from "zod";
import type { DB } from "./db.js";
export const qualityTargetSchema = z
  .object({
    row_match_target_percentage: z
      .number()
      .min(0)
      .max(100)
      .multipleOf(0.0001)
      .nullable(),
  })
  .strict();
export const qualitySettingsSchema = z.object({
  row_match_target_percentage: z.string().nullable(),
  updated_at: z.string().datetime(),
  metric: z.literal("row_match_rate"),
});
export function qualitySettingsOut(row: {
  rowMatchTargetPercentage: { toString(): string } | null;
  updatedAt: Date;
}) {
  return {
    row_match_target_percentage:
      row.rowMatchTargetPercentage?.toString() ?? null,
    updated_at: row.updatedAt.toISOString(),
    metric: "row_match_rate" as const,
  };
}
export async function readQualitySettings(db: DB) {
  return qualitySettingsOut(
    await db.qualitySettings.findUniqueOrThrow({ where: { id: true } }),
  );
}
