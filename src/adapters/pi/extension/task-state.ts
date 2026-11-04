// Task state and checkpoints in the extension (Phase 2 Task 9). The `task_progress` tool records progress of the
// declared task: on feature/project routes it updates the machine-owned section of the task file
// (`<worktree>/.factory/knowledge/tasks/<taskId>.md`, M §7.1) with `phase`, `base`, `checkpoint`, `worktree` and
// `run`; the small route has no task file (M §6.1). A checkpoint (ruling 10) is a commit in the task worktree
// (feature/project) or an undo ref from `git stash create` that leaves the user's tree untouched (small). Every
// call appends a ledger `progress` event and every checkpoint a `checkpoint` event. Extension code writes the task
// file directly (atomic replace), so the gate's machine-section checks do not apply to it; the ruling-8 post-check
// is told about the write so a concurrent call's repair never undoes it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { summarizeCommand } from "../../../core/policy/redact.ts";
import type { RouteState } from "../../../core/route/types.ts";
import { parseMachine, renderMachine, replaceMachine } from "../../../core/task/machine.ts";
import { atomicWrite, currentRoute, setRoute, type LedgerSink } from "./enforce.ts";
import { canonicalDir, gitRun } from "./facts.ts";
import { checkedBase, ROUTE_ENTRY, ROUTE_IO, verifyRegisteredTool, type RouteIo } from "./route-state.ts";

export const TASK_PROGRESS_TOOL = "task_progress";
/** `git add -A` and `git commit` over a large worktree can take a while; still bounded. */
const GIT_WRITE_TIMEOUT_MS = 120_000;

/** A fresh schema object per registration: its identity is checked by `verifyTools` (review M2). */
export function taskProgressParams() {
  return Type.Object({
    phase: Type.Optional(Type.String({ description: "Current phase of the task, for example plan, implement, verify (one short line)" })),
    item: Type.Optional(Type.String({ description: "The work item just completed or started (one short line)" })),
    checkpoint: Type.Optional(Type.Boolean({ description: "Take a checkpoint: commit the task worktree (feature/project) or create an undo point (small)" })),
    message: Type.Optional(Type.String({ description: "Optional checkpoint description, added to the checkpoint commit or undo point" })),
  });
}

export interface TaskProgressParams {
  phase?: string;
  item?: string;
  checkpoint?: boolean;
  message?: string;
}

/** What `task_progress` needs from the open factory run (index.ts Session). */
export interface TaskSession {
  ledger: LedgerSink;
  runId: string;
  /** Realpathed project root (the git toplevel of the session cwd). */
  projectRoot: string;
  /** The ruling-8 post-check, told about every task-file write (carry-forward Task 9). */
  postChecks?: { recordWrite(file: string, text: string): void };
  io?: RouteIo;
}

export interface TaskStateDeps {
  session(): Promise<TaskSession | undefined>;
  /** Review M2: names this extension registered; `task_progress` is added on registration. */
  factoryTools: Set<string>;
}

export interface TaskStateHandle {
  /** Review M2: drops `task_progress` from `factoryTools` when the effective tool is not this extension's. */
  verifyTools(): void;
}

type TaskPi = Pick<ExtensionAPI, "registerTool" | "appendEntry" | "getAllTools">;

export interface Checkpoint {
  sha: string;
  kind: "commit" | "undo-ref";
  /** A commit was made (feature/project) or the undo point holds uncommitted changes (small). */
  changed: boolean;
}

interface Details {
  taskId: string;
  phase?: string;
  base?: string;
  checkpoint?: Checkpoint;
}

class Refusal extends Error {}

const TASK_FILE_DIRS = [".factory", "knowledge", "tasks"];

export function taskFilePath(worktree: string, taskId: string): string {
  return join(worktree, ...TASK_FILE_DIRS, `${taskId}.md`);
}

