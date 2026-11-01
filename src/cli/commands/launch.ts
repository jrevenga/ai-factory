// `factory` with no command: preflight, register a session, run the pinned Pi interactively.
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { FactoryPaths } from "../../adapters/platform/paths.ts";
import { Locked } from "../../adapters/store/lock.ts";
import { registerSession, type Session } from "../../adapters/store/sessions.ts";
import { readState } from "../../adapters/store/state-store.ts";
import type { ReleaseManifest } from "../../core/release/manifest.ts";
import type { CliIO } from "../io.ts";
import { runDoctor, formatDoctor, type DoctorCheck } from "./doctor.ts";

export interface LaunchContext {
  paths: FactoryPaths;
  env: NodeJS.ProcessEnv;
  manifest: ReleaseManifest;
  io: CliIO;
  root?: string;
  /** Test seam: replaces the offline doctor run. */
  doctor?: () => Promise<DoctorCheck[]>;
  /** Test seam: replaces session registration. */
  registerSession?: typeof registerSession;
}

/** A failure in one of these checks means Pi must not start. */
const BLOCKING = ["state", "txn", "pi-pinned", "factory-package", "guard"];
const FORWARDED = ["SIGTERM", "SIGHUP"] as const;

export async function launch(ctx: LaunchContext, piArgs: string[]): Promise<number> {
  const { io } = ctx;
  const refused = piArgs.find((a) => a === "--no-extensions" || a === "-ne");
  if (refused !== undefined) {
    io.err(`${refused} is not allowed: it would disable the factory package and its guard. Run Pi directly if you really need it.`);
    return 2;
  }

  const checks = await (ctx.doctor ?? (() => runDoctor({ paths: ctx.paths, env: ctx.env, offline: true, manifest: ctx.manifest, root: ctx.root })))();
  const blocking = checks.filter((c) => c.status === "fail" && BLOCKING.includes(c.id));
  if (blocking.length > 0) {
    io.err(formatDoctor(blocking));
    return 1;
  }
  const others = checks.filter((c) => c.status !== "ok").length;
  if (others > 0) io.err(`factory doctor reported ${others} finding(s); run \`factory doctor\` for details.`);

  const state = await readState(ctx.paths);
  if (!state) {
    io.err(`no ${ctx.paths.state}: the factory is not installed. Run \`factory install\`.`);
    return 1;
  }

  let session: Session;
  try {
    session = await (ctx.registerSession ?? registerSession)(ctx.paths);
  } catch (e) {
    if (e instanceof Locked) {
      io.err(`A factory update is in progress. ${e.message}`);
      return 1;
    }
    throw e;
  }

  // The terminal delivers Ctrl+C to the whole foreground group, so the child sees SIGINT itself; the
  // launcher must survive it and wait. SIGTERM/SIGHUP are sent to us only, so they are forwarded.
  const noop = (): void => {};
  let child: ReturnType<typeof spawn> | undefined;
  let pending: NodeJS.Signals | undefined;
  const forward = (sig: NodeJS.Signals): void => {
    if (child) child.kill(sig);
    else pending = sig;
  };
  const handlers = FORWARDED.map((sig) => [sig, () => forward(sig)] as const);
  process.on("SIGINT", noop);
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    const exit = await new Promise<number>((resolve) => {
      const c = spawn(process.execPath, [state.piCli, ...piArgs], {
        stdio: "inherit",
        shell: false,
        env: { ...ctx.env, PI_TELEMETRY: "0" },
      });
      child = c;
      c.once("error", (e) => {
        io.err(`Could not start Pi (${state.piCli}): ${e.message}`);
        resolve(1);
      });
      c.once("exit", (code, signal) => {
        resolve(code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0));
      });
      if (c.pid === undefined) return;
      session.setPiPid(c.pid).then(
        () => {
          if (pending) c.kill(pending);
        },
        (e: unknown) => {
          io.err(`Could not record the session: ${(e as Error).message}`);
          c.kill("SIGTERM");
        },
      );
    });
    return exit;
  } finally {
    process.off("SIGINT", noop);
    for (const [sig, h] of handlers) process.off(sig, h);
    // A record left behind is harmless (liveSessions drops dead pids); never let it mask Pi's exit code.
    try {
      await session.end();
    } catch (e) {
      io.err(`Could not remove the session record ${session.path}: ${(e as Error).message}. It is ignored once this process has exited.`);
    }
  }
}
