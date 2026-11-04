// Run ledger events (Phase 2 ruling 9). Loose objects: readers accept fields added by newer versions.
import { z } from "zod";
import { HARD_GATES } from "../config/schema.ts";
import { CheckRecord, ReviewDisposition } from "../evidence/records.ts";

const base = { v: z.literal(1), ts: z.string(), runId: z.string() };
const open = <T extends readonly [string, ...string[]]>(values: T) => z.union([z.enum(values), z.string()]);
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ ...base, type: z.literal(type), ...shape });

export const RunEvent = z.discriminatedUnion("type", [
  ev("run_start", {
    pid: z.number(),
    projectId: z.string(),
    projectRoot: z.string(),
    factoryVersion: z.string(),
    piSession: z.string().optional(),
    /** Run ids this run resumed after an interruption. */
    resumedFrom: z.array(z.string()).optional(),
  }),
  ev("run_end", { reason: z.string() }),
  ev("run_interrupted", { detectedBy: z.string() }),
  ev("gate", {
    tool: z.string(),
    toolCallId: z.string(),
    /** Set for a call another tool made (e.g. a codemode script). */
    parentToolCallId: z.string().optional(),
    /** `allow`/`deny`, or the outcome of an ask: `allow (approved)` / `deny (rejected)` (no UI: `deny`). */
    decision: open(["allow", "deny", "allow (approved)", "deny (rejected)"] as const),
    class: z.string().optional(),
    hardGate: open(HARD_GATES).optional(),
    reason: z.string(),
    summary: z.string(),
  }),
  ev("route", {
    state: z.record(z.string(), z.unknown()),
    /** Why the route changed: `set_route`, `restored from session`, `user input consumed`, ... */
    reason: z.string().optional(),
    /** The consumed user message (redacted, at most 500 chars) when `reason` is `user input consumed`. */
    input: z.string().optional(),
  }),
  ev("decision", {
    kind: open(["soft-gate-skipped", "soft-gate-resolved", "ruling"] as const),
    gate: z.string().optional(),
    justification: z.string(),
  }),
  ev("progress", { taskId: z.string(), phase: z.string().optional(), item: z.string().optional() }),
  ev("checkpoint", {
    taskId: z.string(),
    sha: z.string(),
    kind: z.enum(["commit", "undo-ref"]),
    /** R34: changed secret-path files left out of a checkpoint commit (worktree-relative, redacted). */
    excluded: z.array(z.string()).optional(),
  }),
  ev("check", { record: CheckRecord }),
  ev("reconciled", {
    toolCallId: z.string(),
    reverted: z.array(z.string()),
    moved: z.array(z.string()),
    backupDir: z.string(),
    /** Task 11: paths that could not be restored, each with its reason (current state and copies kept). */
    notRestored: z.array(z.string()).optional(),
    /** Task 11 (R39): gitlinks, nested repositories and entries below a symlink, never reconciled. */
    skipped: z.array(z.string()).optional(),
    /** Task 13: entries set aside (content in `after*`) whose backup could not be finished, each with the reason. */
    warnings: z.array(z.string()).optional(),
    indexRestored: z.boolean().optional(),
    /** Nothing changed, so the redundant backup directory was removed. */
    backupRemoved: z.boolean().optional(),
  }),
  ev("review", { disposition: ReviewDisposition }),
  ev("error", { where: z.string(), message: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const RUN_EVENT_TYPES: readonly string[] = RunEvent.options.map((o) => o.shape.type.value);

/**
 * Reader entry point: an event whose `type` this release does not know (written by a newer version)
 * comes back as `{ known: false, raw }` instead of failing. A known type with a bad shape, or a value
 * that is not an object with a string `type`, throws.
 */
export function parseRunEvent(raw: unknown): { known: true; event: RunEvent } | { known: false; raw: unknown } {
  const type = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
  if (typeof type === "string" && !RUN_EVENT_TYPES.includes(type)) return { known: false, raw };
  return { known: true, event: RunEvent.parse(raw) };
}

/** `<sanitized basename>-<first 12 hex of sha256(realpath)>`; the hash function is injected to keep core pure. */
export function projectIdFor(repoRootReal: string, sha256hex: (s: string) => string): string {
  const parts = repoRootReal.split(/[\\/]+/).filter((p) => p.length > 0);
  const name = (parts[parts.length - 1] ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "project";
  return `${name}-${sha256hex(repoRootReal).slice(0, 12)}`;
}

/** `<UTC yyyymmddThhmmssZ>-<pid>`. */
export function runIdFor(now: Date, pid: number): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${pid}`;
}
