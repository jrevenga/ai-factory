// Steps shared by `factory update` and `factory rollback`: the factory lock with the live-session check,
// reading a release from a shallow clone of its tag, and handing over to that release's CLI
// (`npm install -g --legacy-peer-deps <spec>`, then its `_apply-release`, which borrows our lock; R5).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { npm } from "../../adapters/platform/npm.ts";
import type { FactoryPaths } from "../../adapters/platform/paths.ts";
import { acquireLock, Locked, type Lock } from "../../adapters/store/lock.ts";
import { liveSessions } from "../../adapters/store/sessions.ts";
import type { StateDocProblem } from "../../adapters/store/state-store.ts";
import { cloneTag, lsRemoteTags } from "../../adapters/vcs/git.ts";
import { npmInstallSpec, ReleaseManifest, tagFor } from "../../core/release/manifest.ts";
import type { CliIO } from "../io.ts";
import { locateGlobalCli, runNodeInherited } from "./install.ts";

/** Seams for tests; production uses the real implementations. */
export interface ReleaseDeps {
  lsRemoteTags: typeof lsRemoteTags;
  cloneTag: typeof cloneTag;
  npm: typeof npm;
  /** Runs `node <args>` with the terminal's output and resolves to its exit code. */
  runNode: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  liveSessions: typeof liveSessions;
  acquireLock: typeof acquireLock;
  /** Version of the running Node.js. */
  nodeVersion: string;
}

export interface ReleaseContext {
  paths: FactoryPaths;
  env: NodeJS.ProcessEnv;
  /** This CLI's own release.json. */
  manifest: ReleaseManifest;
  io: CliIO;
  now(): Date;
  deps?: Partial<ReleaseDeps>;
}

export function releaseDeps(ctx: ReleaseContext): ReleaseDeps {
  return { lsRemoteTags, cloneTag, npm, runNode: runNodeInherited, liveSessions, acquireLock, nodeVersion: process.versions.node, ...ctx.deps };
}

const NPM_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `v1.2.3` or `1.2.3` → `1.2.3`; anything else → undefined. */
export function parseVersion(input: string): string | undefined {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(input.trim());
  return m?.[1];
}

/** The refusal printed when the preflight finds invalid state documents; `retry` is the command to rerun. */
export function invalidDocsMessage(problems: StateDocProblem[], retry: string): string {
  return [
    "These factory documents are invalid, so no transaction was started. Nothing was changed.",
    ...problems.map(
      (p) => `  ${p.path}: ${p.detail}\n     fix: Fix or remove ${p.path} (a removed file is recreated by "factory install"), then run "${retry}" again.`,
    ),
  ].join("\n");
}

export interface HeldLock {
  lock: Lock;
  /** Throws if proper-lockfile reported the lock compromised (R5); call before every mutation. */
  live(): void;
}

/**
 * Runs `body` holding the factory lock, after checking (under the lock, so none can register meanwhile)
 * that no factory-launched Pi session is running. The lock is released in every case; a release failure
 * (e.g. the lock was compromised while a borrowing child ran, which the child cannot see) makes the
 * result non-zero, because another process may have held the lock meanwhile.
 */
export async function withTxnLock(ctx: ReleaseContext, deps: ReleaseDeps, body: (held: HeldLock) => Promise<number>): Promise<number> {
  const { io, paths } = ctx;
  let lock: Lock;
  try {
    lock = await deps.acquireLock(paths);
  } catch (e) {
    io.err(e instanceof Locked ? e.message : `Could not take the factory lock ${paths.lock}: ${msg(e)}`);
    return 1;
  }
  const held: HeldLock = {
    lock,
    live() {
      if (lock.compromised) throw lock.compromised;
    },
  };
  let code: number;
  let releaseFailed = false;
  try {
    let sessions: number[];
    try {
      sessions = await deps.liveSessions(paths);
    } catch (e) {
      io.err(`Could not check for running factory sessions in ${paths.sessions}: ${msg(e)}. Nothing was changed.`);
      return 1;
    }
    code = sessions.length > 0 ? sessionsOpen(io, sessions) : await body(held);
  } finally {
    try {
      await lock.release();
    } catch (e) {
      io.err(`The factory lock ${paths.lock} could not be released cleanly: ${msg(e)}. Another factory process may have run meanwhile; run "factory doctor".`);
      releaseFailed = true;
    }
  }
  return releaseFailed && code === 0 ? 1 : code;
}

