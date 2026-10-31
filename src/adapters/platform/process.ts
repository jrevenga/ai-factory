// Bounded child processes: captured output, closed stdin, timeout/abort, and whole-tree teardown.
// Ported from spikes/phase0/pi.mjs (spawnBounded/terminateTree/groupAlive).
//
// POSIX: each child leads its own process group (detached); teardown sends SIGTERM to the group,
// SIGKILL after GRACE_MS, and polls until the group is gone. After a normal exit, descendants still
// alive in the group are orphans and are torn down too (`orphans: true`).
// Windows (plan ruling 14): teardown is an awaited `taskkill /PID <pid> /T /F` while the leader is
// alive; descendants outliving a normally exited leader are not detected in Phase 1.
import { spawn, type ChildProcess } from "node:child_process";
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

const GRACE_MS = 2000;
const MAX_TEARDOWN_MS = 15_000;
const POLL_MS = 50;
const isWindows = process.platform === "win32";

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

function taskkill(pid: number): Promise<void> {
  const exe = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\taskkill.exe` : "taskkill";
  return new Promise((resolve) => {
    const k = spawn(exe, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("close", () => resolve());
    k.on("error", () => resolve());
  });
}

/** Kills the child's whole tree and resolves only when it is gone (bounded by MAX_TEARDOWN_MS). */
async function terminateTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    if (child.exitCode === null && child.signalCode === null) await taskkill(pid);
  } else {
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
    while (groupAlive(pid) && Date.now() - t0 < MAX_TEARDOWN_MS) {
      if (!killed && Date.now() - t0 >= GRACE_MS) {
        send("SIGKILL");
        killed = true;
      }
      await sleep(POLL_MS);
    }
  }
  // A process outside the tree we can reach (Windows after leader exit, or one that escaped the group)
  // may still hold our pipes; release them so the run always ends.
  setTimeout(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, GRACE_MS).unref();
}

// Children currently running. Each has ONE cancellation path (timeout, abort and parent signals all go
// through it). Parent SIGINT/SIGTERM handlers exist only while this set is non-empty.
interface ActiveChild {
  cancel(): Promise<void>;
}
const active = new Set<ActiveChild>();
const SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const;
let installed: { sig: NodeJS.Signals; listener: () => void }[] | undefined;

function onParentSignal(sig: NodeJS.Signals, exitCode: number): void {
  void Promise.all([...active].map((child) => child.cancel())).then(() => {
    removeSignalHandlers();
    // Re-raise so the default action applies (terminated by the signal, i.e. 130/143 in a shell).
    if (!isWindows && process.listenerCount(sig) === 0) process.kill(process.pid, sig);
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
function invocation(cmd: string, args: string[]): { file: string; argv: string[]; verbatim: boolean } {
  if (!isWindows || !/\.(cmd|bat)$/i.test(cmd)) return { file: cmd, argv: args, verbatim: false };
  assertCmdSafe(cmd);
  const line = args.length > 0 ? `"${cmd}" ${quoteCmdArgs(args)}` : `"${cmd}"`;
  return { file: process.env.ComSpec ?? "cmd.exe", argv: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/**
 * Runs `cmd args` without a shell, capturing stdout/stderr. Stdin always receives `input ?? ""` and is
 * closed. When cancelled, the promise resolves only after the whole process tree is gone.
 */
export function runBounded(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { file, argv, verbatim } = invocation(cmd, args);
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: !isWindows,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let terminating: Promise<void> | undefined;
    const terminate = () => (terminating ??= terminateTree(child));
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
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      untrack(entry);
    };

    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      void Promise.resolve(terminating).then(() => {
        cleanup();
        reject(err);
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      let orphans = false;
      if (!terminating && !isWindows && child.pid !== undefined && groupAlive(child.pid)) {
        orphans = true;
        void terminate();
      }
      void Promise.resolve(terminating).then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ code: interrupted ? null : (code ?? 1), stdout, stderr, timedOut, orphans });
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
