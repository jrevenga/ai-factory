// Command router and composition root of the `factory` CLI.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { factoryPaths } from "../adapters/platform/paths.ts";
import { PiRuntime } from "../adapters/pi/runtime.ts";
import { withAbsoluteDirs } from "../core/paths/homes.ts";
import { CredentialsInSourceUrl, effectiveSource, ReleaseManifest } from "../core/release/manifest.ts";
import { APPLY_REASONS, applyRelease, ApplyFailed, type ApplyContext, type ApplyDeps, type ApplyReason } from "./commands/apply-release.ts";
import { configExplain } from "./commands/config.ts";
import { runDoctor, formatDoctor, type DoctorCheck } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";
import { install } from "./commands/install.ts";
import type { ReleaseDeps } from "./commands/release-txn.ts";
import { launch } from "./commands/launch.ts";
import { rollback } from "./commands/rollback.ts";
import { update } from "./commands/update.ts";
import { defaultIO, type CliIO } from "./io.ts";

export interface MainDeps {
  env?: NodeJS.ProcessEnv;
  /** Package root holding release.json; defaults to the package this file belongs to. */
  root?: string;
  fetchFn?: typeof fetch;
  /** Test seams for install/_apply-release. */
  pi?: PiRuntime;
  applyDeps?: Partial<ApplyDeps>;
  /** Test seams for update/rollback. */
  releaseDeps?: Partial<ReleaseDeps>;
  /** Test seams for the launcher and init/config. */
  doctor?: () => Promise<DoctorCheck[]>;
  /** The caller's directory: the project for init/config, and the base of relative directory overrides. */
  cwd?: string;
}

const USAGE = `Usage: factory [command]

Commands:
  (none)                       start the factory (Pi); arguments starting with "-"
                               and everything after "--" are passed to Pi
  install [--yes] [--profile <name>]
                               install or repair the factory
  doctor [--offline] [--json]  check the installation
  update [--to <v>] [--yes]    update to a release
  rollback [<v>] [--yes]       roll back to a previous release
  init [--yes]                 set up the current project
  config explain <key>         explain where a setting comes from
  version                      print the factory version`;

const LATER_PHASE = new Set(["runs", "eval", "radar"]);
const COMMANDS = new Set(["version", "doctor", "install", "_apply-release", "update", "rollback", "init", "config"]);

/**
 * Runs one CLI invocation. An error that escapes a command's own handling (a corrupt release.json, an
 * unexpected filesystem error) is printed as one line and exits 1; FACTORY_DEBUG=1 adds the stack.
 */
export async function main(argv: string[], io: CliIO = defaultIO(), deps: MainDeps = {}): Promise<number> {
  // I4: directory overrides are made absolute once, here; every path and every child uses this env.
  const env = withAbsoluteDirs(deps.env ?? process.env, homedir(), deps.cwd ?? process.cwd());
  try {
    return await run(argv, io, deps, env);
  } catch (e) {
    io.err(unexpectedError(e, env));
    return 1;
  }
}

/** One line for an unexpected error; the stack only when FACTORY_DEBUG=1. Shared with bin/factory.mjs's wording. */
export function unexpectedError(e: unknown, env: NodeJS.ProcessEnv): string {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " ");
  if (env.FACTORY_DEBUG === "1") return `factory: ${message}\n${e instanceof Error ? (e.stack ?? "") : ""}`;
  return `factory: ${message} (set FACTORY_DEBUG=1 for details)`;
}

