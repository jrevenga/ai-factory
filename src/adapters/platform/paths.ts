// Every filesystem location the factory reads or writes, derived from FACTORY_HOME and
// PI_CODING_AGENT_DIR (defaults ~/.factory and ~/.pi/agent).
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface FactoryPaths {
  home: string;
  config: string;
  state: string;
  managedSettings: string;
  memoryDb: string;
  backups: string;
  sessions: string;
  lock: string;
  txn: string;
  /** Parent of the pinned Pi prefixes `<piPrefixes>/<version>/`. */
  piPrefixes: string;
  piAgentDir: string;
  piSettings: string;
  piExtensions: string;
}

/** Expands a leading `~` the way Pi does for PI_CODING_AGENT_DIR, then makes the path absolute. */
function absolute(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return join(homedir(), p.slice(2));
  return resolve(p);
}

export function factoryPaths(env: NodeJS.ProcessEnv = process.env): FactoryPaths {
  const home = env.FACTORY_HOME ? absolute(env.FACTORY_HOME) : join(homedir(), ".factory");
  const piAgentDir = env.PI_CODING_AGENT_DIR ? absolute(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  return {
    home,
    config: join(home, "config.json"),
    state: join(home, "state.json"),
    managedSettings: join(home, "managed-settings.json"),
    memoryDb: join(home, "memory.db"),
    backups: join(home, "backups"),
    sessions: join(home, "sessions"),
    lock: join(home, "factory.lock"),
    txn: join(home, "txn.json"),
    piPrefixes: join(home, "pi"),
    piAgentDir,
    piSettings: join(piAgentDir, "settings.json"),
    piExtensions: join(piAgentDir, "extensions"),
  };
}
