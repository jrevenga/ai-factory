// Startup recovery (Phase 2 Task 13, acceptance 2). Before the new run's `run_start` is written, the project's run
// ledger is reconciled: runs that ended without `run_end` while their process is gone are marked `run_interrupted`
// (claimed once per project, ledger.ts) and this Pi session's own interrupted earlier run is found independently of
// that claim (review M5), so a continued session restores its route flagged (ruling 20). The new run records the runs
// it resumed (`run_start.resumedFrom`); answer-route reconciliations interrupted runs left unfinished are finished
// (reconcile.ts `replayInterrupted`); and the next agent run gets one prompt section naming each interrupted task's
// phase and last checkpoint.
//
// Fix round 1: replay completion is tracked by the manifests themselves (a manifest stays retryable until it is `done`),
// not by the interruption marker. R61: every startup gathers the unfinished reconciles of every run whose process is
// gone, per work tree, and replays a work tree's tail only while it owns that work tree's replay (ruling R52,
// replay-owners.ts: create-then-list unique entries in `replayOwnersDir`), so two live sessions never replay the same
// work tree at once.
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunEvent } from "../../../core/ledger/events.ts";
import { ledgerDirFor, reconcile, runOwnerGone, sessionInterruptedRuns, type InterruptedRun } from "./ledger.ts";
import { deferReplay, hasUnfinishedReconciles, mergeReplayOrder, replayItems, surveyReplay, unfinishedRoots, type Diagnose, type ReplayItem } from "./reconcile.ts";
import { claimReplay, replayOwnersDir } from "./replay-owners.ts";
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

/** A run id as `runIdFor` makes it (`<yyyymmddThhmmssZ>-<pid>`); other entries of the ledger dir are not runs. */
const RUN_ID = /^\d{8}T\d{6}Z-\d+$/;

/**
 * After `run_start`: finishes the answer-route reconciliations that earlier runs of the project left unfinished,
 * audited in this run's ledger. A run qualifies when its `reconcile/` holds unfinished work (reconcile.ts
 * `hasUnfinishedReconciles`) and its owning process is gone (`ledger.runOwnerGone`, R62: whether or not it wrote
 * `run_end`, so a reconcile that failed in-process is retried).
 *
 * R61: coordination and order are per work tree, not per run. The unfinished manifests of every qualifying run that
 * target the same work tree form one tail, latest snapshot first (`mergeReplayOrder`), so the earliest snapshot (the
 * original state) is restored last. The tail is replayed only while this session owns the work tree's replay (R52,
 * `claimReplay` on `replayOwnersDir`), and stops at the first manifest that does not finish (R50.2); the rest is kept
 * for a later startup, in the same order. A work tree is left alone (a note says why; retried at a later startup)
 * while another live session owns or contends for its replay, while a run whose process is alive has unfinished
 * reconciles in it, and while any qualifying run holds work without a readable manifest (its work tree is unknown).
 * A failure is reported (note, `diagnose`, ledger `error`) and left for a retry. Returns one note per replayed, kept or
 * failed item, prefixed with the id of the run it belongs to.
 */
export function replayInterruptedRuns(input: ReplayInput, ledger: Sink, diagnose?: Diagnose): string[] {
  const dir = ledgerDirFor(input.factoryHome, input.projectId);
  let runIds: string[];
  try {
    runIds = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== input.runId && RUN_ID.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const notes: string[] = [];
  const note = (runDir: string, text: string) => notes.push(`Interrupted factory run ${basename(runDir)}: ${text}`);
  const failure = (runIds: readonly string[], what: string, e: unknown) => {
    const message = `the answer-route reconciles of ${what} could not be replayed (${(e as Error).message}); they are kept for a retry at a later startup: check the working tree before continuing`;
    diagnose?.(`factory: ${message}`);
    try {
      ledger.append({ v: 1, ts: new Date().toISOString(), runId: input.runId, type: "error", where: "reconcile-replay", message });
    } catch {
      // The note still reaches the person.
    }
    for (const id of runIds) notes.push(`Interrupted factory run ${id}: ${message}`);
  };

  // Survey every qualifying run; remember the work trees that runs of live processes still have unfinished work in.
  const tails = new Map<string, ReplayItem[][]>();
  const blocked: string[] = [];
  const busy = new Map<string, string>();
  for (const runId of runIds) {
    const runDir = join(dir, runId);
    try {
      if (!hasUnfinishedReconciles(runDir)) continue;
      if (!runOwnerGone(dir, runId, input.isAlive)) {
        for (const root of unfinishedRoots(runDir)) if (!busy.has(root)) busy.set(root, runId);
        continue;
      }
      const survey = surveyReplay(runDir, ledger, input.runId, diagnose);
      for (const o of survey.outcomes) for (const n of o.notes) note(runDir, n);
      blocked.push(...survey.blocked);
      const byRoot = new Map<string, ReplayItem[]>();
      for (const item of survey.pending) byRoot.set(item.snapshot.root, [...(byRoot.get(item.snapshot.root) ?? []), item]);
      for (const [root, items] of byRoot) tails.set(root, [...(tails.get(root) ?? []), items]);
    } catch (e) {
      failure([runId], runId, e);
    }
  }

  for (const root of [...tails.keys()].sort()) {
    const items = mergeReplayOrder(tails.get(root)!);
    const runsOf = [...new Set(items.map((i) => basename(i.runDir)))];
    const keep = (why: string) => {
      for (const d of deferReplay(items, `the work tree ${root}`, why, diagnose)) for (const n of d.outcome.notes) note(d.runDir, n);
    };
    if (blocked.length > 0) {
      keep(`the reconcile work in ${blocked.join(", ")} has no readable manifest, so its work tree and its place in the replay order are unknown`);
      continue;
    }
    const live = busy.get(root);
    if (live !== undefined) {
      keep(`run ${live}, whose process is still running, has unfinished answer-route reconciles in the same work tree ${root}`);
      continue;
    }
    try {
      const claim = claimReplay(replayOwnersDir(dir, root), input.runId, input.isAlive);
      if (claim === undefined) {
        for (const id of runsOf) {
          notes.push(
            `Interrupted factory run ${id}: replay in progress elsewhere; another live session is replaying (or contending for) the answer-route reconciles of its work tree ${root}, so they are left to it and retried at a later startup`,
          );
        }
        continue;
      }
      try {
        const lost = "this session no longer owns the work tree's replay (its replay.owners entry is gone)";
        for (const d of replayItems(items, ledger, input.runId, diagnose, { owns: claim.owns, scope: `the work tree ${root}`, lostOwnership: lost })) {
          for (const n of d.outcome.notes) note(d.runDir, n);
        }
      } finally {
        claim.release();
      }
    } catch (e) {
      failure(runsOf, `the work tree ${root}`, e);
    }
  }
  return notes;
}

/** The prompt section for the next agent run; undefined when there is nothing to tell. */
export function resumeSection(lines: readonly string[]): string | undefined {
  return lines.length === 0 ? undefined : lines.join("\n");
}
