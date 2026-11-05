// Where the eval harness keeps its data: `<FACTORY_HOME>/eval` (runs, private tasks, auth vault, tools).
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveFactoryHome } from "../../core/paths/homes.ts";

export interface EvalPaths {
  root: string;
  runs: string;
  tasks: string;
  vault: { codex: string; pi: string; claudeToken: string };
  tools: string;
}

export function evalPaths(env: NodeJS.ProcessEnv = process.env): EvalPaths {
  const root = join(resolveFactoryHome(env, homedir()), "eval");
  const vault = join(root, "vault");
  return {
    root,
    runs: join(root, "runs"),
    tasks: join(root, "tasks"),
    vault: { codex: join(vault, "codex"), pi: join(vault, "pi"), claudeToken: join(vault, "claude-oauth-token") },
    tools: join(root, "tools"),
  };
}

/** `mkdir -p`; on POSIX the directory (and any parent created on the way) is 0700. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}
