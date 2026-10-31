// Every filesystem location the factory reads or writes, derived from FACTORY_HOME and
// PI_CODING_AGENT_DIR (defaults ~/.factory and ~/.pi/agent).
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveFactoryHome, resolvePiAgentDir } from "../../core/paths/homes.ts";

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

export function factoryPaths(env: NodeJS.ProcessEnv = process.env): FactoryPaths {
  const home = resolveFactoryHome(env, homedir());
  const piAgentDir = resolvePiAgentDir(env, homedir());
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
