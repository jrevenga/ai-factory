// The run ledger (Phase 2 ruling 9): `<FACTORY_HOME>/runs/<projectId>/<runId>/events.jsonl`, one redacted JSON
// event per line, append-only. A reader skips a half-written final line (SIGKILL mid-append) and fails loudly
// on corruption anywhere else. `reconcile` finds runs that ended without `run_end` while their process is gone
// (A §10.5) and marks each with `run_interrupted`, so it is reported once.
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseRunEvent, RunEvent } from "../../../core/ledger/events.ts";
import { redact } from "../../../core/policy/redact.ts";
import type { Route, RouteState } from "../../../core/route/types.ts";

const EVENTS_FILE = "events.jsonl";
/** Created with O_EXCL by the reconciler that marks a run interrupted, so concurrent sessions mark it once. */
const CLAIM_FILE = "interrupted.claim";
const MASK = "***";
/** A string value under such a key is masked whatever it looks like (free-form records such as `route.state`). */
const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key)/i;
/** Events that recovery depends on are flushed to disk (power loss), the rest rely on the OS. */
const DURABLE_TYPES: ReadonlySet<string> = new Set(["checkpoint", "run_end", "run_interrupted"]);
const ROUTES: readonly Route[] = ["answer", "small", "feature", "project"];

export function ledgerDirFor(factoryHome: string, projectId: string): string {
  assertComponent(projectId, "projectId");
  return join(factoryHome, "runs", projectId);
}

function assertComponent(value: string, name: string): void {
  if (value === "" || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`${name} must be a single path component, got ${JSON.stringify(value)}`);
  }
}

/** Every string value redacted at any depth, and masked outright under a secret-named key; keys are kept. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, typeof v === "string" && SECRET_KEY.test(k) ? MASK : redactDeep(v)]),
    );
  }
  return value;
}

function parsesAsEvent(line: string): boolean {
  try {
    parseRunEvent(JSON.parse(line));
    return true;
  } catch {
    return false;
  }
}

/**
 * Repairs an unterminated final line so the next append starts a fresh line instead of gluing onto it: a tail
 * that parses as an event (what `read` accepts) gets its missing newline; an unparseable one (a torn write) is
 * dropped. Returns the number of bytes dropped. Only ever needed on a file whose writer died.
 */
function dropTornTail(file: string): number {
  let fd: number;
  try {
    fd = openSync(file, "r+");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    const text = readFileSync(file);
    const keep = text.lastIndexOf(0x0a) + 1;
    if (parsesAsEvent(text.subarray(keep).toString("utf8"))) {
      writeAll(fd, Buffer.from("\n"), size);
      return 0;
    }
    ftruncateSync(fd, keep);
    return size - keep;
  } finally {
    closeSync(fd);
  }
}

/** Writes every byte (a short write is retried; an error such as ENOSPC throws). */
function writeAll(fd: number, buf: Buffer, position?: number): void {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off, position === undefined ? null : position + off);
    if (n <= 0) throw new Error("run ledger write made no progress");
    off += n;
  }
}

export class RunLedger {
  readonly file: string;
  private checkedTail = false;

  /** `dir` is the project's ledger dir (`ledgerDirFor`); the run's events go to `<dir>/<runId>/events.jsonl`. */
  constructor(dir: string, runId: string) {
    assertComponent(runId, "runId");
    this.file = join(dir, runId, EVENTS_FILE);
  }