async function run(argv: string[], io: CliIO, deps: MainDeps, env: NodeJS.ProcessEnv): Promise<number> {
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
  // Launcher: no command, `--` (everything after it goes to Pi), or a leading option (all of argv goes to Pi).
  const toPi = cmd === undefined ? [] : cmd === "--" ? rest : cmd.startsWith("-") ? argv : undefined;
  if (toPi === undefined && cmd !== undefined && !COMMANDS.has(cmd)) return usage(`Unknown command: ${cmd}`);

  const manifest = ReleaseManifest.parse(JSON.parse(readFileSync(join(root, "release.json"), "utf8")));

  if (cmd === "version") {
    io.out(manifest.factory);
    return 0;
  }

  // M3: a source URL with embedded credentials is refused before any command can print or store it.
  try {
    effectiveSource(manifest, env);
  } catch (e) {
    if (!(e instanceof CredentialsInSourceUrl)) throw e;
    io.err(e.message);
    return 1;
  }

  if (toPi !== undefined) {
    return launch({ paths: factoryPaths(env), env, manifest, io, root, doctor: deps.doctor }, toPi);
  }

  if (cmd === "install" || cmd === "_apply-release") {
    let flags: { yes?: boolean; profile?: string; reason?: string; from?: string; "parent-lock"?: string };
    try {
      const options = { yes: { type: "boolean" }, profile: { type: "string" }, "parent-lock": { type: "string" } } as const;
      const applyOptions = { ...options, reason: { type: "string" }, from: { type: "string" } } as const;
      flags = parseArgs({ args: rest, options: cmd === "install" ? options : applyOptions, allowPositionals: false, strict: true }).values;
    } catch (e) {
      return usage((e as Error).message);
    }
    let parentLockPid: number | undefined;
    if (flags["parent-lock"] !== undefined) {
      parentLockPid = /^\d+$/.test(flags["parent-lock"]) ? Number(flags["parent-lock"]) : Number.NaN;
      if (!Number.isSafeInteger(parentLockPid) || parentLockPid <= 0) return usage(`--parent-lock must be a process id, got ${flags["parent-lock"]}`);
    }
    const ctx: ApplyContext = { paths: factoryPaths(env), env, manifest, io, pi: deps.pi ?? new PiRuntime(), now: () => new Date(), root, deps: deps.applyDeps };
    // `install --parent-lock` is the npx bootstrap's hand-over (R18); it is not part of the usage text.
    if (cmd === "install") return install(ctx, { yes: flags.yes === true, profile: flags.profile, parentLockPid });

    if (flags.reason === undefined || !(APPLY_REASONS as readonly string[]).includes(flags.reason)) {
      return usage(`_apply-release needs --reason ${APPLY_REASONS.join("|")}`);
    }
    try {
      await applyRelease(ctx, { reason: flags.reason as ApplyReason, from: flags.from, parentLockPid, profile: flags.profile, yes: flags.yes === true });
      return 0;
    } catch (e) {
      if (!(e instanceof ApplyFailed)) io.err(`Install did not complete: ${(e as Error).message}`);
      return 1;
    }
  }

  if (cmd === "update" || cmd === "rollback") {
    let parsed: { values: { yes?: boolean; to?: string }; positionals: string[] };
    try {
      parsed =
        cmd === "update"
          ? parseArgs({ args: rest, options: { yes: { type: "boolean" }, to: { type: "string" } }, allowPositionals: false, strict: true })
          : parseArgs({ args: rest, options: { yes: { type: "boolean" } }, allowPositionals: true, strict: true });
    } catch (e) {
      return usage((e as Error).message);
    }
    if (parsed.positionals.length > 1) return usage(`rollback takes at most one version, got ${parsed.positionals.join(" ")}`);
    const ctx = { paths: factoryPaths(env), env, manifest, io, now: () => new Date(), deps: deps.releaseDeps };
    const yes = parsed.values.yes === true;
    return cmd === "update" ? update(ctx, { to: parsed.values.to, yes }) : rollback(ctx, { version: parsed.positionals[0], yes });
  }

  if (cmd === "init") {
    let yes: boolean | undefined;
    try {
      yes = parseArgs({ args: rest, options: { yes: { type: "boolean" } }, allowPositionals: false, strict: true }).values.yes;
    } catch (e) {
      return usage((e as Error).message);
    }
    return init({ io, env }, { yes: yes === true, cwd: deps.cwd ?? process.cwd() });
  }

  if (cmd === "config") {
    if (rest[0] !== "explain" || rest.length !== 2 || rest[1]?.startsWith("-")) return usage("config takes: explain <key>");
    return configExplain({ paths: factoryPaths(env), env, io, root, cwd: deps.cwd ?? process.cwd() }, rest[1] as string);
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
