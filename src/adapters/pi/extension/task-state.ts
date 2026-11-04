// Task state and checkpoints in the extension (Phase 2 Task 9). The `task_progress` tool records progress of the
// declared task: on feature/project routes it updates the machine-owned section of the task file
// (`<worktree>/.factory/knowledge/tasks/<taskId>.md`, M §7.1) with `phase`, `base`, `checkpoint`, `worktree` and
// `run`; the small route has no task file (M §6.1). A checkpoint (ruling 10) is a commit in the task worktree
// (feature/project) or an undo ref from `git stash create` that leaves the user's tree untouched (small). Every
// call appends a ledger `progress` event and every checkpoint a `checkpoint` event. Extension code writes the task
// file directly (atomic replace, only inside the worktree's own tasks directory and never through a symlink), so the
// gate's machine-section checks do not apply to it; the ruling-8 post-check is told about the write so a concurrent
// call's repair never undoes it. Checkpoint commits never store secret-path files in git objects (R34).
import { closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSecretPath } from "../../../core/policy/paths.ts";
import { redact, summarizeCommand } from "../../../core/policy/redact.ts";
import type { RouteState } from "../../../core/route/types.ts";
import { parseMachine, renderMachine, replaceMachine } from "../../../core/task/machine.ts";
import { currentRoute, setRoute, type LedgerSink } from "./enforce.ts";
import { canonicalDir, gitRun, hostPlatform, type GitRun } from "./facts.ts";
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
  /** Realpathed home and Pi agent dir: the secret-path classifier's context (R34). */
  home: string;
  piAgentDir: string;
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
  /** R34: changed secret-path files left out of the commit (worktree-relative). */
  excluded: string[];
}

interface Details {
  taskId: string;
  phase?: string;
  base?: string;
  checkpoint?: Checkpoint;
}

class Refusal extends Error {}

const TASK_FILE_DIRS = [".factory", "knowledge", "tasks"];
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

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

export type Git = (cwd: string, args: string[], input?: string, env?: Record<string, string>) => GitRun;

/**
 * Git with repository hooks disabled (an empty hooks directory), no fsmonitor command and no commit signing: a
 * factory checkpoint must not run configured or project-defined code (hooks can live in the worktree, e.g. husky)
 * nor wait for a signing prompt. Filter drivers selected by `.gitattributes` (e.g. git-lfs) still run (README).
 * Inherited git location and pathspec variables are stripped (`gitRun`); `env` adds factory-owned ones.
 */
export function withSafeGit<T>(fn: (git: Git) => T): T {
  const hooks = mkdtempSync(join(tmpdir(), "factory-no-hooks-"));
  try {
    const safe = ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false"];
    return fn((cwd, args, input, env) => gitRun(cwd, [...safe, ...args], GIT_WRITE_TIMEOUT_MS, input, env));
  } finally {
    rmSync(hooks, { recursive: true, force: true });
  }
}

const head = (git: Git, cwd: string): string => {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const sha = r.stdout.trim();
  if (r.status !== 0 || !COMMIT_ID.test(sha)) throw gitError("git rev-parse HEAD", r);
  return sha;
};

/** True for a worktree-relative path the gate treats as a secret (R34: never stored in git objects). */
export type SecretTest = (relative: string) => boolean;

/** Pathspecs read NUL-separated from stdin. */
const PATHSPECS = ["--pathspec-from-file=-", "--pathspec-file-nul"];
const nulList = (specs: readonly string[]) => `${specs.join("\0")}\0`;

/**
 * Ruling 10 as amended by R34, feature/project: stage every changed path of the task worktree except secret paths
 * (enumerated with `git status`, so no secret blob is ever written), unstage secret paths someone else staged,
 * and commit; HEAD when nothing remains. A failed commit resets the index to HEAD (the working tree is unchanged).
 *
 * R2-1: a kept path can be a directory prefix of an excluded one (a tracked file or symlink `x` replaced by a
 * directory holding `x/.env`): `add` matches pathspecs against directories too, so every excluded path is also
 * passed as `:(exclude,literal)`. Backstop: the staged paths are checked again before the commit; a secret among
 * them resets the index and refuses the checkpoint.
 */
