// Login detection without opening any credential file (plan ruling 6). Each CLI reads its own store:
// Claude via `claude auth status --json`, Codex via the pinned Pi's `auth check` (never `--credentials`).
// Anything that cannot be determined (spawn error, timeout, unexpected output) is `unknown`.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { LoginState } from "../../core/profiles/propose.ts";
import { runBounded, type RunResult } from "../platform/process.ts";
import { runPi } from "../pi/runtime.ts";

export interface DetectLoginsOptions {
  /** Pinned Pi `cli.js`; without it Codex is `unknown`. */
  piCli?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-check timeout, default 15 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function pathValue(env: NodeJS.ProcessEnv): string {
  if (env.PATH !== undefined) return env.PATH;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key ? (env[key] ?? "") : "";
}

/** First `claude` on PATH (Windows: claude.exe, then claude.cmd), or undefined. */
function findClaude(env: NodeJS.ProcessEnv): string | undefined {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of pathValue(env).split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

function parseJson(stdout: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(stdout.trim());
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a check; undefined when it could not start, timed out or was cancelled. */
async function attempt(run: () => Promise<RunResult>): Promise<RunResult | undefined> {
  try {
    const r = await run();
    return r.timedOut || r.code === null ? undefined : r;
  } catch {
    return undefined;
  }
}

async function detectClaude(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<LoginState> {
  const claude = findClaude(env);
  if (claude === undefined) return "absent";
  const r = await attempt(() => runBounded(claude, ["auth", "status", "--json"], { env, timeoutMs }));
  const loggedIn = r && parseJson(r.stdout)?.loggedIn;
  if (loggedIn === true && r?.code === 0) return "present";
  if (loggedIn === false) return "absent";
  return "unknown";
}

const CODEX_STATUS: Record<string, { state: LoginState; code: number }> = {
  ready: { state: "present", code: 0 },
  not_ready: { state: "absent", code: 1 },
  invalid: { state: "invalid", code: 2 },
};

async function detectCodex(piCli: string | undefined, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<LoginState> {
  if (piCli === undefined) return "unknown";
  const r = await attempt(() => runPi(piCli, ["auth", "check", "--provider", "openai-codex", "--json", "--no-refresh"], { env, timeoutMs }));
  const status = r && parseJson(r.stdout)?.status;
  const known = typeof status === "string" ? CODEX_STATUS[status] : undefined;
  // The JSON status and Pi's documented exit code must agree; anything else is not trusted.
  return known && r?.code === known.code ? known.state : "unknown";
}

export async function detectLogins(opts: DetectLoginsOptions = {}): Promise<{ claude: LoginState; codex: LoginState }> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [claude, codex] = await Promise.all([detectClaude(env, timeoutMs), detectCodex(opts.piCli, env, timeoutMs)]);
  return { claude, codex };
}
