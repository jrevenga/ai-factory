// The factory lock, held by install/update/rollback and briefly by session registration so an update
// never runs alongside a starting session.
//
// Layout: `<home>/factory.lock/` holds generation records `<n>.json` (`{ pid, at, released? }`); the
// record with the highest `n` is the current lock. A single lock path cannot be both exclusive and
// recoverable from a crash, because deleting a stale file by path can delete a live lock created after
// the check. So nothing ever deletes or replaces the highest record except its own owner (release marks it
// `released` by atomic rename); the lock only moves forward:
//
//   1. List the generations; let `top` be the highest.
//   2. If `top` is held (pid alive, or unreadable and younger than MALFORMED_GRACE_MS: being written),
//      throw `Locked` (or borrow it when the holder is `ownerPid`). Otherwise it is free (released,
//      dead pid, or abandoned between create and write), and the candidate is `top + 1` (or 1 if none).
//   3. Exclusively create the candidate (`open(..., "wx")`): one process wins each generation.
//   4. Re-list. If the candidate is not the highest, back off (remove it) and start again.
//   5. Otherwise hold the lock; delete records below it (never the highest, so harmless).
//
// Why at most one process holds it: a holder of `m` saw `m - 1` free when it created `m` and saw `m` as
// the highest afterwards. A second holder of `n < m` would have verified before `m` existed, and `m`'s
// chain of creators then saw `n` free after that, which cannot happen while `n`'s owner is alive and has
// not released. Pid reuse can only make a dead holder look alive (fails safe as `Locked`).
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";

const MALFORMED_GRACE_MS = 5_000;
const MAX_ATTEMPTS = 50;
const RECORD = /^[1-9][0-9]{0,14}\.json$/;

export class Locked extends Error {
  readonly path: string;
  /** The holder's pid, or undefined while the lock record is still being written. */
  readonly pid: number | undefined;
  constructor(path: string, pid: number | undefined) {
    super(
      pid === undefined
        ? `The factory lock ${path} is being taken by another factory process. Retry in a moment.`
        : `Another factory process (pid ${pid}) holds the factory lock ${path}: an install, update or rollback is in progress. Wait for it to finish and retry.`,
    );
    this.name = "Locked";
    this.path = path;
    this.pid = pid;
  }
}

export interface Lock {
  /** The generation record this lock is (or borrows). */
  path: string;
  /** Pid recorded in the lock record. */
  pid: number;
  /** True when the lock belongs to `ownerPid` (a parent factory process); release() then leaves it. */
  borrowed: boolean;
  release(): Promise<void>;
}

/** Test seams: pause points inside acquisition. */
export interface LockDeps {
  /** After the current generation was judged free, before the next one is created. */
  afterJudgedFree?: () => Promise<void>;
  /** After the next generation was created, before it is verified as the highest. */
  afterCreate?: () => Promise<void>;
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

interface LockRecord {
  path: string;
  raw: string;
  pid: number | undefined;
  at: string | undefined;
  released: boolean;
  mtimeMs: number;
}

async function listGenerations(dir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((n) => RECORD.test(n))
    .map((n) => Number(n.slice(0, -".json".length)))
    .sort((a, b) => a - b);
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const { mtimeMs } = await handle.stat();
    const raw = await handle.readFile("utf8");
    let pid: number | undefined;
    let at: string | undefined;
    let released = false;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; at?: unknown; released?: unknown };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid;
      if (typeof parsed.at === "string") at = parsed.at;
      released = parsed.released === true;
    } catch {
      pid = undefined;
    }
    return { path, raw, pid, at, released, mtimeMs };
  } finally {
    await handle.close();
  }
}

function isFree(r: LockRecord): boolean {
  if (r.released) return true;
  if (r.pid !== undefined) return !isPidAlive(r.pid);
  return Date.now() - r.mtimeMs >= MALFORMED_GRACE_MS;
}

/** Exclusive create with full content; false if the file already exists. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (e) {
    await handle.close();
    await rm(path, { force: true });
    throw e;
  }
  await handle.close();
  return true;
}

const recordPath = (dir: string, gen: number): string => join(dir, `${gen}.json`);

/** The current holder, or undefined when the lock is free. */
export async function readLockHolder(paths: FactoryPaths): Promise<{ path: string; pid: number | undefined; at: string | undefined } | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const top = (await listGenerations(paths.lock)).at(-1);
    if (top === undefined) return undefined;
    const r = await readRecord(recordPath(paths.lock, top));
    if (r === undefined) continue;
    return isFree(r) ? undefined : { path: r.path, pid: r.pid, at: r.at };
  }
  throw new Error(`The factory lock ${paths.lock} keeps changing; retry.`);
}

export async function acquireLock(paths: FactoryPaths, opts: { ownerPid?: number } = {}, deps: LockDeps = {}): Promise<Lock> {
  const dir = paths.lock;
  await mkdir(dir, { recursive: true });
  const record = { pid: process.pid, at: new Date().toISOString() };
  const content = `${JSON.stringify(record)}\n`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const top = (await listGenerations(dir)).at(-1);
    let next = 1;
    if (top !== undefined) {
      const current = await readRecord(recordPath(dir, top));
      if (current === undefined) continue; // superseded and cleaned meanwhile
      if (!isFree(current)) {
        if (current.pid !== undefined && current.pid === opts.ownerPid) {
          return { path: current.path, pid: current.pid, borrowed: true, release: async () => {} };
        }
        throw new Locked(current.path, current.pid);
      }
      next = top + 1;
    }
    await deps.afterJudgedFree?.();
    const path = recordPath(dir, next);
    if (!(await createExclusive(path, content))) continue; // another process took this generation
    await deps.afterCreate?.();
    const after = await listGenerations(dir);
    if (after.at(-1) !== next) {
      await rm(path, { force: true }); // below the highest: irrelevant to everyone, safe to remove
      continue;
    }
    for (const gen of after) if (gen < next) await rm(recordPath(dir, gen), { force: true });
    let released = false;
    return {
      path,
      pid: process.pid,
      borrowed: false,
      async release() {
        if (released) return;
        released = true;
        const now = await readRecord(path);
        if (now?.raw !== content) return;
        // Stays the highest record, so the next acquirer moves to the next generation.
        await writeJsonAtomic(path, { ...record, released: true });
      },
    };
  }
  throw new Locked(dir, undefined);
}
