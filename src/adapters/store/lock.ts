// The factory lock `<home>/factory.lock` (`{ pid, at }`), held by install/update/rollback and briefly by
// session registration so an update never runs alongside a starting session.
//
// Acquisition is an exclusive create (`open(path, "wx")`): the filesystem lets exactly one process win.
// A lock whose holder pid is dead (or whose content is unreadable and older than MALFORMED_GRACE_MS, i.e.
// abandoned between create and write) is stale. Stale removal is serialized by a second exclusive marker,
// `<lock>.takeover`: only the marker holder may delete the lock, and only after re-reading it and finding
// the exact bytes it judged stale. A live lock is therefore never deleted by a takeover (its owner is
// alive, so it is never judged stale, and a lock recreated meanwhile has different bytes). Whoever then
// wins the plain `wx` create owns the lock. A marker older than TAKEOVER_STALE_MS was abandoned by a
// crash inside that short critical section and is removed; that removal is the one residual race.
import { mkdir, open, rm, stat } from "node:fs/promises";
import type { FactoryPaths } from "../platform/paths.ts";

const MALFORMED_GRACE_MS = 5_000;
const TAKEOVER_STALE_MS = 10_000;
const MAX_ATTEMPTS = 50;
const RETRY_MS = 20;

export class Locked extends Error {
  readonly path: string;
  /** The holder's pid, or undefined while the lock file is still being written. */
  readonly pid: number | undefined;
  constructor(path: string, pid: number | undefined) {
    super(
      pid === undefined
        ? `The factory lock ${path} is being taken by another factory process. Retry in a moment; if no factory process is running, remove that file.`
        : `Another factory process (pid ${pid}) holds the factory lock ${path}: an install, update or rollback is in progress. Wait for it to finish and retry.`,
    );
    this.name = "Locked";
    this.path = path;
    this.pid = pid;
  }
}

export interface Lock {
  path: string;
  /** Pid recorded in the lock file. */
  pid: number;
  /** True when the lock belongs to `ownerPid` (a parent factory process); release() then leaves it. */
  borrowed: boolean;
  release(): Promise<void>;
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

interface Holder {
  raw: string;
  pid: number | undefined;
  mtimeMs: number;
}

async function readHolder(path: string): Promise<Holder | undefined> {
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
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid;
    } catch {
      pid = undefined;
    }
    return { raw, pid, mtimeMs };
  } finally {
    await handle.close();
  }
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

/** Deletes the lock if it still holds `staleRaw`, under the takeover marker. False if another process is taking over. */
async function removeStale(lockPath: string, staleRaw: string): Promise<boolean> {
  const marker = `${lockPath}.takeover`;
  const mine = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  if (!(await createExclusive(marker, mine))) {
    try {
      const m = await stat(marker);
      if (Date.now() - m.mtimeMs > TAKEOVER_STALE_MS) await rm(marker, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return false;
  }
  try {
    const now = await readHolder(lockPath);
    if (now !== undefined && now.raw === staleRaw) await rm(lockPath, { force: true });
    return true;
  } finally {
    await rm(marker, { force: true });
  }
}

export interface LockDeps {
  /** Test seam: runs after a lock is judged stale and before the takeover re-checks and removes it. */
  beforeTakeover?: () => Promise<void>;
}

export async function acquireLock(paths: FactoryPaths, opts: { ownerPid?: number } = {}, deps: LockDeps = {}): Promise<Lock> {
  const path = paths.lock;
  await mkdir(paths.home, { recursive: true });
  const content = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  let lastPid: number | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await createExclusive(path, content)) {
      let released = false;
      return {
        path,
        pid: process.pid,
        borrowed: false,
        async release() {
          if (released) return;
          released = true;
          const holder = await readHolder(path);
          if (holder?.raw === content) await rm(path, { force: true });
        },
      };
    }
    const holder = await readHolder(path);
    if (holder === undefined) continue; // released meanwhile
    if (holder.pid !== undefined && isPidAlive(holder.pid)) {
      if (holder.pid === opts.ownerPid) {
        return { path, pid: holder.pid, borrowed: true, release: async () => {} };
      }
      throw new Locked(path, holder.pid);
    }
    if (holder.pid === undefined && Date.now() - holder.mtimeMs < MALFORMED_GRACE_MS) throw new Locked(path, undefined);
    lastPid = holder.pid;
    await deps.beforeTakeover?.();
    if (!(await removeStale(path, holder.raw))) await new Promise((r) => setTimeout(r, RETRY_MS));
  }
  throw new Locked(path, lastPid);
}
