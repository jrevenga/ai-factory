// Bounded child processes: captured output, closed stdin, timeout/abort, and whole-tree teardown.
// Ported from spikes/phase0/pi.mjs (spawnBounded/terminateTree/groupAlive).
//
// POSIX: each child leads its own process group (detached); teardown sends SIGTERM to the group,
// SIGKILL after GRACE_MS, and polls until the group is gone. When the leader exits, descendants still
// alive in the group are orphans and are torn down too (`orphans: true`).
// Windows (plan ruling 14): teardown is an awaited, bounded `taskkill /PID <pid> /T /F` while the leader
// is alive; descendants outliving a normally exited leader are not detected in Phase 1.
// A teardown that fails rejects the run with ProcessTeardownFailed instead of leaving it pending.
//
// Writer groups (controller ruling R17, amended): while a factory lock is held, each POSIX child's
// process group is recorded as an empty file `<registry>/<pgid>` (written right after spawn, removed
// once the group is gone). A lender stops every recorded group after its borrower exits, and an
// acquirer refuses the lock while one is alive, so the lock never becomes reusable while an installer
// (npm, Pi) started in its own group may still write.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertCmdSafe, quoteCmdArgs } from "./cmd-quote.ts";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  /** Exit code; `null` when the run was cancelled (timeout, abort or parent signal). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** POSIX only: descendants outlived the leader and were torn down. */
  orphans: boolean;
}

/** Platform seams; production uses the defaults, tests inject them to exercise the Windows branch anywhere. */
export interface ProcessDeps {
  platform: NodeJS.Platform;
  /** Starts the Windows tree-kill command for `pid` (default `taskkill /PID <pid> /T /F`). */
  spawnTaskkill: (pid: number) => ChildProcess;
  taskkillTimeoutMs: number;
}

export class ProcessTeardownFailed extends Error {
  readonly pid: number;
  readonly reason: string;
  constructor(pid: number, reason: string) {
    super(`Could not terminate process ${pid} and its descendants: ${reason}. It may still be running.`);
    this.name = "ProcessTeardownFailed";
    this.pid = pid;
    this.reason = reason;
  }
}

const GRACE_MS = 2000;
const MAX_TEARDOWN_MS = 15_000;
const POLL_MS = 50;

