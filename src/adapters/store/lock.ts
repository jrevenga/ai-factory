// The factory lock, held by install/update/rollback and briefly by session registration so an update
// never runs alongside a starting session (controller ruling R5: no hand-rolled mutual exclusion).
//
// Mutual exclusion is proper-lockfile's (the same library and protocol Pi uses for its settings):
// `<home>/factory.lock` is its lock directory, created with an atomic mkdir, kept fresh by a heartbeat
// (mtime update every `update` ms) and considered stale once its mtime is older than `stale` ms, i.e.
// after the holder stopped refreshing (crash, kill). `<home>/factory.lock.owner.json` (`{ pid, at }`)
// is written by the holder right after acquiring, outside the lock directory (proper-lockfile removes
// that with a non-recursive rmdir). It names the holder in `Locked` and enables borrowing by a child
// process (`ownerPid`), but never decides who holds the lock. Because an exited holder can leave it
// behind, it also records the identity of the lock directory it was written for (`lockDir`: inode and
// ms/ns birth time from a bigint stat); a borrow is granted only while that exact directory is the current,
// fresh lock and `ownerPid` is alive, so stale metadata can never lend another acquisition's lock.
//
// A borrow lasts only while the lender holds that same lock (controller ruling R17): a watchdog polls
// the lender's pid and the lock directory identity, and `verify()` repeats the check on demand before a
// commit point. Once either is lost the borrowed lock is compromised (`lost` aborts, `compromised` is
// set), so the borrower stops its subprocesses and commits nothing. A borrower whose lender is gone at
// start never takes the lock itself (LockLost): the journal is left for `factory rollback`.
//
// R17 amended: the lock never becomes reusable while a writer lives.
// - Borrower lease: the borrower writes `<home>/factory.lock.borrower.json` and refreshes its mtime like
//   an owner refreshes the lock directory. An acquirer that gets the lock directory but finds a fresh
//   lease gives the directory back (Locked). So the lock is held until the LAST of lender and borrower
//   is done: a borrower whose lender died aborts its transaction but keeps the lease until it has
//   stopped its own subprocesses, and only then releases. Publication and journal deletion therefore
//   never race another holder. The borrower writes the lease first and then re-checks the lender, so an
//   acquirer either sees the lease or the borrower sees the acquirer's directory and aborts.
// - Writer groups: while any lock is held, every bounded child's process group is recorded under
//   `<home>/factory.lock.writers/` (adapters/platform/process.ts). An acquirer refuses the lock while
//   a recorded group is alive (an installer orphaned by killed factory processes) and cleans dead entries.
import lockfile from "proper-lockfile";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";
import { processGroupAlive, recordedProcessGroups, recordProcessGroupsIn } from "../platform/process.ts";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_UPDATE_MS = 5_000;

export class Locked extends Error {
  readonly path: string;
  /** The holder's pid from the owner file, or undefined if it has not written one (yet). */
  readonly pid: number | undefined;
  constructor(path: string, pid: number | undefined, detail?: string) {
    super(
      detail !== undefined
        ? `The factory lock ${path} is still in use: ${detail}. Wait for them to finish and retry.`
        : pid === undefined
          ? `Another factory process holds the factory lock ${path}: an install, update or rollback is in progress. Wait for it to finish and retry.`
          : `Another factory process (pid ${pid}) holds the factory lock ${path}: an install, update or rollback is in progress. Wait for it to finish and retry.`,
    );
    this.name = "Locked";
    this.path = path;
    this.pid = pid;
  }
}

/** The lock this process holds or borrowed is no longer held for it; nothing may be committed under it. */
export class LockLost extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`The factory lock ${path} is no longer held for this process: ${detail}.`);
    this.name = "LockLost";
    this.path = path;
  }
}

export interface Lock {
  path: string;
  /** Pid of the holder (this process, or `ownerPid` when borrowed). */
  pid: number;
  /** True when the lock belongs to `ownerPid` (a parent factory process); release() then leaves it. */
  borrowed: boolean;
  /**
   * Set when the lock is lost: proper-lockfile reports it compromised (its directory was removed or
   * could not be refreshed within `stale`), or, for a borrowed lock, the lender ended or its lock
   * directory was replaced (LockLost). Long operations check it before mutating; an owned lock's
   * release() throws it instead of releasing.
   */
  readonly compromised: Error | undefined;
  /** Aborted (reason: the `compromised` error) as soon as the loss is noticed; pass it to subprocesses. */
  readonly lost: AbortSignal;
  /**
   * Checks now, on disk, that the lock is still held for this process (for a borrowed lock: the lender
   * is alive and still holds the lock directory it lent). Throws the loss otherwise. Call it right
   * before every commit point.
   */
  verify(): Promise<void>;
  /** Removes the owner file (if still ours) and releases the lock; a borrowed lock only stops watching. Errors propagate. */
  release(): Promise<void>;
}