export function commitCheckpoint(worktree: string, subject: string, message: string | undefined, isSecret: SecretTest): Checkpoint {
  return withSafeGit((git) => {
    const status = git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
    if (status.status !== 0) throw gitError("git status", status);
    const keep: string[] = [];
    const excluded: string[] = [];
    const stagedSecrets: string[] = [];
    for (const entry of status.stdout.split("\0")) {
      if (entry.length < 4) continue;
      const p = entry.slice(3);
      if (!isSecret(p)) {
        keep.push(p);
        continue;
      }
      excluded.push(p);
      if (entry[0] !== " " && entry[0] !== "?") stagedSecrets.push(p);
    }
    if (stagedSecrets.length > 0) {
      const reset = git(worktree, ["reset", "-q", ...PATHSPECS], nulList(stagedSecrets.map((p) => `:(literal)${p}`)));
      if (reset.status !== 0) throw gitError("git reset of staged secret files", reset);
    }
    if (keep.length > 0) {
      const specs = [...keep.map((p) => `:(literal)${p}`), ...excluded.map((p) => `:(exclude,literal)${p}`)];
      const add = git(worktree, ["add", "-A", ...PATHSPECS], nulList(specs));
      if (add.status !== 0) throw gitError("git add", add);
    }
    const listed = git(worktree, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
    if (listed.status !== 0) throw gitError("git diff --cached", listed);
    const stagedPaths = listed.stdout.split("\0").filter((p) => p !== "");
    const leaked = stagedPaths.filter((p) => isSecret(p));
    if (leaked.length > 0) {
      const reset = git(worktree, ["reset", "-q"]);
      throw new Refusal(
        `secret paths were staged for the checkpoint and nothing was committed (R34): ${leaked.join(", ")}; ${reset.status === 0 ? "the index was reset to HEAD" : "resetting the index also failed: check `git status` in the worktree"}`,
      );
    }
    if (stagedPaths.length === 0) return { sha: head(git, worktree), kind: "commit", changed: false, excluded };
    const body = message !== undefined && message.trim() !== "" ? ["-m", message.trim()] : [];
    const commit = git(worktree, ["commit", "--no-verify", "-q", "-m", subject, ...body]);
    if (commit.status !== 0) {
      const err = gitError("git commit", commit);
      const reset = git(worktree, ["reset", "-q"]);
      err.message += reset.status === 0 ? "; the index was reset to HEAD (the working tree is unchanged)" : "; resetting the index also failed: check `git status` in the worktree";
      throw err;
    }
    return { sha: head(git, worktree), kind: "commit", changed: true, excluded };
  });
}

/**
 * Ruling 10, small: `git stash create` (a commit of the tracked changes; the working tree, index and stash list stay
 * as they are) and `git update-ref --create-reflog refs/factory/undo/<taskId>` (earlier undo points stay reachable
 * through its reflog); HEAD when there is nothing to stash. Untracked files are not part of the undo point
 * (`git stash create` has no `-u`).
 */
export function undoCheckpoint(root: string, taskId: string, subject: string): Checkpoint {
  return withSafeGit((git) => {
    const current = head(git, root);
    // The subject starts with "factory", so git never reads it as an option.
    const stash = git(root, ["stash", "create", subject]);
    if (stash.status !== 0) throw gitError("git stash create", stash);
    const created = stash.stdout.trim();
    if (created !== "" && !COMMIT_ID.test(created)) throw new Refusal(`git stash create returned an unexpected value: ${created.slice(0, 80)}`);
    const sha = created === "" ? current : created;
    const ref = git(root, ["update-ref", "--create-reflog", "-m", subject, `refs/factory/undo/${taskId}`, sha]);
    if (ref.status !== 0) throw gitError("git update-ref", ref);
    return { sha, kind: "undo-ref", changed: created !== "", excluded: [] };
  });
}

/** Review M4: model text that would carry a secret into git objects or the machine section is rejected, not echoed. */
function noSecret(name: string, v: string): void {
  if (redact(v) !== v) throw new Refusal(`${name} looks like it contains a secret (token, key or password); remove it`);
}

function oneLine(name: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === "") throw new Refusal(`${name} must not be empty`);
  if (/[\r\n]/.test(t)) throw new Refusal(`${name} must be one line`);
  return t;
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

interface TaskFile {
  /** The verified real directory `<canonical worktree>/.factory/knowledge/tasks`. */
  dir: string;
  file: string;
  rel: string;
}

/**
 * Review I1: the task file is used only when its directory, resolved, is the worktree's own
 * `.factory/knowledge/tasks` (no symlinked component leads elsewhere) and the file itself is a regular file
 * (not a symlink): extension code never reads or writes through a link out of the write root.
 */
function verifiedTaskFile(worktree: string, taskId: string): TaskFile {
  const rel = `.factory/knowledge/tasks/${taskId}.md`;
  const expected = join(canonicalDir(worktree), ...TASK_FILE_DIRS);
  const lexical = join(worktree, ...TASK_FILE_DIRS);
  let dirStat: Stats;
  try {
    dirStat = statSync(lexical);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal(`the task file ${rel} does not exist: write it first`);
    throw new Refusal(`the task directory of ${rel} cannot be read: ${(e as Error).message}`);
  }
  const real = canonicalDir(lexical);
  if (fold(real) !== fold(expected)) {
    throw new Refusal(`the task directory .factory/knowledge/tasks is reached through a symbolic link (it resolves to ${real}, outside the worktree's own .factory/knowledge/tasks); remove the link`);
  }
  if (!dirStat.isDirectory()) throw new Refusal(`.factory/knowledge/tasks in the worktree is not a directory`);
  const file = join(real, `${taskId}.md`);
  let st: Stats;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal(`the task file ${rel} does not exist: write it first`);
    throw new Refusal(`the task file ${rel} cannot be read: ${(e as Error).message}`);
  }
  if (!st.isFile()) throw new Refusal(`the task file ${rel} must be a regular file (found a symbolic link or another file type)`);
  // R2-2: another hard link to the same file may live outside the worktree (its content would be copied in and committed).
  if (st.nlink > 1) throw new Refusal(`the task file ${rel} has ${st.nlink} hard links; it must be a file of its own (remove the other links)`);
  return { dir: real, file, rel };
}

