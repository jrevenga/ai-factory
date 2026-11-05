// Locating and running npm. npm is found via `npm_execpath`, else `npm` on PATH — never relative to
// process.execPath (spec A §6.2/C3). Its JS entry is preferred so no .cmd wrapper is needed on Windows.
import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { runBounded, type RunResult } from "./process.ts";

export class NpmNotFound extends Error {
  constructor() {
    super(
      "npm was not found: npm_execpath is not set and no npm is on PATH. Install Node.js with npm (https://nodejs.org) or add the directory containing npm to PATH, then retry.",
    );
    this.name = "NpmNotFound";
  }
}

export interface NpmCommand {
  cmd: string;
  args: string[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const isWindows = process.platform === "win32";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  if (!isFile(path)) return false;
  if (isWindows) return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH lookup that tolerates Windows' case-insensitive `Path` key. */
function pathValue(env: NodeJS.ProcessEnv): string {
  if (env.PATH !== undefined) return env.PATH;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key ? (env[key] ?? "") : "";
}

export function resolveNpm(env: NodeJS.ProcessEnv = process.env): NpmCommand {
  const execpath = env.npm_execpath;
  // Only npm's own entry: under pnpm/yarn scripts npm_execpath points at that package manager instead.
  if (execpath && /^npm-cli\.c?js$/i.test(basename(execpath))) return { cmd: process.execPath, args: [execpath] };
  const name = isWindows ? "npm.cmd" : "npm";
  for (const dir of pathValue(env).split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (!isExecutable(candidate)) continue;
    const cli = join(dirname(candidate), "node_modules", "npm", "bin", "npm-cli.js");
    if (isFile(cli)) return { cmd: process.execPath, args: [cli] };
    return { cmd: candidate, args: [] };
  }
  throw new NpmNotFound();
}

/** Runs npm non-interactively (no git credential prompts) with a timeout. */
export function npm(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  const base = opts.env ?? process.env;
  const { cmd, args: prefix } = resolveNpm(base);
  return runBounded(cmd, [...prefix, ...args], {
    cwd: opts.cwd,
    env: { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
  });
}