/**
 * Heartbeat tuning; production uses the defaults (stale 10 s, update 5 s, borrow check 500 ms).
 * proper-lockfile enforces stale ≥ 2 s, update ≥ 1 s.
 */
export interface LockTuning {
  stale?: number;
  update?: number;
  /** How often a borrowed lock re-checks its lender (ms). */
  borrowCheck?: number;
}

const DEFAULT_BORROW_CHECK_MS = 500;

/** `process.kill(pid, 0)`: ESRCH → dead, EPERM → alive (exists, not ours). Never signals pid ≤ 0 (groups). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function ownerFilePath(paths: FactoryPaths): string {
  return `${paths.lock}.owner.json`;
}

/** The borrower's lease (R17 amended): the lock stays held while it is fresh. */
export function borrowerLeasePath(paths: FactoryPaths): string {
  return `${paths.lock}.borrower.json`;
}

/** Registry of writer process groups started under the lock (one empty file per pgid). */
export function writerGroupsPath(paths: FactoryPaths): string {
  return `${paths.lock}.writers`;
}

interface Lease {
  pid: number | undefined;
  lenderPid: number | undefined;
  id: string | undefined;
  /** Whether its mtime is younger than its own `staleMs`. */
  fresh: boolean;
}

async function readLease(paths: FactoryPaths): Promise<Lease | undefined> {
  const file = borrowerLeasePath(paths);
  let text: string;
  let mtimeMs: number;
  try {
    [text, mtimeMs] = await Promise.all([readFile(file, "utf8"), stat(file).then((st) => st.mtimeMs)]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let parsed: { pid?: unknown; lenderPid?: unknown; id?: unknown; staleMs?: unknown } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // unreadable (e.g. caught mid-write): judged by its mtime alone
  }
  const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  const staleMs = int(parsed.staleMs) ?? DEFAULT_STALE_MS;
  return { pid: int(parsed.pid), lenderPid: int(parsed.lenderPid), id: typeof parsed.id === "string" ? parsed.id : undefined, fresh: Date.now() - mtimeMs < staleMs };
}

/**
 * Why the lock, although its directory was just acquired, is still in use by a writer: a fresh borrower
 * lease, or a recorded writer process group that is alive. Stale leases and dead entries are removed.
 */
async function inUseByWriter(paths: FactoryPaths): Promise<Locked | undefined> {
  const lease = await readLease(paths);
  if (lease?.fresh) return new Locked(paths.lock, lease.pid);
  if (lease !== undefined) await rm(borrowerLeasePath(paths), { force: true });
  if (process.platform === "win32") return undefined;
  const alive: number[] = [];
  for (const pgid of await recordedProcessGroups(writerGroupsPath(paths))) {
    if (processGroupAlive(pgid)) alive.push(pgid);
    else await rm(join(writerGroupsPath(paths), String(pgid)), { force: true });
  }
  if (alive.length === 0) return undefined;
  const which = alive.length === 1 ? `process group ${alive[0]}` : `process groups ${alive.join(", ")}`;
  return new Locked(
    paths.lock,
    undefined,
    `${which} started by an interrupted factory process (npm or Pi) ${alive.length === 1 ? "is" : "are"} still running and may be writing; let ${alive.length === 1 ? "it" : "them"} end or stop ${alive.length === 1 ? "it" : "them"} (kill -TERM -<group>)`,
  );
}

interface LockDirId {
  ino: string;
  birthtimeMs: string;
  /** Nanosecond birth time: ext4 reuses a removed directory's inode at once, so ms alone can collide. */
  birthtimeNs: string;
}

interface Owner {
  pid: number | undefined;
  at: string | undefined;
  lockDir: LockDirId | undefined;
}

/** Identity of the current lock directory (bigint stat: exact inode / Windows file id), or undefined if absent. */
async function lockDirId(paths: FactoryPaths): Promise<LockDirId | undefined> {
  try {
    const st = await stat(paths.lock, { bigint: true });
    return { ino: st.ino.toString(), birthtimeMs: st.birthtimeMs.toString(), birthtimeNs: st.birthtimeNs.toString() };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** The owner file, tolerantly: missing → undefined, unreadable content → unknown pid. */
async function readOwner(paths: FactoryPaths): Promise<Owner | undefined> {
  let text: string;
  try {
    text = await readFile(ownerFilePath(paths), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const parsed = JSON.parse(text) as {
      pid?: unknown;
      at?: unknown;
      lockDir?: { ino?: unknown; birthtimeMs?: unknown; birthtimeNs?: unknown };
    };
    const dir = parsed.lockDir;
    return {
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined,
      at: typeof parsed.at === "string" ? parsed.at : undefined,
      lockDir:
        typeof dir === "object" &&
        dir !== null &&
        typeof dir.ino === "string" &&
        typeof dir.birthtimeMs === "string" &&
        typeof dir.birthtimeNs === "string"
          ? { ino: dir.ino, birthtimeMs: dir.birthtimeMs, birthtimeNs: dir.birthtimeNs }
          : undefined,
    };
  } catch {
    return { pid: undefined, at: undefined, lockDir: undefined };
  }
}

function baseOptions(paths: FactoryPaths, tuning: LockTuning) {
  return { lockfilePath: paths.lock, realpath: false, stale: tuning.stale ?? DEFAULT_STALE_MS } as const;
}

/** The current holder per proper-lockfile's `check` (fresh lock directory), named by the owner file. */
export async function readLockHolder(
  paths: FactoryPaths,
  tuning: LockTuning = {},
): Promise<{ path: string; pid: number | undefined; at: string | undefined } | undefined> {
  if (!(await lockfile.check(paths.home, baseOptions(paths, tuning)))) {
    // The lender is gone but its borrower still holds the lease (R17 amended).
    const lease = await readLease(paths);
    return lease?.fresh ? { path: paths.lock, pid: lease.pid, at: undefined } : undefined;
  }
  const owner = await readOwner(paths);
  return { path: paths.lock, pid: owner?.pid, at: owner?.at };
}

const sameDir = (a: LockDirId | undefined, b: LockDirId | undefined): boolean =>
  a !== undefined && b !== undefined && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && a.birthtimeNs === b.birthtimeNs;

/**
 * A borrow is granted only when all hold: the lock is held (fresh per `check`), the owner file names
 * `ownerPid`, `ownerPid` is alive, and the owner file was written for the current lock directory.
 * Returns that directory's identity, or undefined when the lock cannot be borrowed.
 */
async function borrowable(paths: FactoryPaths, ownerPid: number, tuning: LockTuning): Promise<LockDirId | undefined> {
  if (!(await lockfile.check(paths.home, baseOptions(paths, tuning)))) return undefined;
  const owner = await readOwner(paths);
  if (owner?.pid !== ownerPid || owner.lockDir === undefined || !isPidAlive(ownerPid)) return undefined;
  return sameDir(await lockDirId(paths), owner.lockDir) ? owner.lockDir : undefined;
}

/** Why the lender no longer holds the lock directory `dir` it lent, or undefined while it does. */
async function lenderLoss(paths: FactoryPaths, ownerPid: number, dir: LockDirId): Promise<string | undefined> {
  try {
    if (!isPidAlive(ownerPid)) return `the parent factory process ${ownerPid} that lent it has ended`;
    if (!sameDir(await lockDirId(paths), dir)) return `the lock directory lent by process ${ownerPid} was removed or replaced by another acquisition`;
    const owner = await readOwner(paths);
    if (owner?.pid !== ownerPid || !sameDir(owner.lockDir, dir)) return `the lock owner file no longer names process ${ownerPid}`;
    return undefined;
  } catch (e) {
    return `it could not be checked (${e instanceof Error ? e.message : String(e)})`;
  }
}

function borrowedLock(paths: FactoryPaths, ownerPid: number, dir: LockDirId, tuning: LockTuning, leaseId: string, stopRecording: () => void): Lock {
  const controller = new AbortController();
  const stale = tuning.stale ?? DEFAULT_STALE_MS;
  const leaseTimer = setInterval(
    () => {
      const now = new Date();
      void utimes(borrowerLeasePath(paths), now, now).catch(() => {});
    },
    Math.max(500, Math.min(tuning.update ?? DEFAULT_UPDATE_MS, Math.floor(stale / 2))),
  );
  leaseTimer.unref();
  let lost: LockLost | undefined;
  const check = async (): Promise<void> => {
    if (lost) return;
    const why = await lenderLoss(paths, ownerPid, dir);
    if (why === undefined || lost) return;
    lost = new LockLost(paths.lock, why);
    controller.abort(lost);
  };
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void check().finally(() => {
      checking = false;
    });
  }, tuning.borrowCheck ?? DEFAULT_BORROW_CHECK_MS);
  timer.unref();
  return {
    path: paths.lock,
    pid: ownerPid,
    borrowed: true,
    get compromised() {
      return lost;
    },
    lost: controller.signal,
    async verify() {
      await check();
      if (lost) throw lost;
    },
    async release() {
      clearInterval(timer);
      clearInterval(leaseTimer);
      stopRecording();
      // The last holder releases: our lease goes, whatever became of the lender.
      if ((await readLease(paths))?.id === leaseId) await rm(borrowerLeasePath(paths), { force: true });
    },
  };
}

/** Writes this borrower's lease, then re-checks the lender (see the header). Undefined when the borrow must be refused. */
async function takeLease(paths: FactoryPaths, ownerPid: number, tuning: LockTuning): Promise<{ dir: LockDirId; id: string } | undefined> {
  const id = randomBytes(8).toString("hex");
  await writeJsonAtomic(borrowerLeasePath(paths), { pid: process.pid, lenderPid: ownerPid, id, at: new Date().toISOString(), staleMs: tuning.stale ?? DEFAULT_STALE_MS });
  const dir = await borrowable(paths, ownerPid, tuning);
  if (dir !== undefined) return { dir, id };
  if ((await readLease(paths))?.id === id) await rm(borrowerLeasePath(paths), { force: true });
  return undefined;
}

export async function acquireLock(
  paths: FactoryPaths,
  opts: { ownerPid?: number } = {},
  tuning: LockTuning = {},
): Promise<Lock> {
  await mkdir(paths.home, { recursive: true });
  if (opts.ownerPid !== undefined) {
    const taken = (await borrowable(paths, opts.ownerPid, tuning)) === undefined ? undefined : await takeLease(paths, opts.ownerPid, tuning);
    if (taken !== undefined) return borrowedLock(paths, opts.ownerPid, taken.dir, tuning, taken.id, recordProcessGroupsIn(writerGroupsPath(paths)));
    if (await lockfile.check(paths.home, baseOptions(paths, tuning))) {
      throw new Locked(paths.lock, (await readOwner(paths).catch(() => undefined))?.pid);
    }
    // R17: the lender is gone; taking the lock here would continue its transaction unsupervised.
    throw new LockLost(paths.lock, `process ${opts.ownerPid}, which was to lend it, does not hold it (it ended or released the lock)`);
  }

  const controller = new AbortController();
  let compromised: Error | undefined;
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lockfile.lock(paths.home, {
      ...baseOptions(paths, tuning),
      update: tuning.update ?? DEFAULT_UPDATE_MS,
      retries: 0,
      // proper-lockfile's default throws from a timer (an uncaught exception); record it instead.
      onCompromised: (e: Error) => {
        compromised = e;
        controller.abort(e);
      },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Locked(paths.lock, (await readOwner(paths).catch(() => undefined))?.pid);
    }
    throw e;
  }

  // R17 amended: the directory may be free while a borrower or an orphaned installer still writes.
  let busy: Locked | undefined;
  try {
    busy = await inUseByWriter(paths);
  } catch (checkError) {
    await releaseLock();
    throw checkError;
  }
  if (busy !== undefined) {
    await releaseLock();
    throw busy;
  }

  const owner = { pid: process.pid, at: new Date().toISOString() };
  let ownDir: LockDirId;
  try {
    const lockDir = await lockDirId(paths);
    if (lockDir === undefined) throw new Error(`The factory lock directory ${paths.lock} vanished right after it was acquired.`);
    ownDir = lockDir;
    await writeJsonAtomic(ownerFilePath(paths), { ...owner, lockDir });
  } catch (writeError) {
    try {
      await releaseLock();
    } catch (releaseError) {
      throw new AggregateError([writeError, releaseError], "Could not record the factory lock owner nor release the lock");
    }
    throw writeError;
  }

  let released = false;
  const stopRecording = recordProcessGroupsIn(writerGroupsPath(paths));
  return {
    path: paths.lock,
    pid: process.pid,
    borrowed: false,
    get compromised() {
      return compromised;
    },
    lost: controller.signal,
    async verify() {
      if (compromised) throw compromised;
      if (!sameDir(await lockDirId(paths), ownDir)) {
        compromised = new LockLost(paths.lock, "its lock directory was removed or replaced by another acquisition");
        controller.abort(compromised);
        throw compromised;
      }
    },
    async release() {
      stopRecording();
      if (compromised) throw compromised;
      if (released) return;
      released = true;
      const current = await readOwner(paths);
      if (current?.pid === owner.pid && current.at === owner.at) await rm(ownerFilePath(paths), { force: true });
      // The lease of our borrower once it has exited (a live borrower keeps holding the lock).
      const lease = await readLease(paths);
      if (lease !== undefined && lease.lenderPid === process.pid && (lease.pid === undefined || !isPidAlive(lease.pid))) {
        await rm(borrowerLeasePath(paths), { force: true });
      }
      await releaseLock();
    },
  };
}
