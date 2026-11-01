// `factory config explain <key>`: where a setting's effective value comes from.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../../adapters/platform/json-file.ts";
import type { FactoryPaths } from "../../adapters/platform/paths.ts";
import { readPersonalConfig } from "../../adapters/store/state-store.ts";
import { CoreConfig, ProjectConfig } from "../../core/config/schema.ts";
import { explainKey } from "../../core/config/explain.ts";
import { resolveConfig } from "../../core/config/resolve.ts";
import type { CliIO } from "../io.ts";
import { gitRoot } from "./init.ts";

export interface ConfigContext {
  paths: FactoryPaths;
  env: NodeJS.ProcessEnv;
  io: CliIO;
  /** Package root holding defaults/config.json. */
  root: string;
  cwd: string;
}

export async function configExplain(ctx: ConfigContext, key: string): Promise<number> {
  const { io } = ctx;
  try {
    const core = CoreConfig.parse(JSON.parse(readFileSync(join(ctx.root, "defaults", "config.json"), "utf8")));
    const personal = await readPersonalConfig(ctx.paths);
    const root = await gitRoot(ctx.cwd, ctx.env);
    let project: ProjectConfig | undefined;
    if (root !== undefined) {
      const raw = await readJson(join(root, ".factory", "config.json"));
      if (raw !== undefined) project = ProjectConfig.parse(raw);
    }
    const e = explainKey(resolveConfig({ core, personal, project }), key);
    if (!e) {
      io.err(`Unknown setting: ${key}`);
      return 1;
    }
    io.out(`${e.key} = ${JSON.stringify(e.value)}  (from ${e.source})`);
    for (const o of e.overridden) io.out(`overrides: ${o.source}=${JSON.stringify(o.value)}`);
    for (const v of e.violations) io.out(`violation: ${v.source} layer tried to set ${v.key} (${v.reason}); ignored`);
    return 0;
  } catch (err) {
    io.err(`Could not read the configuration: ${(err as Error).message}`);
    return 1;
  }
}