function sameTaskFile(a: TaskFile, worktree: string, taskId: string): void {
  const b = verifiedTaskFile(worktree, taskId);
  if (fold(a.file) !== fold(b.file)) throw new Refusal(`the task file ${a.rel} moved while it was being updated`);
}

function readTaskFile(tf: TaskFile): string {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW where the platform has it: a link swapped in after the check is not followed.
    fd = openSync(tf.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return readFileSync(fd, "utf8");
  } catch (e) {
    throw new Refusal(`the task file ${tf.rel} cannot be read: ${(e as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Atomic replace inside the verified directory, re-verified right before the rename; the temp file never stays. */
function writeTaskFile(tf: TaskFile, text: string, worktree: string, taskId: string): void {
  const mode = lstatSync(tf.file).mode & 0o7777;
  const tmp = join(tf.dir, `.${taskId}.md.factory-progress-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode });
    sameTaskFile(tf, worktree, taskId);
    renameSync(tmp, tf.file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Not created, or already renamed.
    }
    throw e;
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
      // Review M5: a base reset recorded before a later refusal is still reported.
      const notices: string[] = [];
      const withNotices = (text: string) => [text, ...notices.map((n) => `Note: ${n}.`)].join(" ");
      try {
        return run(s, params, notices);
      } catch (e) {
        if (e instanceof Refusal) return result(withNotices(`task_progress refused: ${e.message}`), undefined, true);
        return result(withNotices(`task_progress failed: ${(e as Error).message}`), undefined, true);
      }
    },
  });
  deps.factoryTools.add(TASK_PROGRESS_TOOL);

  const run = (s: TaskSession, params: TaskProgressParams, notices: string[]) => {
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
    const message = params.message !== undefined && params.message.trim() !== "" ? params.message.trim() : undefined;
    if (phase !== undefined) noSecret("phase", phase);
    if (message !== undefined) noSecret("message", message);
    const tiered = route.route === "feature" || route.route === "project";

    // Feature/project: the task file and its machine section must be usable before anything changes.
    let taskFile: TaskFile | undefined;
    let existing: Record<string, string> = {};
    if (tiered) {
      if (route.worktree === undefined) throw new Refusal(`the ${route.route} route has no worktree`);
      taskFile = verifiedTaskFile(route.worktree, taskId);
      const parsed = parseMachine(readTaskFile(taskFile));
      if (parsed && "invalid" in parsed) throw new Refusal(`the machine section of ${taskFile.rel} is invalid (${parsed.reason}); only extension code writes it, restore its markers`);
      if (parsed) existing = parsed.fields;
    }

    // Carry-forward N1: a base that no longer is an ancestor of HEAD is recomputed (and recorded) before use.
    const checked = checkedBase(route, io);
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
      const worktree = route.worktree!;
      const secretCtx = { home: s.home, piAgentDir: s.piAgentDir, platform: hostPlatform() };
      checkpoint = tiered
        ? commitCheckpoint(worktree, subject, message, (p) => isSecretPath(join(worktree, p), secretCtx))
        : undoCheckpoint(root, taskId, message !== undefined ? `${subject} - ${message}` : subject);
      try {
        s.ledger.append({
          v: 1,
          ts: now(),
          runId: s.runId,
          type: "checkpoint",
          taskId,
          sha: checkpoint.sha,
          kind: checkpoint.kind,
          ...(checkpoint.excluded.length > 0 ? { excluded: checkpoint.excluded.map(redact) } : {}),
        });
      } catch (e) {
        auditError = `checkpoint ${checkpoint.sha} was made but could not be recorded in the run ledger (${(e as Error).message})`;
      }
    }

    if (taskFile !== undefined) {
      // Review M2: after a checkpoint, any failure names the checkpoint and a pending audit error.
      try {
        // Re-verified and re-read: the checkpoint did not change the file, but nothing else is assumed about it.
        sameTaskFile(taskFile, route.worktree!, taskId);
        const fresh = readTaskFile(taskFile);
        const fresher = parseMachine(fresh);
        const fields = nextFields(fresher && !("invalid" in fresher) ? fresher.fields : existing, route, phase, s.runId, checkpoint?.sha);
        const text = replaceMachine(fresh, fields);
        writeTaskFile(taskFile, text, route.worktree!, taskId);
        s.postChecks?.recordWrite(taskFile.file, text);
      } catch (e) {
        if (checkpoint === undefined) throw e;
        const made = `checkpoint ${checkpoint.sha} (${checkpoint.kind}) was made`;
        throw new Error(`${made}${auditError !== undefined ? `; ${auditError}` : ""}; but the machine section of ${taskFile.rel} could not be updated: ${(e as Error).message}`);
      }
    }

    const parts = [`Progress recorded for task ${taskId}${phase !== undefined ? ` (phase ${phase})` : ""}.`];
    if (checkpoint !== undefined) {
      parts.push(
        checkpoint.kind === "commit"
          ? `Checkpoint ${checkpoint.sha}: ${checkpoint.changed ? "committed in" : "no changes to commit in"} ${route.worktree}.`
          : `Checkpoint ${checkpoint.sha}: undo point refs/factory/undo/${taskId}${checkpoint.changed ? "" : " (no uncommitted changes; points at HEAD)"}; the working tree is unchanged.`,
      );
      if (checkpoint.excluded.length > 0) {
        parts.push(`Left out of the checkpoint because they are secret paths (R34; they stay in the working tree, uncommitted): ${checkpoint.excluded.join(", ")}.`);
      }
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
