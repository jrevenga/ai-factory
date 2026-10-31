import { join } from "node:path";

const ISOLATED = ["FACTORY_HOME", "PI_CODING_AGENT_DIR", "npm_config_prefix", "npm_config_cache"] as const;

/**
 * Environment for external processes started by tests: factory home, Pi agent dir, npm prefix and npm
 * cache all live under `dir` (a makeTmp dir, so the paths contain a space). Every casing variant of
 * those keys inherited from `base` is dropped first, so a host `NPM_CONFIG_PREFIX` cannot win.
 */
export function isolatedEnv(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const drop = new Set(ISOLATED.map((k) => k.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!drop.has(k.toLowerCase())) env[k] = v;
  env.FACTORY_HOME = join(dir, "factory home");
  env.PI_CODING_AGENT_DIR = join(dir, "pi agent");
  env.npm_config_prefix = join(dir, "npm prefix");
  env.npm_config_cache = join(dir, "npm cache");
  return env;
}
