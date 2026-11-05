// Eval task definition (`task.json`). Strict: an unknown key is a parse error.
import { z } from "zod";

export const TASK_TIERS = ["answer", "small", "feature", "project"] as const;
export const TASK_SPLITS = ["dev", "heldout"] as const;
export const TASK_SUITES = ["smoke", "full", "memory"] as const;

export const DEFAULT_GATE_REPLY = "Proceed with your best judgment and complete the task without asking further questions.";
export const DEFAULT_MAX_CONTINUATIONS = 3;

export const TaskId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const TaskSnapshot = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("dir") }),
  z.strictObject({ kind: z.literal("git"), url: z.string().min(1), ref: z.string().regex(/^[0-9a-f]{40}$/) }),
]);

export const TaskCheck = z.strictObject({
  name: z.string().min(1),
  argv: z.array(z.string()).min(1),
  timeoutSec: z.int().min(1).max(1800).default(300),
});

/** Ruling 19: the scripted answer to an agent waiting for a human. */
export const TaskGate = z.strictObject({
  reply: z.string().min(1),
  maxContinuations: z.int().min(0).max(10),
});

export const EvalTask = z.strictObject({
  schema: z.literal(1),
  id: TaskId,
  title: z.string().min(1),
  tier: z.enum(TASK_TIERS),
  split: z.enum(TASK_SPLITS),
  suites: z.array(z.enum(TASK_SUITES)).min(1),
  snapshot: TaskSnapshot,
  prompt: z.string().min(1),
  checks: z.array(TaskCheck).min(1),
  rubric: z.string().optional(),
  budget: z.strictObject({ wallSec: z.int().min(60).max(7200), maxTurns: z.int().min(1).optional() }),
  gate: TaskGate.default({ reply: DEFAULT_GATE_REPLY, maxContinuations: DEFAULT_MAX_CONTINUATIONS }),
});
export type EvalTask = z.infer<typeof EvalTask>;
