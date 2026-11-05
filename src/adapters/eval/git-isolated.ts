// Git for the controller (plan ruling 3). The agent owns its workspace, including `.git`, so the controller
// never runs git there; and every controller git command runs with an isolated environment so that nothing
// executable can come from configuration: no system/global/inherited config, no hooks, no fsmonitor, no
// attributes file. Filters, textconv and diff drivers exist only in config, so an agent-supplied
// `.gitattributes` in a controller-owned worktree references nothing.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBounded, type RunResult } from "../platform/process.ts";

export interface ControllerGitOptions {
  cwd: string;
  /** A controller-owned directory outside every agent-visible mount; holds the empty config, hooks dir and HOME. */
  scratch: string;
  timeoutMs?: number;
  /** Extra variables the caller sets deliberately (e.g. GIT_AUTHOR_DATE); applied last. */
  env?: Record<string, string>;
}

async function touchEmpty(path: string): Promise<void> {
  await writeFile(path, "", { flag: "a" });
}

/** The isolated git environment: minimal base, no inherited GIT_*, everything config-related pointed at `scratch`. */
export async function controllerGitEnv(scratch: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(scratch, "no-hooks"), { recursive: true });
  await touchEmpty(join(scratch, "empty-gitconfig"));
  await touchEmpty(join(scratch, "empty-attributes"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: scratch,
    LANG: process.env.LANG ?? "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(scratch, "empty-gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  if (process.platform === "win32") {
    for (const k of ["SystemRoot", "ComSpec", "TEMP", "TMP"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/** Runs git with the isolated env and the safety `-c` flags always applied. Returns the result; never throws on a non-zero exit. */
export async function controllerGit(args: string[], opts: ControllerGitOptions): Promise<RunResult> {
  const env = { ...(await controllerGitEnv(opts.scratch)), ...opts.env };
  const flags = [
    "-c", `core.hooksPath=${join(opts.scratch, "no-hooks")}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.attributesFile=${join(opts.scratch, "empty-attributes")}`,
    "-c", "core.autocrlf=false",
    "-c", "commit.gpgsign=false",
    "-c", "maintenance.auto=false",
    "-c", "gc.auto=0",
    "-c", "protocol.ext.allow=never",
  ];
  return runBounded("git", [...flags, ...args], { cwd: opts.cwd, env, timeoutMs: opts.timeoutMs ?? 120_000 });
}
