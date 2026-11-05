// Launcher session records `sessions/<launcherPid>.json` (`{ launcherPid, piPid?, at }`), so update and
// rollback can refuse while a factory-launched Pi session is running.
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MalformedJson, readJson, writeJsonAtomic } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";
import { acquireLock, isPidAlive } from "./lock.ts";

const SessionRecord = z.looseObject({
  launcherPid: z.int().positive(),
  piPid: z.int().positive().optional(),
  at: z.string(),
});
type SessionRecord = z.infer<typeof SessionRecord>;

export interface Session {
  launcherPid: number;
  path: string;
  setPiPid(pid: number): Promise<void>;
  /** Removes the record; idempotent. */
  end(): Promise<void>;
}

/**
 * Registers this launcher. Takes the factory lock only while writing, so registration fails with
 * `Locked` while an install/update/rollback holds it, and an update that holds the lock sees every
 * session registered before it.
 */
export async function registerSession(paths: FactoryPaths, opts: { launcherPid?: number } = {}): Promise<Session> {
  const launcherPid = opts.launcherPid ?? process.pid;
  const path = join(paths.sessions, `${launcherPid}.json`);
  let record: SessionRecord = { launcherPid, at: new Date().toISOString() };
  const lock = await acquireLock(paths);
  try {
    await mkdir(paths.sessions, { recursive: true });
    await writeJsonAtomic(path, record);
  } finally {
    await lock.release();
  }
  return {
    launcherPid,
    path,
    async setPiPid(pid: number) {
      record = { ...record, piPid: pid };
      await writeJsonAtomic(path, record);
    },
    async end() {
      await rm(path, { force: true });
    },
  };
}

/**
 * Launcher pids of live sessions (launcher or Pi still alive), ascending. Stale and malformed records
 * are removed. Callers deciding whether an update may proceed call this while holding the factory lock,
 * so no session can register between the check and the update.
 */
export async function liveSessions(paths: FactoryPaths): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(paths.sessions);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const live: number[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const path = join(paths.sessions, name);
    let parsed: ReturnType<typeof SessionRecord.safeParse> | undefined;
    try {
      parsed = SessionRecord.safeParse(await readJson(path));
    } catch (e) {
      if (!(e instanceof MalformedJson)) throw e;
      parsed = undefined; // records are written atomically, so unparsable JSON is junk, not a partial write
    }
    const rec = parsed?.success ? parsed.data : undefined;
    if (rec && (isPidAlive(rec.launcherPid) || (rec.piPid !== undefined && isPidAlive(rec.piPid)))) {
      live.push(rec.launcherPid);
    } else {
      await rm(path, { force: true });
    }
  }
  return live.sort((a, b) => a - b);
}