function result(text: string, details: Details | undefined, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function gitError(what: string, r: { status: number | null; stderr: string }): Refusal {
  const detail = r.stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 500);
  return new Refusal(`${what} failed${r.status === null ? " (git could not run or timed out)" : ` (exit ${r.status})`}${detail !== "" ? `: ${detail}` : ""}`);
}

/**
 * Git with repository hooks disabled (an empty hooks directory) and without commit signing: a factory checkpoint
 * must not run project-defined code past the command gate (hooks can live in the worktree, e.g. husky) nor wait
 * for a signing prompt.
 */
function withSafeGit<T>(fn: (git: (cwd: string, args: string[]) => ReturnType<typeof gitRun>) => T): T {
  const hooks = mkdtempSync(join(tmpdir(), "factory-no-hooks-"));
  try {
    return fn((cwd, args) => gitRun(cwd, ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", ...args], GIT_WRITE_TIMEOUT_MS));
  } finally {
    rmSync(hooks, { recursive: true, force: true });
  }
}

const head = (git: (cwd: string, args: string[]) => ReturnType<typeof gitRun>, cwd: string): string => {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const sha = r.stdout.trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw gitError("git rev-parse HEAD", r);
  return sha;
};

/** Ruling 10, feature/project: `git add -A` and `git commit` in the task worktree only; HEAD when nothing changed. */
export function commitCheckpoint(worktree: string, subject: string, message: string | undefined): Checkpoint {
  return withSafeGit((git) => {
    const add = git(worktree, ["add", "-A"]);
    if (add.status !== 0) throw gitError("git add -A", add);
    const staged = git(worktree, ["diff", "--cached", "--quiet"]);
    if (staged.status !== 0 && staged.status !== 1) throw gitError("git diff --cached", staged);
    if (staged.status === 0) return { sha: head(git, worktree), kind: "commit", changed: false };
    const body = message !== undefined && message.trim() !== "" ? ["-m", message.trim()] : [];
    const commit = git(worktree, ["commit", "--no-verify", "-q", "-m", subject, ...body]);
    if (commit.status !== 0) throw gitError("git commit", commit);
    return { sha: head(git, worktree), kind: "commit", changed: true };
  });
}

/**
 * Ruling 10, small: `git stash create` (a commit of the tracked changes; the working tree, index and stash list stay
 * as they are) and `git update-ref refs/factory/undo/<taskId>`; HEAD when there is nothing to stash. Untracked
 * files are not part of the undo point (`git stash create` has no `-u`).
 */
export function undoCheckpoint(root: string, taskId: string, subject: string): Checkpoint {
  return withSafeGit((git) => {
    const current = head(git, root);
    // The subject starts with "factory", so git never reads it as an option.
    const stash = git(root, ["stash", "create", subject]);
    if (stash.status !== 0) throw gitError("git stash create", stash);
    const created = stash.stdout.trim();
    if (created !== "" && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(created)) throw new Refusal(`git stash create returned an unexpected value: ${created.slice(0, 80)}`);
    const sha = created === "" ? current : created;
    const ref = git(root, ["update-ref", "-m", subject, `refs/factory/undo/${taskId}`, sha]);
    if (ref.status !== 0) throw gitError("git update-ref", ref);
    return { sha, kind: "undo-ref", changed: created !== "" };
  });
}

function oneLine(name: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === "") throw new Refusal(`${name} must not be empty`);
  if (/[\r\n]/.test(t)) throw new Refusal(`${name} must be one line`);
  return t;
}

function readTaskFile(file: string, rel: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal(`the task file ${rel} does not exist: write it first`);
    throw new Refusal(`the task file ${rel} cannot be read: ${(e as Error).message}`);
  }
}

