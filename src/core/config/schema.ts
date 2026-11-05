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

export const AUTONOMY_LEVELS = ["low", "medium", "high"] as const;
export const Autonomy = z.enum(AUTONOMY_LEVELS);
export const Parallelism = z.int().min(1).max(16);
export const BUDGET_PROVIDERS = ["claude", "codex"] as const;
const Budget = z.looseObject({ weeklyTokens: z.number().optional() });
const Budgets = z.partialRecord(z.enum(BUDGET_PROVIDERS), Budget);

/**
 * Ruling R13: a reader of a persisted document accepts values a newer release may add to an enum (the
 * known values stay listed for editors), so a rollback never meets a document it cannot read; the
 * effective-config resolution ignores unknown values and records a violation for each.
 */
const openEnum = <T extends readonly [string, ...string[]]>(values: T) => z.union([z.enum(values), z.string()]);

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

/**
 * `~/.factory/config.json`. Unknown fields and unknown enum values (R13) are preserved. `gates.hard` is
 * accepted so it can be reported as locked.
 */
export const PersonalConfig = z.looseObject({
  schema: z.literal(1),
  profile: z.string(),
  autonomy: openEnum(AUTONOMY_LEVELS).optional(),
  parallelism: Parallelism.optional(),
  language: z.string().optional(),
  radar: z.boolean().optional(),
  maintainer: z.boolean().optional(),
  gates: z.looseObject({ soften: z.array(openEnum(SOFT_GATES)).optional() }).optional(),
  budgets: z.record(z.string(), Budget).optional(),
  machine: z.record(z.string(), z.string()).optional(),
});
export type PersonalConfig = z.infer<typeof PersonalConfig>;

/**
 * `commands` of `.factory/config.json` (Phase 2 Task 10): project-declared check runners. Each is tokenized with the
 * gate's lexer and allowlisted only by argv equality (never by prefix); hard gates still apply. Loose: a newer
 * release may declare more names.
 */
export const DECLARED_COMMAND_NAMES = ["test", "build", "lint", "typecheck"] as const;
export const ProjectCommands = z.looseObject({
  test: z.string().optional(),
  build: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
});
export type ProjectCommands = z.infer<typeof ProjectCommands>;

/** `.factory/config.json`. `overrides` is strict: unknown override keys are a parse error. */
export const ProjectConfig = z.looseObject({
  schema: z.literal(1),
  minFactoryVersion: z.string().optional(),
  context: z.string().optional(),
  conventions: z.string().optional(),
  commands: ProjectCommands.optional(),
  overrides: z
    .strictObject({
      language: z.string().optional(),
      gates: z.looseObject({ soften: z.array(SoftGateId).optional() }).optional(),
    })
    .optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
