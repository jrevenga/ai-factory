// Where the factory store and the Pi agent dir live, derived from the environment. Pure: the caller
// passes the user's home directory (core may not import node:os), so the CLI adapters and the Pi
// extension resolve exactly the same locations.
import { join, resolve } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

/** Expands a leading `~` the way Pi does for PI_CODING_AGENT_DIR, then makes the path absolute (against `cwd`, default the process's). */
export function expandHome(p: string, home: string, platform: NodeJS.Platform = process.platform, cwd?: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return join(home, p.slice(2));
  return cwd === undefined ? resolve(p) : resolve(cwd, p);
}

/** Environment variables naming a directory the factory or Pi reads; children must get them absolute (I4). */
export const DIR_OVERRIDES = ["FACTORY_HOME", "PI_CODING_AGENT_DIR"] as const;

/**
 * `env` with every set directory override (DIR_OVERRIDES) expanded and made absolute against `cwd`, the
 * caller's directory. Resolved once at the CLI's entry, so every child process (Pi run from the factory
 * home, `_apply-release`, the launcher's Pi) sees the same directories whatever its working directory.
 * Returns a copy; unset or empty values are left as they are.
 */
export function withAbsoluteDirs<E extends Env>(env: E, home: string, cwd: string, platform: NodeJS.Platform = process.platform): E {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of DIR_OVERRIDES) {
    const value = env[key];
    if (value) out[key] = expandHome(value, home, platform, cwd);
  }
  return out as E;
}

/** `FACTORY_HOME`, default `<home>/.factory`. An empty value counts as unset. */
export function resolveFactoryHome(env: Env, home: string): string {
  return env.FACTORY_HOME ? expandHome(env.FACTORY_HOME, home) : join(home, ".factory");
}

/** `PI_CODING_AGENT_DIR`, default `<home>/.pi/agent`. An empty value counts as unset. */
export function resolvePiAgentDir(env: Env, home: string): string {
  return env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR, home) : join(home, ".pi", "agent");
}
