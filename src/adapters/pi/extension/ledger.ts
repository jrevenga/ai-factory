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
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
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