/** The machine fields after this call (existing fields kept; the route is authoritative for base and worktree). */
function nextFields(existing: Record<string, string>, route: RouteState, phase: string | undefined, runId: string, checkpoint?: string): Record<string, string> {
  const fields: Record<string, string> = { ...existing };
  if (phase !== undefined) fields.phase = phase;
  if (route.base !== undefined) fields.base = route.base;
  else delete fields.base;
  if (checkpoint !== undefined) fields.checkpoint = checkpoint;
  if (route.worktree !== undefined) fields.worktree = route.worktree;
  fields.run = runId;
  return fields;
}

function now(): string {
  return new Date().toISOString();
}

export function registerTaskState(pi: TaskPi, deps: TaskStateDeps): TaskStateHandle {
  const parameters = taskProgressParams();
  pi.registerTool({
    name: TASK_PROGRESS_TOOL,
    label: "Task progress",
    description: [
      "Record progress of the declared task (small, feature or project route with a task id).",
      "feature/project: updates the machine section of .factory/knowledge/tasks/<taskId>.md (write the task file first).",
      "checkpoint: true commits the task worktree (feature/project) or creates an undo point without touching the working tree (small).",
      "Take a checkpoint after each completed work item.",
    ].join(" "),
    promptSnippet: "task_progress: record the task phase and take checkpoints (checkpoint: true) after each completed item",
    parameters,
    // Writes the task file and git state: never concurrently with another call (carry-forward Task 9).
    executionMode: "sequential",
    async execute(_toolCallId, params: TaskProgressParams) {
      const s = await deps.session();
      if (s === undefined) return result("task_progress is unavailable: the factory policy is not active in this session", undefined, true);
      try {
        return run(s, params);
      } catch (e) {
        if (e instanceof Refusal) return result(`task_progress refused: ${e.message}`, undefined, true);
        return result(`task_progress failed: ${(e as Error).message}`, undefined, true);
      }
    },
  });
  deps.factoryTools.add(TASK_PROGRESS_TOOL);

  const run = (s: TaskSession, params: TaskProgressParams) => {
    const io = s.io ?? ROUTE_IO;
    let route = currentRoute();
    const taskId = route.taskId;
    if (route.route === "answer" || taskId === undefined) {
      throw new Refusal(`task_progress needs a small, feature or project route with a task id (current route: ${route.route}${taskId === undefined ? ", no task id" : ""}); declare it with set_route`);
    }
    if (route.needsReclassification) throw new Refusal("a new user message arrived: call set_route to re-declare the route before recording progress");
    const root = route.writeRoots[0];
    if (root === undefined) throw new Refusal(`the ${route.route} route has no write root`);
    const phase = oneLine("phase", params.phase);
    const item = oneLine("item", params.item);
    const tiered = route.route === "feature" || route.route === "project";

    // Feature/project: the task file and its machine section must be usable before anything changes.
    let taskFile: string | undefined;
    let existing: Record<string, string> = {};
    const rel = `.factory/knowledge/tasks/${taskId}.md`;
    if (tiered) {
      if (route.worktree === undefined) throw new Refusal(`the ${route.route} route has no worktree`);
      taskFile = taskFilePath(route.worktree, taskId);
      const parsed = parseMachine(readTaskFile(taskFile, rel));
      if (parsed && "invalid" in parsed) throw new Refusal(`the machine section of ${rel} is invalid (${parsed.reason}); only extension code writes it, restore its markers`);
      if (parsed) existing = parsed.fields;
    }

    // Carry-forward N1: a base that no longer is an ancestor of HEAD is recomputed (and recorded) before use.
    const checked = checkedBase(route, io);
    const notices: string[] = [];
    if (checked.notice !== undefined) {
      try {
        s.ledger.append({ v: 1, ts: now(), runId: s.runId, type: "route", state: { ...checked.state }, reason: "base reset" });
        pi.appendEntry(ROUTE_ENTRY, checked.state);
      } catch (e) {
        throw new Refusal(`the corrected base could not be recorded (${(e as Error).message})`);
      }
      setRoute(checked.state);
      route = checked.state;
      notices.push(checked.notice.replace(/^factory: /, ""));
    }

    try {
      renderMachine(nextFields(existing, route, phase, s.runId, existing.checkpoint));
    } catch (e) {
      throw new Refusal((e as Error).message);
    }
    if (params.checkpoint === true && tiered) {
      // Only the task worktree on its own branch is ever committed to (ruling 10).
      const wt = io.worktreeFacts(route.worktree!, s.projectRoot);
      const expected = `factory/${taskId}`;
      if (!wt.exists || !wt.sameRepo || wt.branch !== expected) {
        throw new Refusal(`the task worktree ${route.worktree} must be a worktree of this repository on branch ${expected} (found ${wt.branch ?? "none"})`);
      }
    }

    // Audited before any effect: progress that cannot be recorded is not made.
    try {
      s.ledger.append({
        v: 1,
        ts: now(),
        runId: s.runId,
        type: "progress",
        taskId,
        ...(phase !== undefined ? { phase: summarizeCommand(phase) } : {}),
        ...(item !== undefined ? { item: summarizeCommand(item) } : {}),
      });
    } catch (e) {
      throw new Refusal(`the progress could not be recorded in the run ledger (${(e as Error).message})`);
    }

    let checkpoint: Checkpoint | undefined;
    let auditError: string | undefined;
    if (params.checkpoint === true) {
      const subject = `factory checkpoint: ${taskId}${(phase ?? existing.phase) !== undefined ? ` ${phase ?? existing.phase}` : ""}`;
      checkpoint = tiered
        ? commitCheckpoint(route.worktree!, subject, params.message)
        : undoCheckpoint(root, taskId, params.message !== undefined && params.message.trim() !== "" ? `${subject} - ${params.message.trim()}` : subject);
      try {
        s.ledger.append({ v: 1, ts: now(), runId: s.runId, type: "checkpoint", taskId, sha: checkpoint.sha, kind: checkpoint.kind });
      } catch (e) {
        auditError = `checkpoint ${checkpoint.sha} was made but could not be recorded in the run ledger (${(e as Error).message})`;
      }
    }

    if (taskFile !== undefined) {
      // Re-read: the checkpoint did not change the file, but nothing else is assumed about it.
      const fresh = readTaskFile(taskFile, rel);
      const fresher = parseMachine(fresh);
      const fields = nextFields(fresher && !("invalid" in fresher) ? fresher.fields : existing, route, phase, s.runId, checkpoint?.sha);
      let text: string;
      try {
        text = replaceMachine(fresh, fields);
      } catch (e) {
        throw new Refusal(`${checkpoint !== undefined ? `checkpoint ${checkpoint.sha} was made, but ` : ""}the machine section of ${rel} could not be updated: ${(e as Error).message}`);
      }
      atomicWrite(taskFile, text, "progress");
      s.postChecks?.recordWrite(canonicalDir(taskFile), text);
    }

    const parts = [`Progress recorded for task ${taskId}${phase !== undefined ? ` (phase ${phase})` : ""}.`];
    if (checkpoint !== undefined) {
      parts.push(
        checkpoint.kind === "commit"
          ? `Checkpoint ${checkpoint.sha}: ${checkpoint.changed ? "committed in" : "no changes since the last commit in"} ${route.worktree}.`
          : `Checkpoint ${checkpoint.sha}: undo point refs/factory/undo/${taskId}${checkpoint.changed ? "" : " (no uncommitted changes; points at HEAD)"}; the working tree is unchanged.`,
      );
    }
    for (const n of notices) parts.push(`Note: ${n}.`);
    if (auditError !== undefined) parts.push(`Error: ${auditError}.`);
    const details: Details = {
      taskId,
      ...(phase !== undefined ? { phase } : {}),
      ...(route.base !== undefined ? { base: route.base } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    };
    return result(parts.join(" "), details, auditError !== undefined);
  };

  return { verifyTools: () => verifyRegisteredTool(pi, TASK_PROGRESS_TOOL, parameters, deps.factoryTools) };
}