const DEFAULT_DEPS: ProcessDeps = {
  platform: process.platform,
  spawnTaskkill: (pid) => {
    const exe = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\taskkill.exe` : "taskkill";
    return spawn(exe, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  },
  taskkillTimeoutMs: 10_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POSIX: true while any process of the group (pgid === leader pid) exists. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Windows: bounded taskkill; succeeds when it exits 0 or the leader is gone anyway. */
function taskkillTree(child: ChildProcess, pid: number, deps: ProcessDeps): Promise<void> {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const end = (failure: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (failure === undefined || exited(child) || !pidAlive(pid)) resolve();
      else reject(new ProcessTeardownFailed(pid, failure));
    };
    let k: ChildProcess;
    try {
      k = deps.spawnTaskkill(pid);
    } catch (e) {
      end(`taskkill could not start: ${(e as Error).message}`);
      return;
    }
    timer = setTimeout(() => {
      k.kill();
      end(`taskkill did not finish within ${deps.taskkillTimeoutMs} ms`);
    }, deps.taskkillTimeoutMs);
    k.on("error", (e) => end(`taskkill could not start: ${e.message}`));
    k.on("close", (code, signal) => end(code === 0 ? undefined : `taskkill exited with ${code ?? signal}`));
  });
}

/** POSIX: SIGTERM the group, SIGKILL after GRACE_MS, poll until gone; throws after MAX_TEARDOWN_MS. */
async function killGroup(pid: number): Promise<void> {
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // group already gone
    }
  };
  const t0 = Date.now();
  send("SIGTERM");
  let killed = false;
  while (groupAlive(pid)) {
    if (Date.now() - t0 >= MAX_TEARDOWN_MS) throw new ProcessTeardownFailed(pid, `process group still alive after ${MAX_TEARDOWN_MS} ms`);
    if (!killed && Date.now() - t0 >= GRACE_MS) {
      send("SIGKILL");
      killed = true;
    }
    await sleep(POLL_MS);
  }
}

/** Kills the child's whole tree; resolves when it is gone, rejects with ProcessTeardownFailed otherwise. */
async function terminateTree(child: ChildProcess, deps: ProcessDeps): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (deps.platform === "win32") await taskkillTree(child, pid, deps);
  else await killGroup(pid);
  // A process outside the tree we can reach (Windows after leader exit, or one that escaped the group)
  // may still hold our pipes; release them so the run always ends.
  setTimeout(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, GRACE_MS).unref();
}

/**
 * Bounded whole-tree teardown for a child the caller spawned itself (for streaming I/O runBounded does
 * not offer). On POSIX the child must lead its own process group (`detached: true`). Same semantics as
 * runBounded's cancellation: SIGTERM → SIGKILL after a grace period (POSIX) or an awaited, bounded
 * taskkill (Windows); rejects with ProcessTeardownFailed when the tree cannot be torn down.
 */
export function killProcessTree(child: ChildProcess, deps: Partial<ProcessDeps> = {}): Promise<void> {
  return terminateTree(child, { ...DEFAULT_DEPS, ...deps });
}

// Registries of writer process groups currently in use by this process (one per held lock); the most
// recent one records new children.
const registries: string[] = [];

/** Records the process groups of children started from now on in `dir` until the returned function is called. */
export function recordProcessGroupsIn(dir: string): () => void {
  registries.push(dir);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = registries.lastIndexOf(dir);
    if (i !== -1) registries.splice(i, 1);
  };
}

/** POSIX: true while any process of group `pgid` exists (never signals pgid ≤ 1). */
export function processGroupAlive(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1 && groupAlive(pgid);
}

/** The pgids recorded in a writer-group registry (missing directory → none). */
export async function recordedProcessGroups(dir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names.filter((n) => /^\d+$/.test(n)).map(Number).filter((n) => n > 1);
}

/**
 * POSIX: stops every group recorded in `dir` that is still alive (SIGTERM, SIGKILL after the grace
 * period, awaited) and removes the entries of groups that are gone. An entry whose group could not be
 * torn down is kept, so the lock stays unavailable. Returns the pgids still alive. No-op on Windows,
 * where children die with their parent's job object instead.
 */
export async function stopRecordedProcessGroups(dir: string, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (platform === "win32") return [];
  const survivors: number[] = [];
  for (const pgid of await recordedProcessGroups(dir)) {
    try {
      if (groupAlive(pgid)) await killGroup(pgid);
      await rm(join(dir, String(pgid)), { force: true });
    } catch {
      survivors.push(pgid);
    }
  }
  return survivors;
}

/** Exit code a shell reports for a process ended by `sig`. */
const SUPERVISED_SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;
/** How long a supervised child may take to tear down its own subprocesses before it is killed (> MAX_TEARDOWN_MS + GRACE_MS). */
const SUPERVISED_STOP_MS = MAX_TEARDOWN_MS + GRACE_MS + 3000;

export interface SupervisedOptions {
  env?: NodeJS.ProcessEnv;
  /** "inherit" hands the terminal's stdin to the child (a factory CLI with a question to ask); default "ignore". */
  stdin?: "inherit" | "ignore";
  /** Writer-group registry of the lock the child borrows: its recorded groups are stopped once it exits. */
  writerGroups?: string;
}

/**
 * Runs `cmd args` with the terminal's stdout/stderr (no shell, not detached: it stays in the terminal's
 * process group, so it can read the terminal) for a child that borrows this process's factory lock
 * (controller ruling R17). While it runs, SIGINT/SIGTERM/SIGHUP sent to this process do not end it:
 * the child is stopped first and awaited, and the promise then resolves to 128 + the signal number, so
 * the caller releases the lock only after the child is gone. POSIX: SIGTERM to the child, whose own
 * signal handlers tear down its bounded subprocesses (runBounded), then SIGKILL if it is still running
 * after SUPERVISED_STOP_MS. Windows: an awaited `taskkill /T /F` of the child's tree.
 * Otherwise resolves to the child's exit code (1 when it was ended by a signal).
 *
 * However the child ended (normally, by a signal, killed), the process groups it recorded in
 * `writerGroups` (installers started in their own groups) are stopped and awaited before the promise
 * resolves, so nothing the child started can still write once the caller releases the lock.
 */
export function runSupervised(cmd: string, args: string[], opts: SupervisedOptions = {}, deps: Partial<ProcessDeps> = {}): Promise<number> {
  const d: ProcessDeps = { ...DEFAULT_DEPS, ...deps };
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: [opts.stdin ?? "ignore", "inherit", "inherit"], shell: false, windowsHide: true });
    let received: { sig: NodeJS.Signals; code: number } | undefined;
    const gone = new Promise<void>((r) => child.once("exit", () => r()));
    const stop = async (): Promise<void> => {
      if (d.platform === "win32") {
        try {
          await taskkillTree(child, child.pid as number, d);
          return;
        } catch {
          child.kill("SIGKILL");
          return;
        }
      }
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), SUPERVISED_STOP_MS);
      await gone;
      clearTimeout(timer);
    };
    const listeners = SUPERVISED_SIGNALS.map(([sig, code]) => {
      const listener = (): void => {
        if (received !== undefined || exited(child)) return;
        received = { sig, code };
        void stop();
      };
      return { sig, listener };
    });
    const detach = (): void => {
      for (const { sig, listener } of listeners) process.off(sig, listener);
    };
    for (const { sig, listener } of listeners) process.on(sig, listener);
    child.once("error", (e) => {
      detach();
      reject(e);
    });
    child.once("exit", (code, signal) => {
      const result = received !== undefined ? received.code : (code ?? (signal ? 1 : 0));
      const groups = opts.writerGroups === undefined ? Promise.resolve([]) : stopRecordedProcessGroups(opts.writerGroups, d.platform);
      // Signals keep being absorbed until the writer groups are gone too.
      void groups.then(
        () => {
          detach();
          resolve(result);
        },
        () => {
          detach();
          resolve(result);
        },
      );
    });
  });
}

// Children currently running. Each has ONE cancellation path (timeout, abort and parent signals all go
// through it). Parent SIGINT/SIGTERM handlers exist only while this set is non-empty.
interface ActiveChild {
  cancel(): Promise<unknown>;
}
const active = new Set<ActiveChild>();
const SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;
let installed: { sig: NodeJS.Signals; listener: () => void }[] | undefined;

function onParentSignal(sig: NodeJS.Signals, exitCode: number): void {
  void Promise.allSettled([...active].map((child) => child.cancel())).then(() => {
    removeSignalHandlers();
    // Re-raise so the default action applies (terminated by the signal, i.e. 130/143 in a shell).
    if (process.platform !== "win32" && process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    process.exit(exitCode);
  });
}

function installSignalHandlers(): void {
  if (installed) return;
  installed = SIGNALS.map(([sig, exitCode]) => ({ sig, listener: () => onParentSignal(sig, exitCode) }));
  for (const { sig, listener } of installed) process.on(sig, listener);
}

function removeSignalHandlers(): void {
  if (!installed) return;
  for (const { sig, listener } of installed) process.off(sig, listener);
  installed = undefined;
}

function track(child: ActiveChild): void {
  active.add(child);
  installSignalHandlers();
}

function untrack(child: ActiveChild): void {
  active.delete(child);
  if (active.size === 0) removeSignalHandlers();
}

/** On Windows, `.cmd`/`.bat` files run through cmd.exe with constrained quoting (plan ruling 15). */
function invocation(cmd: string, args: string[], platform: NodeJS.Platform): { file: string; argv: string[]; verbatim: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cmd)) return { file: cmd, argv: args, verbatim: false };
  assertCmdSafe(cmd);
  const line = args.length > 0 ? `"${cmd}" ${quoteCmdArgs(args)}` : `"${cmd}"`;
  return { file: process.env.ComSpec ?? "cmd.exe", argv: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/**
 * Runs `cmd args` without a shell, capturing stdout/stderr. Stdin always receives `input ?? ""` and is
 * closed. When cancelled, the promise resolves only after the whole process tree is gone; if the tree
 * cannot be torn down it rejects with ProcessTeardownFailed. `deps` is a test seam.
 */
export function runBounded(cmd: string, args: string[], opts: RunOptions = {}, deps: Partial<ProcessDeps> = {}): Promise<RunResult> {
  const d: ProcessDeps = { ...DEFAULT_DEPS, ...deps };
  return new Promise((resolve, reject) => {
    const { file, argv, verbatim } = invocation(cmd, args, d.platform);
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: d.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let orphans = false;
    let settled = false;

    // Writer-group registry entry (POSIX: the child leads its own group), removed once the group is gone.
    const registry = d.platform !== "win32" && child.pid !== undefined ? registries[registries.length - 1] : undefined;
    const entryFile = registry === undefined ? undefined : join(registry, String(child.pid));
    let recordError: unknown;
    if (entryFile !== undefined && registry !== undefined) {
      try {
        mkdirSync(registry, { recursive: true });
        writeFileSync(entryFile, "");
      } catch (e) {
        recordError = e;
      }
    }

    const finish = (outcome: { result: RunResult } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      untrack(entry);
      // A group that could not be torn down may still write: keep its entry so the lock stays held.
      if (entryFile !== undefined && !("error" in outcome && outcome.error instanceof ProcessTeardownFailed)) {
        try {
          rmSync(entryFile, { force: true });
        } catch {
          // left behind: a later acquirer removes it once the group is gone
        }
      }
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.result);
    };

    // Resolves true when the tree is gone; on failure the run is finalized with the error and it resolves false.
    let terminating: Promise<boolean> | undefined;
    const terminate = () =>
      (terminating ??= terminateTree(child, d).then(
        () => true,
        (error: unknown) => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ error });
          return false;
        },
      ));
    const interrupt = () => {
      interrupted = true;
      return terminate();
    };
    const entry: ActiveChild = { cancel: interrupt };
    track(entry);

    const onTimeout = () => {
      timedOut = true;
      void interrupt();
    };
    const onAbort = () => void interrupt();
    const timer = opts.timeoutMs !== undefined ? setTimeout(onTimeout, opts.timeoutMs) : undefined;

    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => {
      void Promise.resolve(terminating).then(() => finish({ error }));
    });
    // Orphans are detected on `exit`, not `close`: descendants may keep our pipes open, which delays `close`.
    child.on("exit", () => {
      if (!terminating && d.platform !== "win32" && child.pid !== undefined && groupAlive(child.pid)) {
        orphans = true;
        void terminate();
      }
    });
    child.on("close", (code) => {
      void Promise.resolve(terminating).then(() =>
        finish({ result: { code: interrupted ? null : (code ?? 1), stdout, stderr, timedOut, orphans } }),
      );
    });

    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
    if (recordError !== undefined) {
      // An unrecorded writer could outlive us unnoticed: do not let it run.
      const error = recordError;
      void terminate().then(() => finish({ error }));
      return;
    }
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
