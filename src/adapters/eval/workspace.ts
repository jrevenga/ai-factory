// Controller-owned repositories for one eval run (plan ruling 3).
//
//   <runDir>/base    pristine one-commit repository the controller owns and never mounts
//   <runDir>/ws      a copy of base the agent works in; the agent controls everything in it, including .git
//   <runDir>/verify  a controller clone of base whose worktree is replaced by ws's files (never its .git)
//
// Nothing here runs git inside ws. Files are copied with lstat-based recursion: directories are recreated,
// regular files copied, symlinks recreated from their readlink text (never followed), anything else skipped.
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { controllerGit } from "./git-isolated.ts";
import { ensurePrivateDir } from "./paths.ts";
import { sandboxArgs, type SandboxSpec } from "./sandbox.ts";
import type { LoadedTask } from "./tasks.ts";
import { ProcessTeardownFailed, runBounded, type RunResult } from "../platform/process.ts";

const COMMIT_DATE = "2026-01-01T00:00:00Z";
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "factory-eval",
  GIT_AUTHOR_EMAIL: "eval@factory.invalid",
  GIT_AUTHOR_DATE: COMMIT_DATE,
  GIT_COMMITTER_NAME: "factory-eval",
  GIT_COMMITTER_EMAIL: "eval@factory.invalid",
  GIT_COMMITTER_DATE: COMMIT_DATE,
};

/** Controller scratch (empty gitconfig, empty hooks dir, HOME): a sibling of the run's directories, never mounted. */
export function scratchFor(dirInsideRun: string): string {
  return join(dirname(dirInsideRun), ".ctl-git");
}

async function must(what: string, run: Promise<RunResult>): Promise<RunResult> {
  const r = await run;
  if (r.code !== 0) throw new Error(`${what} failed (${r.timedOut ? "timed out" : `exit ${r.code}`}): ${r.stderr.trim() || r.stdout.trim() || "no output"}`);
  return r;
}

