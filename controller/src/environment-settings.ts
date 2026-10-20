import { z } from "zod";

// Decimal strings avoid a binary float round trip before persistence.
export const environmentSettingsPatch = z.object({
  comparison_target_percentage: z.string().regex(/^(?:100(?:\.0{1,4})?|\d{1,2}(?:\.\d{1,4})?)$/),
}).strict();
export const environmentSettingsOut = z.object({
  comparison_target_percentage: z.string(),
  updated_at: z.string().datetime(),
});
