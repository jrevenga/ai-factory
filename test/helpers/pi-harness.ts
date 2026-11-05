// Test harness for real Pi runs: installs the pinned Pi once into node_modules/.cache and runs it in
// print mode with an isolated agent dir, offline, telemetry off and stdin closed.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { npm } from "../../src/adapters/platform/npm.ts";
import { runBounded, type RunResult } from "../../src/adapters/platform/process.ts";
import { resolveFactoryHome, resolvePiAgentDir } from "../../src/core/paths/homes.ts";
import { isolatedEnv } from "./isolated-env.ts";
import { makeTmp } from "./tmp.ts";

export const TEST_PI_VERSION = "1.4.0";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(ROOT, "node_modules", ".cache", "factory-test-pi");
const CLI_REL = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"];

let pending: Promise<string> | undefined;

/**
 * Installs Pi into `node_modules/.cache/factory-test-pi/<version>` once and returns its `cli.js`.
 * Concurrency-safe across vitest workers: each caller installs into its own staging prefix with an
 * isolated npm environment and renames it into place; a caller that loses the race uses the winner's.
 */
export function ensureTestPi(): Promise<string> {
  pending ??= install().catch((e: unknown) => {
    pending = undefined;
    throw e;
  });
  return pending;
}

async function install(): Promise<string> {
  const target = join(CACHE, TEST_PI_VERSION);
  const cli = join(target, ...CLI_REL);
  if (existsSync(cli)) return cli;

  await mkdir(CACHE, { recursive: true });
  // Staging prefix next to the target (same filesystem, so the publish is an atomic rename); npm's
  // cache, prefix and the factory/Pi dirs live in a separate spaced temp dir.
  const staging = join(CACHE, `.staging ${TEST_PI_VERSION}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const envDir = await makeTmp("test-pi-install");
  try {
    const { args, env } = installCommand(staging, envDir.dir);
    const r = await npm(args, { env, cwd: envDir.dir, timeoutMs: 540_000 });
    if (r.code !== 0) throw new Error(`npm install of Pi ${TEST_PI_VERSION} failed (exit ${r.code}, timedOut ${r.timedOut}):\n${r.stderr}`);
    if (!existsSync(join(staging, ...CLI_REL))) throw new Error(`Pi ${TEST_PI_VERSION} installed without ${CLI_REL.join("/")}`);
    try {
      await rename(staging, target);
    } catch (e) {
      // Another worker won the race (EEXIST/ENOTEMPTY, or EPERM on Windows); its install is equivalent.
      if (!existsSync(cli)) throw e;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await envDir.cleanup();
  }
  return cli;
}

/**
 * The npm invocation that installs Pi into `staging`. npm's cache and prefix and the factory/Pi dirs
 * all live under `envDir`, with inherited casing variants of those keys dropped (isolatedEnv).
 */
export function installCommand(staging: string, envDir: string, base: NodeJS.ProcessEnv = process.env): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = ["install", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", `@earendil-works/pi-coding-agent@${TEST_PI_VERSION}`];
  return { args, env: isolatedEnv(envDir, base) };
}

export interface PiPrintOptions {
  cli: string;
  agentDir: string;
  cwd: string;
  extensions: string[];
  /** Defaults to an isolated environment next to `agentDir` (see piPrintEnv). */
  env?: NodeJS.ProcessEnv;
  prompt?: string;
  model?: string;
  args?: string[];
  timeoutMs?: number;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/** Sets `key` from any casing variant in `env` (exact case wins) and drops the other variants. */
function canonicalKey(env: NodeJS.ProcessEnv, key: string): void {
  const variants = Object.keys(env).filter((k) => k.toLowerCase() === key.toLowerCase());
  const value = env[key] ?? (variants[0] === undefined ? undefined : env[variants[0]]);
  for (const k of variants) delete env[k];
  if (value !== undefined) env[key] = value;
}

/**
 * Environment for a Pi print run. Without `env` it starts from an isolated environment next to the
 * agent dir; a missing FACTORY_HOME defaults to `<agentDir parent>/factory home`. The real default
 * factory home and Pi agent dir are refused.
 */
export function piPrintEnv(agentDir: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const parent = dirname(resolve(agentDir));
  const out: NodeJS.ProcessEnv = { ...(env ?? isolatedEnv(parent)) };
  canonicalKey(out, "FACTORY_HOME");
  canonicalKey(out, "PI_CODING_AGENT_DIR");
  if (!out.FACTORY_HOME) out.FACTORY_HOME = join(parent, "factory home");
  out.PI_CODING_AGENT_DIR = agentDir;
  out.PI_OFFLINE = "1";
  out.PI_TELEMETRY = "0";
  const home = homedir();
  if (samePath(resolveFactoryHome(out, home), resolveFactoryHome({}, home))) {
    throw new Error(`runPiPrint: refusing the real factory home ${resolveFactoryHome({}, home)}`);
  }
  if (samePath(resolvePiAgentDir(out, home), resolvePiAgentDir({}, home))) {
    throw new Error(`runPiPrint: refusing the real Pi agent dir ${resolvePiAgentDir({}, home)}`);
  }
  return out;
}

/** `node <cli> -p --no-session [-e each] [...args] --model <model> <prompt>` with stdin closed. */
export function runPiPrint(opts: PiPrintOptions): Promise<RunResult> {
  const env = piPrintEnv(opts.agentDir, opts.env);
  const args = [opts.cli, "-p", "--no-session"];
  for (const e of opts.extensions) args.push("-e", e);
  args.push(...(opts.args ?? []), "--model", opts.model ?? "factory-test/faux", opts.prompt ?? "go");
  return runBounded(process.execPath, args, {
    cwd: opts.cwd,
    env,
    timeoutMs: opts.timeoutMs ?? 90_000,
  });
}
