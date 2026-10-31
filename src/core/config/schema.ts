import { z } from "zod";

export const SOFT_GATES = [
  "design-approval",
  "new-dependency",
  "design-deviation",
  "review-disagreement",
  "quota-low",
] as const;
export const SoftGateId = z.enum(SOFT_GATES);
export type SoftGateId = z.infer<typeof SoftGateId>;

export const HARD_GATES = ["destructive", "remote-mutation", "secrets", "integration", "outside-root-write"] as const;
export const HardGateId = z.enum(HARD_GATES);
export type HardGateId = z.infer<typeof HardGateId>;

export const Autonomy = z.enum(["low", "medium", "high"]);
export const Parallelism = z.int().min(1).max(16);
const Budgets = z.partialRecord(z.enum(["claude", "codex"]), z.looseObject({ weeklyTokens: z.number().optional() }));

/** Shipped defaults (`defaults/config.json`). */
export const CoreConfig = z.looseObject({
  schema: z.literal(1),
  autonomy: Autonomy.default("medium"),
  parallelism: Parallelism.default(3),
  language: z.string().optional(),
  radar: z.boolean().default(false),
  maintainer: z.boolean().default(false),
  gates: z
    .looseObject({
      hard: z
        .array(HardGateId)
        .refine((l) => l.length === HARD_GATES.length && HARD_GATES.every((g, i) => l[i] === g), {
          message: "gates.hard must equal the fixed hard gate list",
        })
        .default([...HARD_GATES]),
      soften: z.array(SoftGateId).default([]),
    })
    .default({ hard: [...HARD_GATES], soften: [] }),
  budgets: Budgets.default({}),
});
export type CoreConfig = z.infer<typeof CoreConfig>;

/** `~/.factory/config.json`. Unknown fields are preserved. `gates.hard` is accepted so it can be reported as locked. */
export const PersonalConfig = z.looseObject({
  schema: z.literal(1),
  profile: z.string(),
  autonomy: Autonomy.optional(),
  parallelism: Parallelism.optional(),
  language: z.string().optional(),
  radar: z.boolean().optional(),
  maintainer: z.boolean().optional(),
  gates: z.looseObject({ soften: z.array(SoftGateId).optional() }).optional(),
  budgets: Budgets.optional(),
  machine: z.record(z.string(), z.string()).optional(),
});
export type PersonalConfig = z.infer<typeof PersonalConfig>;

/** `.factory/config.json`. `overrides` is strict: unknown override keys are a parse error. */
export const ProjectConfig = z.looseObject({
  schema: z.literal(1),
  minFactoryVersion: z.string().optional(),
  context: z.string().optional(),
  conventions: z.string().optional(),
  overrides: z
    .strictObject({
      language: z.string().optional(),
      gates: z.looseObject({ soften: z.array(SoftGateId).optional() }).optional(),
    })
    .optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
