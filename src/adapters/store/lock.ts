// The factory lock, held by install/update/rollback and briefly by session registration so an update
// never runs alongside a starting session (controller ruling R5: no hand-rolled mutual exclusion).
//
// Mutual exclusion is proper-lockfile's (the same library and protocol Pi uses for its settings):
// `<home>/factory.lock` is its lock directory, created with an atomic mkdir, kept fresh by a heartbeat
// (mtime update every `update` ms) and considered stale once its mtime is older than `stale` ms, i.e.
// after the holder stopped refreshing (crash, kill). `<home>/factory.lock.owner.json` (`{ pid, at }`)
// is informational only: written by the holder right after acquiring, it names the holder in `Locked`
// and enables borrowing by a child process (`ownerPid`). It never decides who holds the lock.
import lockfile from "proper-lockfile";
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeJsonAtomic } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_UPDATE_MS = 5_000;

export class Locked extends Error {
  readonly path: string;
  /** The holder's pid from the owner file, or undefined if it has not written one (yet). */
  readonly pid: number | undefined;
  constructor(path: string, pid: number | undefined) {
    super(
      pid === undefined
        ? `Another factory process holds the factory lock ${path}: an install, update or rollback is in progress. Wait for it to finish and retry.`
        : `Another factory process (pid ${pid}) holds the factory lock ${path}: an install, update or rollback is in progress. Wait for it to finish and retry.`,
    );
    this.name = "Locked";
    this.path = path;
    this.pid = pid;
  }
}

export interface Lock {
  path: string;
  /** Pid of the holder (this process, or `ownerPid` when borrowed). */
  pid: number;
  /** True when the lock belongs to `ownerPid` (a parent factory process); release() then leaves it. */
  borrowed: boolean;
  /**
   * Set when proper-lockfile reports the lock compromised (its directory was removed or could not be
   * refreshed within `stale`, so another process may now hold it). Long operations should check it
   * before mutating; release() throws it instead of releasing.
   */
  readonly compromised: Error | undefined;
  /** Removes the owner file (if still ours) and releases the lock. Errors propagate. */
  release(): Promise<void>;
}

/** Heartbeat tuning; production uses the defaults (stale 10 s, update 5 s). proper-lockfile enforces stale ≥ 2 s, update ≥ 1 s. */
export interface LockTuning {
  stale?: number;
  update?: number;
}

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

interface Owner {
  pid: number | undefined;
  at: string | undefined;
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
    const parsed = JSON.parse(text) as { pid?: unknown; at?: unknown };
    return {
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined,
      at: typeof parsed.at === "string" ? parsed.at : undefined,
    };
  } catch {
    return { pid: undefined, at: undefined };
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
  if (!(await lockfile.check(paths.home, baseOptions(paths, tuning)))) return undefined;
  const owner = await readOwner(paths);
  return { path: paths.lock, pid: owner?.pid, at: owner?.at };
}

export async function acquireLock(
  paths: FactoryPaths,
  opts: { ownerPid?: number } = {},
  tuning: LockTuning = {},
): Promise<Lock> {
  await mkdir(paths.home, { recursive: true });
  if (opts.ownerPid !== undefined) {
    const holder = await readLockHolder(paths, tuning);
    if (holder !== undefined && holder.pid === opts.ownerPid) {
      return { path: paths.lock, pid: opts.ownerPid, borrowed: true, compromised: undefined, release: async () => {} };
    }
  }

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
      },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Locked(paths.lock, (await readOwner(paths).catch(() => undefined))?.pid);
    }
    throw e;
  }

  const owner = { pid: process.pid, at: new Date().toISOString() };
  try {
    await writeJsonAtomic(ownerFilePath(paths), owner);
  } catch (writeError) {
    try {
      await releaseLock();
    } catch (releaseError) {
      throw new AggregateError([writeError, releaseError], "Could not record the factory lock owner nor release the lock");
    }
    throw writeError;
  }

  let released = false;
  return {
    path: paths.lock,
    pid: process.pid,
    borrowed: false,
    get compromised() {
      return compromised;
    },
    async release() {
      if (compromised) throw compromised;
      if (released) return;
      released = true;
      const current = await readOwner(paths);
      if (current?.pid === owner.pid && current.at === owner.at) await rm(ownerFilePath(paths), { force: true });
      await releaseLock();
    },
  };
}