function sessionsOpen(io: CliIO, pids: number[]): number {
  io.err(`Close factory sessions first: pids ${pids.join(", ")}. Exit every factory-launched Pi session, then retry.`);
  return 1;
}

export interface FetchedRelease {
  manifest: ReleaseManifest;
  changelog: string | undefined;
}

/** Shallow-clones `v<version>` of the effective source into a temp dir and reads its release.json and CHANGELOG.md. */
export async function fetchRelease(ctx: ReleaseContext, deps: ReleaseDeps, source: string, version: string): Promise<FetchedRelease> {
  const dir = await mkdtemp(join(tmpdir(), "factory-release-"));
  try {
    const checkout = join(dir, "checkout");
    await deps.cloneTag(source, tagFor(version), checkout, { env: ctx.env, timeoutMs: GIT_TIMEOUT_MS });
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(checkout, "release.json"), "utf8"));
    } catch (e) {
      throw new Error(`Release ${tagFor(version)} has no readable release.json: ${msg(e)}`, { cause: e });
    }
    const parsed = ReleaseManifest.safeParse(raw);
    if (!parsed.success) throw new Error(`Release ${tagFor(version)} has an invalid release.json: ${parsed.error.message}`);
    if (parsed.data.factory !== version) {
      throw new Error(`Tag ${tagFor(version)} holds release.json for factory ${parsed.data.factory}; refusing a mislabelled release.`);
    }
    let changelog: string | undefined;
    try {
      changelog = await readFile(join(checkout, "CHANGELOG.md"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return { manifest: parsed.data, changelog };
  } finally {
    // Retries cover transient Windows locks (EBUSY/EPERM from scanners); a leftover temp dir never
    // turns a fetched release into a failure.
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      ctx.io.err(`warning: could not remove the temporary checkout ${dir}: ${msg(e)}. You can delete it.`);
    }
  }
}

/**
 * The CLI at npm's global root must be the release just installed (its own release.json), or another
 * install raced ours or npm kept a stale copy; handing over to it would apply the wrong release.
 */
async function expectInstalledVersion(globalCli: string, version: string): Promise<void> {
  const file = join(dirname(dirname(globalCli)), "release.json");
  let found: unknown;
  try {
    found = (JSON.parse(await readFile(file, "utf8")) as { factory?: unknown }).factory;
  } catch (e) {
    throw new Error(`npm reported success but ${file} is unreadable (${msg(e)}); not handing over to it.`, { cause: e });
  }
  if (found !== version) {
    throw new Error(`npm reported success but the global factory CLI (${file}) holds factory ${String(found)}, not ${version}; not handing over to it.`);
  }
}

/**
 * Installs `target` globally and runs its `_apply-release`, which borrows our lock (`--parent-lock`).
 * Resolves to the child's exit code; throws when npm or the hand-over fails.
 */
export async function installAndApply(
  ctx: ReleaseContext,
  deps: ReleaseDeps,
  held: HeldLock,
  target: ReleaseManifest,
  apply: { reason: "update" | "rollback"; from: string },
): Promise<number> {
  const { env, io } = ctx;
  const spec = npmInstallSpec(target, env);
  held.live();
  io.out(`Installing factory ${target.factory} (${spec})…`);
  const installed = await deps.npm(["install", "-g", "--legacy-peer-deps", spec], { env, timeoutMs: NPM_TIMEOUT_MS });
  if (installed.code !== 0) {
    const how = installed.timedOut ? "timed out" : `failed with exit ${installed.code}`;
    throw new Error(`npm install -g of ${spec} ${how}.\n${installed.stderr.trim()}`);
  }
  const globalCli = await locateGlobalCli(deps.npm, env);
  await expectInstalledVersion(globalCli, target.factory);
  held.live();
  const args = [globalCli, "_apply-release", "--reason", apply.reason, "--from", apply.from, "--parent-lock", String(process.pid), "--yes"];
  try {
    return await deps.runNode(args, env);
  } catch (e) {
    throw new Error(`Could not start the installed factory CLI ${globalCli}: ${msg(e)}`, { cause: e });
  }
}
