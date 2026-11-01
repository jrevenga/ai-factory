// Command router and composition root of the `factory` CLI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { factoryPaths } from "../adapters/platform/paths.ts";
import { ReleaseManifest } from "../core/release/manifest.ts";
import { runDoctor, formatDoctor } from "./commands/doctor.ts";
import { defaultIO, type CliIO } from "./io.ts";

export interface MainDeps {
  env?: NodeJS.ProcessEnv;
  /** Package root holding release.json; defaults to the package this file belongs to. */
  root?: string;
  fetchFn?: typeof fetch;
}

const USAGE = `Usage: factory [command]

Commands:
  (none)                       start the factory
  install                      install or repair the factory
  doctor [--offline] [--json]  check the installation
  update [--to <v>] [--yes]    update to a release
  rollback [<v>] [--yes]       roll back to a previous release
  init [--yes]                 set up the current project
  config explain <key>         explain where a setting comes from
  version                      print the factory version`;

const LATER_PHASE = new Set(["runs", "eval", "radar"]);
const STUBS = new Set(["install", "update", "rollback", "init", "config", "_apply-release"]);

export async function main(argv: string[], io: CliIO = defaultIO(), deps: MainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const root = deps.root ?? fileURLToPath(new URL("../../", import.meta.url));
  const [cmd, ...rest] = argv;
  const usage = (problem: string): number => {
    io.err(`${problem}\n${USAGE}`);
    return 2;
  };

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    io.out(USAGE);
    return 0;
  }
  if (cmd !== undefined && LATER_PHASE.has(cmd)) {
    io.err(`factory ${cmd} arrives in a later phase`);
    return 2;
  }
  if (cmd !== undefined && !STUBS.has(cmd) && cmd !== "version" && cmd !== "doctor") return usage(`Unknown command: ${cmd}`);

  if (cmd === undefined || STUBS.has(cmd)) {
    io.err(`factory ${cmd ?? "launcher"} is not implemented yet`);
    return 2;
  }

  const manifest = ReleaseManifest.parse(JSON.parse(readFileSync(join(root, "release.json"), "utf8")));

  if (cmd === "version") {
    io.out(manifest.factory);
    return 0;
  }

  let flags: { offline?: boolean; json?: boolean };
  try {
    flags = parseArgs({ args: rest, options: { offline: { type: "boolean" }, json: { type: "boolean" } }, allowPositionals: false, strict: true }).values;
  } catch (e) {
    return usage((e as Error).message);
  }
  const checks = await runDoctor({ paths: factoryPaths(env), env, offline: flags.offline === true, manifest, fetchFn: deps.fetchFn, root });
  io.out(flags.json ? JSON.stringify(checks, null, 2) : formatDoctor(checks));
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
