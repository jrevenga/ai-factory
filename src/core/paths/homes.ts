// Where the factory store and the Pi agent dir live, derived from the environment. Pure: the caller
// passes the user's home directory (core may not import node:os), so the CLI adapters and the Pi
// extension resolve exactly the same locations.
import { join, resolve } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

/** Expands a leading `~` the way Pi does for PI_CODING_AGENT_DIR, then makes the path absolute. */
export function expandHome(p: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return join(home, p.slice(2));
  return resolve(p);
}

/** `FACTORY_HOME`, default `<home>/.factory`. An empty value counts as unset. */
export function resolveFactoryHome(env: Env, home: string): string {
  return env.FACTORY_HOME ? expandHome(env.FACTORY_HOME, home) : join(home, ".factory");
}

/** `PI_CODING_AGENT_DIR`, default `<home>/.pi/agent`. An empty value counts as unset. */
export function resolvePiAgentDir(env: Env, home: string): string {
  return env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR, home) : join(home, ".pi", "agent");
}
