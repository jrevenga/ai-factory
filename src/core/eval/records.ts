// Per-run records (`results.jsonl`) and the immutable run manifest (Phase 3 rulings 4, 13, 16, 21).
import { z } from "zod";
import { ContenderId, ProfileName, ProviderId } from "./contenders.ts";
import { TASK_SPLITS, TASK_TIERS } from "./task.ts";
import { EvalThresholds } from "./thresholds.ts";

const Count = z.int().min(0);

export const Usage = z.strictObject({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count });
export type Usage = z.infer<typeof Usage>;

export const QuotaStatus = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("known"),
    utilization: z.number(),
    window: z.string().optional(),
    resetsAt: z.string().optional(),
  }),
  z.strictObject({ state: z.literal("exhausted") }),
  z.strictObject({ state: z.literal("unknown") }),
]);
export type QuotaStatus = z.infer<typeof QuotaStatus>;

export const CheckResult = z.strictObject({
  name: z.string(),
  pass: z.boolean(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  ms: z.number(),
});

export const EvalRunRecord = z.strictObject({
  v: z.literal(1),
  evalRunId: z.string(),
  taskId: z.string(),
  contender: ContenderId,
  rep: z.int().min(0),
  startedAt: z.string(),
  wallMs: z.number(),
  exit: z.enum(["ok", "error", "timeout", "skipped-budget"]),
  exitCode: z.number().nullable(),
  turns: Count,
  gatesHit: Count,
  checks: z.array(CheckResult),
  pass: z.boolean(),
  escapedDefects: Count,
  usage: z.partialRecord(ProviderId, Usage),
  usageMissing: z.boolean(),
  quota: z.partialRecord(ProviderId, QuotaStatus),
  diffStat: z.strictObject({ files: Count, insertions: Count, deletions: Count }).nullable(),
  reviewFindings: z.null(),
  corrections: z.null(),
  authWriteBack: z.enum(["unchanged", "written", "rejected"]).nullable(),
  leakSuspect: z.boolean(),
  errorSummary: z.string().max(500).nullable(),
});
export type EvalRunRecord = z.infer<typeof EvalRunRecord>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Sha1 = z.string().regex(/^[0-9a-f]{40}$/);
const Exposure = z.enum(["public", "private"]);

export const EvalRunManifest = z.strictObject({
  v: z.literal(1),
  evalRunId: z.string(),
  createdAt: z.string(),
  suite: z.string(),
  profile: ProfileName.nullable(),
  contenders: z.array(
    z.strictObject({
      id: ContenderId,
      model: z.string().nullable(),
      provider: ProviderId.nullable(),
      argvTemplate: z.array(z.string()),
      envKeys: z.array(z.string()),
    }),
  ),
  reps: z.int().min(1),
  seed: z.number(),
  tasks: z.array(
    z.strictObject({
      id: z.string(),
      tier: z.enum(TASK_TIERS),
      split: z.enum(TASK_SPLITS),
      source: Exposure,
      exposure: Exposure,
      snapshotSha: Sha1,
      taskSha256: Sha256,
      checksSha256: Sha256,
      solutionSha256: Sha256.nullable(),
    }),
  ),
  pins: z.strictObject({
    claude: z.string().optional(),
    codex: z.string().optional(),
    pi: z.string(),
    bridge: z.string(),
    superpowersCommit: z.string().optional(),
  }),
  drift: z.array(z.string()),
  factory: z.strictObject({ version: z.string(), commit: z.string().nullable() }),
  host: z.strictObject({ platform: z.string(), bwrap: z.string().nullable() }),
  thresholds: EvalThresholds,
  confirms: z.string().nullable(),
});
export type EvalRunManifest = z.infer<typeof EvalRunManifest>;
