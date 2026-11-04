// `factory install`: checks the minimum requirements, then either applies this release or, when run
// through `npx` (whose cache is temporary), bootstraps a global install first and hands over to it.
//
// The bootstrap holds the factory lock from its state/journal recheck through `npm install -g` and the
// hand-over, whose `install --parent-lock` borrows it (controller ruling R18), so it never replaces the
// global CLI while an update or rollback runs, nor after one installed a newer release.
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npm } from "../../adapters/platform/npm.ts";
import { runSupervised } from "../../adapters/platform/process.ts";
import { acquireLock, Locked, type Lock } from "../../adapters/store/lock.ts";
import { npmInstallSpec } from "../../core/release/manifest.ts";
import { MIGRATIONS } from "../../core/state/migrations.ts";
import { applyPreflight, applyRelease, ApplyFailed, ApplyRefused, TXN_PENDING_MESSAGE, type ApplyContext } from "./apply-release.ts";
import { requirementChecks } from "./doctor.ts";

/** Seams for tests; production uses the real implementations. */
export interface InstallDeps {
  /** Real path of this CLI's entry file. */
  cliPath: string;
  npm: typeof npm;
  /** Runs `node <args>` with the terminal's output and resolves to its exit code; `interactive` also passes the terminal's stdin. */
  runNode: (args: string[], env: NodeJS.ProcessEnv, opts?: { interactive?: boolean }) => Promise<number>;
  requirements: typeof requirementChecks;
}

export interface InstallOptions {
  yes: boolean;
  profile?: string;
  /** Pid of the bootstrapping factory process whose lock this install borrows (R18). */
  parentLockPid?: number;
}

const NPM_TIMEOUT_MS = 10 * 60_000;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** True when `realPath` lies inside npm's `npx` cache (`…/_npx/…` or `…\_npx\…`). */
export function isNpxPath(realPath: string): boolean {
  return realPath.includes("/_npx/") || realPath.includes("\\_npx\\");
}

function ownCliPath(): string {
  return realpathSync(fileURLToPath(new URL("../../../bin/factory.mjs", import.meta.url)));
}

/**
 * `node <args>` for a factory CLI that borrows our lock, with output going straight to the terminal (no
 * shell). stdin is closed unless `interactive`, which hands the terminal to a factory CLI that has a
 * question to ask (never to Pi). A signal sent to us meanwhile stops the child and awaits it before we
 * go on to release the lock (R17); the result is then 128 + the signal number.
 */
export function runNodeInherited(args: string[], env: NodeJS.ProcessEnv, opts: { interactive?: boolean } = {}): Promise<number> {
  return runSupervised(process.execPath, args, { env, stdin: opts.interactive === true ? "inherit" : "ignore" });
}

export async function install(ctx: ApplyContext, opts: InstallOptions, overrides: Partial<InstallDeps> = {}): Promise<number> {
  const deps: InstallDeps = { cliPath: overrides.cliPath ?? ownCliPath(), npm, runNode: runNodeInherited, requirements: requirementChecks, ...overrides };
  const { io, env, manifest } = ctx;

  // Ruling R8: never install over an unfinished update/rollback; checked before the npx bootstrap too.
  if (existsSync(ctx.paths.txn)) {
    io.err(TXN_PENDING_MESSAGE);
    return 1;
  }

  // I2: refuse a downgrade or an unmigratable document before anything changes, including the npx
  // bootstrap's global npm install (the bootstrap and applyRelease repeat this under the factory lock).
  if (!(await preflight(ctx))) return 1;

  const failed = (await deps.requirements({ env, manifest })).filter((c) => c.status === "fail");
  if (failed.length > 0) {
    io.err(
      [
        "The factory cannot be installed until these requirements are met:",
        ...failed.map((c) => `  ${c.id}: ${c.message}${c.fix ? `\n     fix: ${c.fix}` : ""}`),
      ].join("\n"),
    );
    return 1;
  }

  if (isNpxPath(deps.cliPath)) return bootstrap(ctx, opts, deps);

  try {
    await applyRelease(ctx, { reason: "install", profile: opts.profile, yes: opts.yes, parentLockPid: opts.parentLockPid });
    return 0;
  } catch (e) {
    if (!(e instanceof ApplyFailed)) io.err(`Install did not complete: ${msg(e)}`);
    return 1;
  }
}

/** The install preflight; prints the refusal and returns false when the install must not start. */
async function preflight(ctx: ApplyContext): Promise<boolean> {
  try {
    await applyPreflight(ctx.paths, ctx.manifest, ctx.deps?.migrations ?? MIGRATIONS, "install");
    return true;
  } catch (e) {
    ctx.io.err(e instanceof ApplyRefused ? e.message : `Install did not start: ${msg(e)}. Nothing was changed.`);
    return false;
  }
}