  /** Validates, redacts every string field and appends one line. Throws on an invalid event or an I/O error. */
  append(e: RunEvent): void {
    const event = RunEvent.parse(redactDeep(e));
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    if (!this.checkedTail) {
      dropTornTail(this.file);
      this.checkedTail = true;
    }
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeAll(fd, Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
      if (DURABLE_TYPES.has(event.type)) fsyncSync(fd);
    } catch (err) {
      // A failed write may leave a partial line: repair it before this instance appends again.
      this.checkedTail = false;
      throw err;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Known events in order; events of types this release does not know are skipped. An unparseable final line
   * (no trailing newline: a torn write) is skipped; an unparseable line anywhere else throws, naming file and line.
   */
  static read(file: string): RunEvent[] {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const terminated = text.endsWith("\n");
    if (terminated) lines.pop();
    const out: RunEvent[] = [];
    lines.forEach((line, i) => {
      if (line === "") return;
      const torn = !terminated && i === lines.length - 1;
      let parsed: ReturnType<typeof parseRunEvent>;
      try {
        parsed = parseRunEvent(JSON.parse(line));
      } catch (e) {
        if (torn) return;
        throw new Error(`${file}:${i + 1}: unparseable run ledger line: ${(e as Error).message.split("\n")[0]}`, { cause: e });
      }
      if (parsed.known) out.push(parsed.event);
    });
    return out;
  }
}

export interface InterruptedRun {
  runId: string;
  lastProgress?: { taskId: string; phase?: string; item?: string };
  lastCheckpoint?: { taskId: string; sha: string };
  route?: RouteState;
  /** The ledger could not be read (corruption before the last line); the run is not marked and is reported again. */
  error?: string;
}

/** The persisted route state, or undefined when it does not have the RouteState shape (never restore garbage). */
export function asRouteState(state: unknown): RouteState | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const s = state as Partial<Record<keyof RouteState, unknown>>;
  const optString = (v: unknown) => v === undefined || typeof v === "string";
  if (typeof s.route !== "string" || !ROUTES.includes(s.route as Route)) return undefined;
  if (s.tier !== undefined && !ROUTES.includes(s.tier as Route)) return undefined;
  if (!Array.isArray(s.writeRoots) || !s.writeRoots.every((r) => typeof r === "string")) return undefined;
  if (typeof s.needsReclassification !== "boolean") return undefined;
  if (![s.taskId, s.reason, s.worktree, s.base].every(optString)) return undefined;
  if (s.declaredForInput !== undefined && typeof s.declaredForInput !== "number") return undefined;
  return state as unknown as RouteState;
}

function pidOf(runId: string, events: RunEvent[]): number | undefined {
  const start = events.find((e) => e.type === "run_start");
  if (start?.type === "run_start") return start.pid;
  const m = /-(\d+)$/.exec(runId);
  return m ? Number(m[1]) : undefined;
}

/**
 * O_EXCL claim of an interrupted run; false when another reconciler already claimed it. A reconciler that dies
 * between the claim and `run_interrupted` leaves the run claimed and unreported (accepted: a crash at startup).
 */
function claim(file: string, selfRunId: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeAll(fd, Buffer.from(`${selfRunId}\n`, "utf8"));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Interrupted runs of the project other than `selfRunId`: no `run_end`, no `run_interrupted`, and the run's pid
 * (from `run_start`, else the runId suffix) is not alive — an unknown pid counts as dead. Each is marked with
 * `run_interrupted { detectedBy: selfRunId }` after claiming it with `interrupted.claim` (O_EXCL; a run claimed by
 * another reconciler is skipped). The event is fsynced. Ordered by runId (start time).
 */
export function reconcile(factoryHome: string, projectId: string, selfRunId: string, isAlive: (pid: number) => boolean): InterruptedRun[] {
  const dir = ledgerDirFor(factoryHome, projectId);
  if (!existsSync(dir)) return [];
  const runIds = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== selfRunId)
    .map((d) => d.name)
    .sort();
  const found: InterruptedRun[] = [];
  for (const runId of runIds) {
    const ledger = new RunLedger(dir, runId);
    if (!existsSync(ledger.file)) continue;
    let events: RunEvent[];
    try {
      events = RunLedger.read(ledger.file);
    } catch (e) {
      found.push({ runId, error: (e as Error).message });
      continue;
    }
    if (events.some((e) => e.type === "run_end" || e.type === "run_interrupted")) continue;
    const pid = pidOf(runId, events);
    if (pid !== undefined && isAlive(pid)) continue;

    if (!claim(join(dir, runId, CLAIM_FILE), selfRunId)) continue;

    const run = summarize(runId, events);
    ledger.append({ v: 1, ts: new Date().toISOString(), runId, type: "run_interrupted", detectedBy: selfRunId });
    found.push(run);
  }
  return found;
}

/** The last progress, checkpoint and route of a run's events. */
function summarize(runId: string, events: RunEvent[]): InterruptedRun {
  const run: InterruptedRun = { runId };
  for (const e of events) {
    if (e.type === "progress") {
      run.lastProgress = { taskId: e.taskId, ...(e.phase !== undefined ? { phase: e.phase } : {}), ...(e.item !== undefined ? { item: e.item } : {}) };
    } else if (e.type === "checkpoint") {
      run.lastCheckpoint = { taskId: e.taskId, sha: e.sha };
    } else if (e.type === "route") {
      const route = asRouteState(e.state);
      if (route) run.route = route;
      else delete run.route;
    }
  }
  return run;
}

/** A run id as `runIdFor` makes it (`<yyyymmddThhmmssZ>-<pid>`): anything else read from a session entry is ignored. */
const RUN_ID = /^\d{8}T\d{6}Z-\d+$/;

/** The `piSession` of a run's `run_start` (its first event), read from the first line only. */
function piSessionOf(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const nl = text.indexOf("\n");
  try {
    const first = parseRunEvent(JSON.parse(nl === -1 ? text : text.slice(0, nl)));
    return first.known && first.event.type === "run_start" ? first.event.piSession : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Review M5 (Task 8, carry-forward Task 13): the interrupted earlier runs of *this* Pi session, independent of the
 * `interrupted.claim` marker (another session in the project may have claimed and reported them first). Two runs
 * are checked: the latest earlier run whose `run_start.piSession` is `piSession`, and `routeRunId`, the run that
 * wrote the session branch's last `factory-route` entry (when it names a run of this project). Either one counts
 * as interrupted when it has no `run_end` and is marked `run_interrupted` or its pid is not alive; an unreadable
 * ledger counts as interrupted too (the caller only flags the route, which fails safe). Nothing is written.
 */
export function sessionInterruptedRuns(
  factoryHome: string,
  projectId: string,
  selfRunId: string,
  opts: { piSession?: string; routeRunId?: string },
  isAlive: (pid: number) => boolean,
): InterruptedRun[] {
  const dir = ledgerDirFor(factoryHome, projectId);
  if (!existsSync(dir)) return [];
  const runIds = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== selfRunId && RUN_ID.test(d.name))
    .map((d) => d.name)
    .sort();
  const candidates = new Set<string>();
  if (opts.piSession !== undefined && opts.piSession !== "") {
    const latest = runIds.filter((r) => piSessionOf(new RunLedger(dir, r).file) === opts.piSession).at(-1);
    if (latest !== undefined) candidates.add(latest);
  }
  if (opts.routeRunId !== undefined && RUN_ID.test(opts.routeRunId) && runIds.includes(opts.routeRunId)) candidates.add(opts.routeRunId);
  const found: InterruptedRun[] = [];
  for (const runId of [...candidates].sort()) {
    const file = new RunLedger(dir, runId).file;
    if (!existsSync(file)) continue;
    let events: RunEvent[];
    try {
      events = RunLedger.read(file);
    } catch (e) {
      found.push({ runId, error: (e as Error).message });
      continue;
    }
    if (events.some((e) => e.type === "run_end")) continue;
    const marked = events.some((e) => e.type === "run_interrupted");
    const pid = pidOf(runId, events);
    if (!marked && pid !== undefined && isAlive(pid)) continue;
    found.push(summarize(runId, events));
  }
  return found;
}

/**
 * Fix round 1 (Task 13): whether `runId` (a run of the project other than this one) is interrupted for a replay: no
 * `run_end`, and marked `run_interrupted` (by whoever detected it) or its pid is not alive. `error` when its ledger is
 * missing or unreadable (the run is then left alone; `reconcile` reports an unreadable ledger).
 */
export function runInterrupted(dir: string, runId: string, isAlive: (pid: number) => boolean): boolean | "error" {
  let events: RunEvent[];
  try {
    events = RunLedger.read(new RunLedger(dir, runId).file);
  } catch {
    return "error";
  }
  if (events.some((e) => e.type === "run_end")) return false;
  if (events.some((e) => e.type === "run_interrupted")) return true;
  const pid = pidOf(runId, events);
  return pid === undefined || !isAlive(pid);
}

/** Fix round 2 (R50.3): `<runDir>/replay.lock`, the directory lock to replay an interrupted run's reconciles. */
export const REPLAY_LOCK = "replay.lock";
const LOCK_OWNER = "owner";
/** A lock directory without a readable owner is treated as held for this long (its creator may still be writing it). */
const OWNERLESS_LOCK_GRACE_MS = 10_000;
const LOCK_ATTEMPTS = 3;

/**
 * The start time of process `pid` (Linux: field 22 of `/proc/<pid>/stat`, in clock ticks since boot), so a recorded
 * holder is not mistaken for an unrelated process that reused its pid. Undefined where it cannot be read.
 */
export function processStart(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}

/** What a contender saw at the lock path: the directory's identity and its owner record (empty: none yet). */
interface LockView {
  ino: number;
  owner: string;
  mtimeMs: number;
}

function viewLock(dir: string): LockView | undefined {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let owner = "";
  try {
    owner = readFileSync(join(dir, LOCK_OWNER), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
  }
  return { ino: st.ino, owner, mtimeMs: st.mtimeMs };
}

/** The holder recorded in `owner` is alive: its pid is alive and, where recorded and readable, has the same start. */
function lockHolderAlive(view: LockView, isAlive: (pid: number) => boolean): boolean {
  let rec: { pid?: unknown; start?: unknown } | undefined;
  try {
    rec = JSON.parse(view.owner) as { pid?: unknown; start?: unknown };
  } catch {
    rec = undefined;
  }
  if (typeof rec?.pid !== "number") return Date.now() - view.mtimeMs < OWNERLESS_LOCK_GRACE_MS;
  if (!isAlive(rec.pid)) return false;
  if (typeof rec.start === "string") {
    const now = processStart(rec.pid);
    if (now !== undefined && now !== rec.start) return false;
  }
  return true;
}

const sameLock = (a: LockView, b: LockView | undefined): boolean => b !== undefined && a.owner === b.owner && (a.ino === 0 || b.ino === 0 || a.ino === b.ino);

/** Test seam: called after a contender judged the holder dead (`inspected`) and after its takeover rename (`renamed`). */
export type ReplayLockStep = (step: "inspected" | "displaced" | "renamed" | "acquired") => void;

/**
 * Fix round 3 (R51): scan the retained `replay.lock.stale-*` directories of `runDir`. A directory whose owner is dead
 * is pruned; one whose owner is alive, or whose owner record cannot be read, is a replay that may still be running
 * (a lock displaced by a contender with a stale view), so it blocks admission (true: back off). A directory with no
 * owner record yet counts as live for the grace period, like the canonical lock.
 */
function staleLockBlocks(runDir: string, isAlive: (pid: number) => boolean): boolean {
  let names: string[];
  try {
    names = readdirSync(runDir).filter((n) => n.startsWith(`${REPLAY_LOCK}.stale-`));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return true;
  }
  let blocks = false;
  for (const name of names) {
    const dir = join(runDir, name);
    let text: string | undefined;
    let mtimeMs = 0;
    try {
      mtimeMs = lstatSync(dir).mtimeMs;
      text = readFileSync(join(dir, LOCK_OWNER), "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && text === undefined && existsSync(dir)) {
        // No owner record: live while recent, dead after the grace period.
        if (Date.now() - mtimeMs < OWNERLESS_LOCK_GRACE_MS) blocks = true;
        else rmSync(dir, { recursive: true, force: true });
      } else if (code !== "ENOENT") blocks = true; // unreadable: fail closed
      continue;
    }
    let pid: unknown;
    try {
      pid = (JSON.parse(text) as { pid?: unknown }).pid;
    } catch {
      pid = undefined;
    }
    if (typeof pid !== "number") {
      blocks = true; // unreadable owner: fail closed
      continue;
    }
    if (lockHolderAlive({ ino: 0, owner: text, mtimeMs }, isAlive)) blocks = true;
    else rmSync(dir, { recursive: true, force: true });
  }
  return blocks;
}

/**
 * Fix round 2 (R50.3): the exclusive right to replay the reconciles of the interrupted run in `runDir`, so two Pi
 * sessions never replay the same manifests at once and a holder that died does not leave them abandoned. The lock is
 * the directory `replay.lock` (`mkdir` is atomic: one contender creates it), holding an `owner` record (runId, pid of
 * the runId and, for this process, its start identity) written exclusively. A contender that finds a dead holder takes
 * over by renaming the directory to a fresh `replay.lock.stale-<random>` (one rename wins; a name is never reused) and
 * then retries `mkdir`. If the renamed directory is not the one it judged dead (a stale view: someone took over in
 * between), it is renamed back and the contender backs off. The lock is kept for the holder's lifetime. False: a live
 * session holds it (replay in progress elsewhere), or the contest was lost.
 */
export function acquireReplayLock(runDir: string, selfRunId: string, isAlive: (pid: number) => boolean, step?: ReplayLockStep): boolean {
  const lock = join(runDir, REPLAY_LOCK);
  const m = RUN_ID.test(selfRunId) ? /-(\d+)$/.exec(selfRunId) : null;
  const pid = m ? Number(m[1]) : process.pid;
  const start = pid === process.pid ? processStart(pid) : undefined;
  // Fix round 3 (R51): a retained displaced directory with a live owner means a replay may still be running.
  if (staleLockBlocks(runDir, isAlive)) return false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const seen = viewLock(lock);
      if (seen === undefined) continue;
      if (lockHolderAlive(seen, isAlive)) return false;
      step?.("inspected");
      const stale = `${lock}.stale-${randomBytes(8).toString("hex")}`;
      try {
        renameSync(lock, stale);
      } catch (err) {
        // Another contender renamed it first.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      step?.("displaced");
      if (!sameLock(seen, viewLock(stale))) {
        // A stale view: the directory renamed is a newer holder's. Give it back; this contender loses.
        try {
          renameSync(stale, lock);
        } catch {
          // A third contender created the lock meanwhile; the newer holder loses it (replayInterrupted re-checks).
        }
        return false;
      }
      rmSync(stale, { recursive: true, force: true });
      step?.("renamed");
      continue;
    }
    const ownerText = `${JSON.stringify({ runId: selfRunId, pid, ...(start !== undefined ? { start } : {}) })}\n`;
    try {
      writeFileSync(join(lock, LOCK_OWNER), ownerText, { flag: "wx", mode: 0o600 });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // The directory was replaced or taken over before the owner record landed: another contender holds it.
      if (code === "EEXIST" || code === "ENOENT") return false;
      throw e;
    }
    const mine = viewLock(lock);
    step?.("acquired");
    // Fix round 3 (R51): recheck that the canonical lock is still ours and that no displaced live owner exists.
    const now = viewLock(lock);
    if (mine === undefined || mine.owner !== ownerText || now === undefined || now.ino !== mine.ino || now.owner !== ownerText || staleLockBlocks(runDir, isAlive)) {
      releaseOwnReplayLock(runDir, mine?.ino, ownerText);
      return false;
    }
    return true;
  }
  return false;
}

/** Remove the directories (canonical or displaced) that are the one this contender created (same inode and owner). */
function releaseOwnReplayLock(runDir: string, ino: number | undefined, ownerText: string): void {
  if (ino === undefined) return;
  let names: string[] = [];
  try {
    names = readdirSync(runDir).filter((n) => n === REPLAY_LOCK || n.startsWith(`${REPLAY_LOCK}.stale-`));
  } catch {
    return;
  }
  for (const n of names) {
    const v = viewLock(join(runDir, n));
    if (v !== undefined && v.ino === ino && v.owner === ownerText) rmSync(join(runDir, n), { recursive: true, force: true });
  }
}

/** The lock in `runDir` is held by `selfRunId` (a holder re-checks it before each replayed manifest). */
export function holdsReplayLock(runDir: string, selfRunId: string): boolean {
  try {
    const rec = JSON.parse(readFileSync(join(runDir, REPLAY_LOCK, LOCK_OWNER), "utf8")) as { runId?: unknown };
    return rec.runId === selfRunId;
  } catch {
    return false;
  }
}
