// Test harness for real Pi runs: installs the pinned Pi once into node_modules/.cache and runs it in
// print mode with an isolated agent dir, offline, telemetry off and stdin closed.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npm } from "../../src/adapters/platform/npm.ts";
import { runBounded, type RunResult } from "../../src/adapters/platform/process.ts";

export const TEST_PI_VERSION = "1.4.0";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(ROOT, "node_modules", ".cache", "factory-test-pi");
const CLI_REL = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"];

let pending: Promise<string> | undefined;

/**
 * Installs Pi into `node_modules/.cache/factory-test-pi/<version>` once and returns its `cli.js`.
 * Concurrency-safe across vitest workers: each caller installs into its own temp prefix and renames
 * it into place; a caller that loses the rename race uses the winner's install.
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
  const tmp = join(CACHE, `.tmp-${TEST_PI_VERSION}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: join(CACHE, ".npm-cache") };
    const r = await npm(
      ["install", "--prefix", tmp, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", `@earendil-works/pi-coding-agent@${TEST_PI_VERSION}`],
      { env, cwd: CACHE, timeoutMs: 540_000 },
    );
    if (r.code !== 0) throw new Error(`npm install of Pi ${TEST_PI_VERSION} failed (exit ${r.code}, timedOut ${r.timedOut}):\n${r.stderr}`);
    if (!existsSync(join(tmp, ...CLI_REL))) throw new Error(`Pi ${TEST_PI_VERSION} installed without ${CLI_REL.join("/")}`);
    try {
      await rename(tmp, target);
    } catch (e) {
      // Another worker won the race (EEXIST/ENOTEMPTY, or EPERM on Windows); its install is equivalent.
      if (!existsSync(cli)) throw e;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return cli;
}

export interface PiPrintOptions {
  cli: string;
  agentDir: string;
  cwd: string;
  extensions: string[];
  /** Must carry FACTORY_HOME (a temp dir) so no run can touch the real ~/.factory. */
  env: NodeJS.ProcessEnv;
  prompt?: string;
  model?: string;
  args?: string[];
  timeoutMs?: number;
}

/** `node <cli> -p --no-session [-e each] [...args] --model <model> <prompt>` with stdin closed. */
export function runPiPrint(opts: PiPrintOptions): Promise<RunResult> {
  if (!opts.env.FACTORY_HOME) throw new Error("runPiPrint: env.FACTORY_HOME must point at a temp dir");
  const args = [opts.cli, "-p", "--no-session"];
  for (const e of opts.extensions) args.push("-e", e);
  args.push(...(opts.args ?? []), "--model", opts.model ?? "factory-test/faux", opts.prompt ?? "go");
  return runBounded(process.execPath, args, {
    cwd: opts.cwd,
    env: { ...opts.env, PI_CODING_AGENT_DIR: opts.agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    timeoutMs: opts.timeoutMs ?? 90_000,
  });
}