/**
 * The CLI at npm's global root must be the release just installed (its own release.json), or another
 * install raced ours or npm kept a stale copy; handing over to it would apply the wrong release.
 */
export async function expectInstalledVersion(globalCli: string, version: string): Promise<void> {
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
 * Entry file of the globally installed factory CLI (`<npm root -g>/ai-factory/bin/factory.mjs`), checked
 * to exist and to lie outside the npx cache. Throws an error whose message tells the user what to do.
 */
export async function locateGlobalCli(npmFn: typeof npm, env: NodeJS.ProcessEnv): Promise<string> {
  const rootResult = await npmFn(["root", "-g"], { env, timeoutMs: 60_000 });
  const globalRoot = rootResult.stdout.trim();
  if (rootResult.code !== 0 || globalRoot === "") {
    throw new Error(`Could not determine npm's global root (\`npm root -g\` exited with ${rootResult.code}).\n${rootResult.stderr.trim()}`);
  }
  const globalCli = join(globalRoot, "ai-factory", "bin", "factory.mjs");
  if (isNpxPath(globalCli)) {
    throw new Error(`npm's global root ${globalRoot} is inside the npx cache; refusing to hand over to it. Set a user-owned global prefix (\`npm config set prefix <dir>\`) and retry.`);
  }
  if (!existsSync(globalCli)) {
    throw new Error(`npm reported success but ${globalCli} does not exist. Run \`npm ls -g ai-factory\` to inspect the global install, then retry.`);
  }
  return globalCli;
}

/**
 * Running from the npx cache: under the factory lock, recheck the journal and the installed state, install
 * this release globally (`--legacy-peer-deps`, ruling 5), check that the global CLI is this release, then
 * run its `install` with the same flags and `--parent-lock`, so the installed copy does the work under
 * our lock (R18). The lock is released only after that child has exited.
 */
async function bootstrap(ctx: ApplyContext, opts: InstallOptions, deps: InstallDeps): Promise<number> {
  const { io, paths } = ctx;
  let lock: Lock;
  try {
    lock = await acquireLock(paths);
  } catch (e) {
    io.err(e instanceof Locked ? e.message : `Could not take the factory lock ${paths.lock}: ${msg(e)}. Nothing was changed.`);
    return 1;
  }
  let code = 1;
  try {
    code = await bootstrapLocked(ctx, opts, deps, lock);
  } finally {
    try {
      await lock.release();
    } catch (e) {
      io.err(`The factory lock ${paths.lock} could not be released cleanly: ${msg(e)}. Another factory process may have run meanwhile; run "factory doctor".`);
      if (code === 0) code = 1;
    }
  }
  return code;
}

async function bootstrapLocked(ctx: ApplyContext, opts: InstallOptions, deps: InstallDeps, lock: Lock): Promise<number> {
  const { io, env, manifest, paths } = ctx;
  // Rechecked under the lock: an update or rollback may have started or finished since the first check.
  if (existsSync(paths.txn)) {
    io.err(TXN_PENDING_MESSAGE);
    return 1;
  }
  if (!(await preflight(ctx))) return 1;

  const spec = npmInstallSpec(manifest, env);
  let globalCli: string;
  try {
    await lock.verify();
    io.out(`Installing the factory CLI globally (${spec})…`);
    const installed = await deps.npm(["install", "-g", "--legacy-peer-deps", spec], { env, timeoutMs: NPM_TIMEOUT_MS, signal: lock.lost });
    if (installed.code !== 0) {
      const how = installed.timedOut ? "timed out" : `failed with exit ${installed.code}`;
      io.err(`npm install -g of ${spec} ${how}. Check your network and access to the repository, then retry.\n${installed.stderr.trim()}`);
      return 1;
    }
    globalCli = await locateGlobalCli(deps.npm, env);
    await expectInstalledVersion(globalCli, manifest.factory);
    await lock.verify();
  } catch (e) {
    io.err(msg(e));
    return 1;
  }
  const args = [
    globalCli,
    "install",
    ...(opts.yes ? ["--yes"] : []),
    ...(opts.profile === undefined ? [] : ["--profile", opts.profile]),
    "--parent-lock",
    String(process.pid),
  ];
  // R15: the global CLI may have to confirm the proposed profile, so it gets the terminal when one is there.
  const interactive = io.isTTY && !opts.yes && opts.profile === undefined;
  try {
    return await deps.runNode(args, env, { interactive });
  } catch (e) {
    io.err(`Could not start the globally installed factory CLI ${globalCli}: ${msg(e)}`);
    return 1;
  }
}
