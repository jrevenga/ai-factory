// Startup recovery (Phase 2 Task 13, acceptance 2). Before the new run's `run_start` is written, the project's run
// ledger is reconciled: runs that ended without `run_end` while their process is gone are marked `run_interrupted`
// (claimed once per project, ledger.ts) and this Pi session's own interrupted earlier run is found independently of
// that claim (review M5), so a continued session restores its route flagged (ruling 20). The new run records the runs
// it resumed (`run_start.resumedFrom`); answer-route reconciliations interrupted runs left unfinished are finished
// (reconcile.ts `replayInterrupted`); and the next agent run gets one prompt section naming each interrupted task's
// phase and last checkpoint.
//
// Fix round 1: replay completion is tracked by the manifests themselves (a manifest stays retryable until it is `done`),
// not by the interruption marker. Every startup looks at every interrupted run with unfinished reconciles and replays
// it only while it owns the run's replay (ruling R52, replay-owners.ts: create-then-list unique entries in
// `<runDir>/replay.owners/`), so two live sessions never replay the same run at once.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "../../../core/ledger/events.ts";
import { ledgerDirFor, reconcile, runInterrupted, sessionInterruptedRuns, type InterruptedRun } from "./ledger.ts";
import { hasUnfinishedReconciles, replayInterrupted, type Diagnose } from "./reconcile.ts";
import { claimReplay } from "./replay-owners.ts";
import { lastRouteEntryRunId } from "./route-state.ts";

/** Key of the resume section in `systemPromptOptions.sections`. */
export const RESUME_SECTION_KEY = "factory-resume";

/** The resume line for an interrupted run with a task; undefined when the run had no task. */
export function resumeLine(run: InterruptedRun): string | undefined {
  const taskId = run.lastProgress?.taskId ?? run.lastCheckpoint?.taskId ?? run.route?.taskId;
  if (taskId === undefined) return undefined;
  const phase = run.lastProgress?.taskId === taskId ? run.lastProgress.phase : undefined;
  const sha = run.lastCheckpoint?.taskId === taskId ? run.lastCheckpoint.sha : undefined;
  return `Interrupted factory run ${run.runId}: task ${taskId}, phase ${phase ?? "unknown"}, last checkpoint ${sha ?? "none"}. Resume from the checkpoint; re-declare the route with set_route.`;
}

export { lastRouteEntryRunId };

export interface RecoveryInput {
  factoryHome: string;
  projectId: string;
  /** The new run's id (its ledger does not exist yet). */
  runId: string;
  piSession?: string;
  /** The Pi session branch (oldest first), for the last route entry's run. */
  entries: readonly unknown[];
  isAlive(pid: number): boolean;
}

export interface Recovery {
  /** Runs this session picked up: claimed interrupted runs of the project and this session's own interrupted run. */
  resumedFrom: string[];
  /** This Pi session's previous run was interrupted: the restored route starts flagged (ruling 20). */
  sessionInterrupted: boolean;
  /** Runs claimed here (marked `run_interrupted` by this run). */
  claimed: InterruptedRun[];
  /** One line per interrupted run with a task. */
  lines: string[];
  /** Interrupted runs whose ledger could not be read (reported, not marked). */
  errors: string[];
}

/** Marks and finds the interrupted runs before `run_start` is written. Throws only when the ledger dir is unusable. */
export function recoverRuns(input: RecoveryInput): Recovery {
  const found = reconcile(input.factoryHome, input.projectId, input.runId, input.isAlive);
  const routeRunId = lastRouteEntryRunId(input.entries);
  const own = sessionInterruptedRuns(
    input.factoryHome,
    input.projectId,
    input.runId,
    { ...(input.piSession !== undefined ? { piSession: input.piSession } : {}), ...(routeRunId !== undefined ? { routeRunId } : {}) },
    input.isAlive,
  );
  const claimed = found.filter((r) => r.error === undefined);
  const errors = [...found, ...own].filter((r) => r.error !== undefined).map((r) => `factory: the run ledger of ${r.runId} cannot be read (${r.error})`);
  const byId = new Map<string, InterruptedRun>();
  for (const r of [...claimed, ...own.filter((o) => o.error === undefined)]) if (!byId.has(r.runId)) byId.set(r.runId, r);
  const runs = [...byId.values()].sort((a, b) => a.runId.localeCompare(b.runId));
  const lines = runs.map(resumeLine).filter((l): l is string => l !== undefined);
  return { resumedFrom: runs.map((r) => r.runId), sessionInterrupted: own.length > 0, claimed, lines, errors: [...new Set(errors)] };
}

interface Sink {
  append(e: RunEvent): void;
}

export interface ReplayInput {
  factoryHome: string;
  projectId: string;
  /** The new run (it audits the replays). */
  runId: string;
  isAlive(pid: number): boolean;
}

/**
 * After `run_start`: finishes the answer-route reconciliations that interrupted runs of the project left unfinished,
 * audited in this run's ledger. A run qualifies when its `reconcile/` holds unfinished work (reconcile.ts
 * `hasUnfinishedReconciles`) and it is interrupted (`ledger.runInterrupted`), whoever detected it; it is replayed only
 * while this session owns its replay (R52, `claimReplay`), so a run another live session is replaying, or contending
 * for, is left to it (a note says so; retried at a later startup). The ownership entry is removed when the replay ends.
 * Newest run first (reverse snapshot order across runs, as within one). A failure is reported (note, `diagnose`,
 * ledger `error`) and left for a retry. Returns one note per replayed, kept or failed item, prefixed with the
 * interrupted run's id.
 */
export function replayInterruptedRuns(input: ReplayInput, ledger: Sink, diagnose?: Diagnose): string[] {
  const dir = ledgerDirFor(input.factoryHome, input.projectId);
  let runIds: string[];
  try {
    runIds = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== input.runId)
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const notes: string[] = [];
  for (const runId of runIds) {
    const runDir = join(dir, runId);
    try {
      if (!hasUnfinishedReconciles(runDir) || runInterrupted(dir, runId, input.isAlive) !== true) continue;
      const claim = claimReplay(runDir, input.runId, input.isAlive);
      if (claim === undefined) {
        notes.push(`Interrupted factory run ${runId}: replay in progress elsewhere; another live session is replaying (or contending for) its answer-route reconciles, so they are left to it and retried at a later startup`);
        continue;
      }
      try {
        for (const outcome of replayInterrupted(runDir, ledger, input.runId, diagnose, { owns: claim.owns })) {
          for (const n of outcome.notes) notes.push(`Interrupted factory run ${runId}: ${n}`);
        }
      } finally {
        claim.release();
      }
    } catch (e) {
      const message = `the answer-route reconciles of ${runId} could not be replayed (${(e as Error).message}); they are kept for a retry at a later startup: check the working tree before continuing`;
      diagnose?.(`factory: ${message}`);
      try {
        ledger.append({ v: 1, ts: new Date().toISOString(), runId: input.runId, type: "error", where: "reconcile-replay", message });
      } catch {
        // The note still reaches the person.
      }
      notes.push(`Interrupted factory run ${runId}: ${message}`);
    }
  }
  return notes;
}

/** The prompt section for the next agent run; undefined when there is nothing to tell. */
export function resumeSection(lines: readonly string[]): string | undefined {
  return lines.length === 0 ? undefined : lines.join("\n");
}
