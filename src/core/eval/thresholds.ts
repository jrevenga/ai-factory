// Versioned verdict thresholds (Phase 3 ruling 14); the values live in `defaults/eval-thresholds.json`.
import { z } from "zod";

const NonNegative = z.number().min(0);

export const EvalThresholds = z.strictObject({
  schema: z.literal(1),
  passRatePp: NonNegative,
  usageReductionPct: NonNegative,
  secondary: z.strictObject({
    escapedDefectsIncrease: NonNegative,
    wallTimeIncreasePct: NonNegative,
    usageIncreasePct: NonNegative,
  }),
});
export type EvalThresholds = z.infer<typeof EvalThresholds>;