export interface CopyStats {
  skippedSymlinks: number;
  skippedSpecial: number;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Makes `path` a real directory: a symlink or file in the way is removed first, an existing directory is kept. */
async function ensureRealDir(path: string): Promise<void> {
  const st = await lstatOrNull(path);
  if (st?.isDirectory()) return;
  if (st) await rm(path, { recursive: true, force: true });
  await mkdir(path);
}

/** Frees `path` for a new non-directory node, so nothing is ever written through an existing symlink. */
async function clearForNode(path: string): Promise<void> {
  if (await lstatOrNull(path)) await rm(path, { recursive: true, force: true });
}

const isGitName = (name: string) => name.toLowerCase() === ".git";

/** Copies the children of `src` into the existing real directory `dest`. */
async function copyTree(src: string, dest: string, opts: { skipGit: boolean }, stats: CopyStats): Promise<void> {
  for (const name of await readdir(src)) {
    if (opts.skipGit && isGitName(name)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    const st = await lstat(from);
    if (st.isSymbolicLink()) {
      await clearForNode(to);
      try {
        await symlink(await readlink(from), to);
      } catch (e) {
        if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") stats.skippedSymlinks++;
        else throw e;
      }
    } else if (st.isDirectory()) {
      await ensureRealDir(to);
      await copyTree(from, to, opts, stats);
    } else if (st.isFile()) {
      await clearForNode(to);
      await copyFile(from, to);
    } else {
      stats.skippedSpecial++;
    }
  }
}

export interface Materialized {
  base: string;
  ws: string;
  baseSha: string;
}

/** Builds `<runDir>/base` (one deterministic commit, no history) and `<runDir>/ws` (a full copy of it, `.git` included). */
export async function materialize(t: LoadedTask, runDir: string): Promise<Materialized> {
  const base = join(runDir, "base");
  const ws = join(runDir, "ws");
  const scratch = scratchFor(base);
  await ensurePrivateDir(runDir);
  if ((await lstatOrNull(base)) || (await lstatOrNull(ws))) throw new Error(`run directory already materialized: ${runDir}`);
  await ensurePrivateDir(scratch);
  const git = (args: string[], cwd: string, env?: Record<string, string>) => controllerGit(args, { cwd, scratch, env });
  await ensurePrivateDir(base);

  const snap = t.task.snapshot;
  if (snap.kind === "dir") {
    await copyTree(join(t.dir, "repo"), base, { skipGit: true }, { skippedSymlinks: 0, skippedSpecial: 0 });
  } else {
    const bare = join(scratch, "source.git");
    await rm(bare, { recursive: true, force: true });
    try {
      await must(`git clone ${snap.url}`, git(["clone", "--bare", "-q", "--", snap.url, bare], scratch));
      await must(`git checkout ${snap.ref}`, git(["--git-dir", bare, "--work-tree", base, "checkout", "-f", snap.ref, "--", "."], base));
    } finally {
      await rm(bare, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  await must("git init", git(["init", "-q", "-b", "main"], base));
  for (const [k, v] of [
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
  ] as const) {
    await must(`git config ${k}`, git(["config", "--local", k, v], base));
  }
  await must("git add", git(["add", "-A", "-f"], base));
  await must("git commit", git(["commit", "-q", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "factory eval snapshot"], base, COMMIT_ENV));
  const baseSha = (await must("git rev-parse", git(["rev-parse", "HEAD"], base))).stdout.trim();

  await ensurePrivateDir(ws);
  await copyTree(base, ws, { skipGit: false }, { skippedSymlinks: 0, skippedSpecial: 0 });
  return { base, ws, baseSha };
}

/**
 * `verifyDir` = controller clone of `base`, its worktree replaced by the files of `ws` without the top-level
 * `.git` (a nested `.git` is skipped too: an embedded repository has no place in a verification tree).
 * Returns what could not be copied (Windows symlinks without privilege; special files).
 */
export async function buildVerifyTree(base: string, ws: string, verifyDir: string): Promise<CopyStats> {
  const scratch = scratchFor(verifyDir);
  await ensurePrivateDir(scratch);
  await rm(verifyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await must("git clone", controllerGit(["clone", "--no-hardlinks", "-q", "--", base, verifyDir], { cwd: scratch, scratch }));
  if (process.platform !== "win32") await chmod(verifyDir, 0o700);
  for (const name of await readdir(verifyDir)) {
    if (name !== ".git") await rm(join(verifyDir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const stats: CopyStats = { skippedSymlinks: 0, skippedSpecial: 0 };
  await copyTree(ws, verifyDir, { skipGit: true }, stats);
  return stats;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * What the agent changed against `baseSha`, `.eval/` excluded. A binary file counts as one file, no lines.
 * Contract: measure the agent's changes, so call it BEFORE `overlayChecks`; after the overlay the withheld
 * check files would be counted too (the orchestrator pins this order).
 */
export async function diffStat(verifyDir: string, baseSha: string): Promise<DiffStat> {
  const scratch = scratchFor(verifyDir);
  const git = (args: string[]) => controllerGit(args, { cwd: verifyDir, scratch });
  await must("git add", git(["add", "-A", "--", ".", ":(exclude).eval"]));
  const out = await must("git diff", git(["diff", "--cached", "--numstat", "--no-renames", baseSha, "--", ".", ":(exclude).eval"]));
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
  for (const line of out.stdout.split(/\r?\n/)) {
    if (line === "") continue;
    const [ins, del] = line.split("\t");
    stat.files++;
    if (ins !== "-" && del !== "-") {
      stat.insertions += Number(ins);
      stat.deletions += Number(del);
    }
  }
  return stat;
}

/** Copies the withheld `checks/` into the verify tree (replacing, never writing through, whatever the agent left there) and writes `.eval/final-message.txt`. */
export async function overlayChecks(t: LoadedTask, verifyDir: string, finalMessage: string): Promise<void> {
  const checks = join(t.dir, "checks");
  if ((await lstatOrNull(checks))?.isDirectory()) {
    await copyTree(checks, verifyDir, { skipGit: true }, { skippedSymlinks: 0, skippedSpecial: 0 });
  }
  const evalDir = join(verifyDir, ".eval");
  await ensureRealDir(evalDir);
  const target = join(evalDir, "final-message.txt");
  await clearForNode(target);
  await writeFile(target, finalMessage, { flag: "wx" });
}

export interface CheckResult {
  name: string;
  pass: boolean;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
}

function checkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: tmpdir(), LANG: process.env.LANG ?? "C" };
  if (process.platform === "win32") {
    for (const k of ["SystemRoot", "ComSpec", "TEMP", "TMP", "PATHEXT"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

const covers = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Runs each check's argv (no shell) in `verifyDir`, one at a time. With a sandbox spec the command runs
 * under `bwrap` with the network off and its cwd pinned to `verifyDir` (bound read-write if the spec does
 * not already cover it, whatever cwd the spec carries); with `null` it runs directly (tests, hosts without
 * bubblewrap). The checks see a minimal environment, never the controller's.
 * Returns only canonical `CheckResult` objects: a check that cannot start is `exitCode: null, pass: false`
 * and the reason goes to `onDiagnostic` (the caller redacts it before it is persisted).
 */
export async function runChecks(
  t: LoadedTask,
  verifyDir: string,
  sandbox: SandboxSpec | null,
  onDiagnostic?: (checkName: string, message: string) => void,
): Promise<CheckResult[]> {
  const pinned: SandboxSpec | null =
    sandbox === null
      ? null
      : (() => {
          const dir = resolve(verifyDir);
          const rw = sandbox.rwBinds.map((p) => resolve(p));
          return { ...sandbox, network: false, cwd: dir, rwBinds: rw.some((p) => covers(p, dir)) ? sandbox.rwBinds : [...sandbox.rwBinds, dir] };
        })();
  const results: CheckResult[] = [];
  for (const check of t.task.checks) {
    const [cmd, ...args] = check.argv as [string, ...string[]];
    const started = Date.now();
    try {
      const r =
        pinned === null
          ? await runBounded(cmd, args, { cwd: verifyDir, env: checkEnv(), timeoutMs: check.timeoutSec * 1000 })
          : await runBounded("bwrap", sandboxArgs(pinned, cmd, args), { cwd: verifyDir, env: checkEnv(), timeoutMs: check.timeoutSec * 1000 });
      results.push({ name: check.name, pass: r.code === 0 && !r.timedOut, exitCode: r.code, timedOut: r.timedOut, ms: Date.now() - started });
    } catch (e) {
      if (e instanceof ProcessTeardownFailed) throw e;
      results.push({ name: check.name, pass: false, exitCode: null, timedOut: false, ms: Date.now() - started });
      onDiagnostic?.(check.name, e instanceof Error ? e.message : String(e));
    }
  }
  return results;
}
