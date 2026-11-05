// Exclusive replay of the answer-route reconciles interrupted runs left in one work tree (Phase 2 Task 13, ruling R52;
// R61 keys it by the work tree instead of the run). Two Pi sessions must never replay the same work tree at once. Earlier designs renamed a shared lock path and kept racing (a contender acting on a
// stale view could displace or delete a live holder's lock). R52 never renames or deletes an entry whose owner might be
// alive:
//
// 1. Each contender creates its own entry in the work tree's owners directory (`replayOwnersDir`), named `<pid>-<start>-<random>` (never reused).
//    It is written to a temp file `.<name>.tmp` in the same directory and renamed into place, so a reader never sees
//    partial content.
// 2. Only after its entry exists does it list the directory and classify every other entry: dead (pid not alive, or a
//    recorded start identity that no longer matches) may be removed; live, unreadable or unparsable counts as live.
// 3. Any other live entry: it removes only its own entry and backs off (retried at a later startup). Otherwise it owns
//    the replay until it removes its own entry (finish or abort) or dies.
//
// Mutual exclusion: an owner's entry exists from before its listing until it releases, and no other process removes it
// while the owner lives. Of two overlapping owners, the one that listed later did so after both entries existed, so it
// saw the other's entry live and backed off. Two simultaneous contenders may both back off: exclusion over progress.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

/** `<project ledger dir>/replay.owners/<work tree key>/`: one entry per contender for a work tree's replay. */
export const REPLAY_OWNERS = "replay.owners";

/**
 * R61: the owners directory of the replay of `workTree` (the realpath a manifest records as its `root`) in the project
 * whose ledger directory is `projectLedgerDir`: keyed by a hash of the work tree, so every run's reconciles of one work
 * tree share one replay owner.
 */
export function replayOwnersDir(projectLedgerDir: string, workTree: string): string {
  return join(projectLedgerDir, REPLAY_OWNERS, createHash("sha256").update(workTree, "utf8").digest("hex").slice(0, 32));
}

const RUN_ID = /^\d{8}T\d{6}Z-(\d+)$/;
/** A temp entry: `.<pid>-<start>-<random>.tmp` (its writer has not yet listed, so it is not an owner). */
const TEMP = /^\.(\d+)-([^-]+)-[0-9a-f]+\.tmp$/;
const NO_START = "none";

/** The filesystem operations the protocol uses (a seam so tests can interleave contenders deterministically). */
export interface OwnersFs {
  mkdirp(dir: string): void;
  /** Create `path` exclusively with `text`, durably. */
  writeNew(path: string, text: string): void;
  rename(from: string, to: string): void;
  list(dir: string): string[];
  read(path: string): string;
  /** Remove a file; a missing file is not an error. */
  remove(path: string): void;
  exists(path: string): boolean;
}

export const nodeOwnersFs: OwnersFs = {
  mkdirp: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
  writeNew: (path, text) => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: (from, to) => renameSync(from, to),
  list: (dir) => readdirSync(dir),
  read: (path) => readFileSync(path, "utf8"),
  remove: (path) => {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  },
  exists: (path) => existsSync(path),
};

/**
 * The start time of process `pid` (Linux: field 22 of `/proc/<pid>/stat`, in clock ticks since boot), so a recorded
 * owner is not mistaken for an unrelated process that reused its pid. Undefined where it cannot be read.
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

export interface ClaimOptions {
  fs?: OwnersFs;
  /** A pid's current start identity (default: `processStart`, recorded only for this process's own pid). */
  startOf?(pid: number): string | undefined;
  /** The random part of the entry name (default: 16 hex characters). */
  random?(): string;
  now?(): Date;
}

/** The right to replay: `owns()` while the entry exists; `release()` removes it (best effort). */
export interface ReplayClaim {
  readonly entry: string;
  owns(): boolean;
  release(): void;
}

/** Pause points of a claim, for tests that interleave contenders: after the temp write, the rename, the listing and the classification. */
export type ClaimStep = "written" | "created" | "listed" | "classified";

/** A process that is gone, or whose pid now belongs to a process started at another time, never comes back. */
function dead(pid: number, start: string | undefined, isAlive: (pid: number) => boolean, startOf: (pid: number) => string | undefined): boolean {
  if (!isAlive(pid)) return true;
  if (start === undefined || start === NO_START) return false;
  const now = startOf(pid);
  return now !== undefined && now !== start;
}

const isNoEnt = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";

/**
 * R52, step by step: yields at each pause point and returns the claim, or undefined after backing off. `claimReplay`
 * runs it to completion; tests drive several at once.
 */
export function* claimSteps(ownersDir: string, selfRunId: string, isAlive: (pid: number) => boolean, opts: ClaimOptions = {}): Generator<ClaimStep, ReplayClaim | undefined, void> {
  const fs = opts.fs ?? nodeOwnersFs;
  const m = RUN_ID.exec(selfRunId);
  const pid = m ? Number(m[1]) : process.pid;
  const startOf = opts.startOf ?? processStart;
  const start = opts.startOf !== undefined ? opts.startOf(pid) : pid === process.pid ? processStart(pid) : undefined;
  const dir = ownersDir;
  const name = `${pid}-${start ?? NO_START}-${opts.random?.() ?? randomBytes(8).toString("hex")}`;
  const own = join(dir, name);
  const tmp = join(dir, `.${name}.tmp`);
  const text = `${JSON.stringify({ runId: selfRunId, pid, ...(start !== undefined ? { start } : {}), createdAt: (opts.now?.() ?? new Date()).toISOString() })}\n`;

  fs.mkdirp(dir);
  fs.writeNew(tmp, text);
  yield "written";
  try {
    fs.rename(tmp, own);
  } catch (e) {
    fs.remove(tmp);
    // The temp file was pruned (its writer was judged dead): this contender is not in the contest.
    if (isNoEnt(e)) return undefined;
    throw e;
  }
  yield "created";
  let blocked = false;
  try {
    const names = fs.list(dir);
    yield "listed";
    for (const n of names) {
      if (n === name) continue;
      const path = join(dir, n);
      if (n.startsWith(".")) {
        // Not an entry. A dead writer's leftover temp file is pruned; a live writer's is ignored.
        const t = TEMP.exec(n);
        if (t !== null && dead(Number(t[1]), t[2], isAlive, startOf)) fs.remove(path);
        continue;
      }
      let rec: { runId?: unknown; pid?: unknown; start?: unknown };
      try {
        rec = JSON.parse(fs.read(path)) as typeof rec;
      } catch (e) {
        // Gone since the listing: its owner released it or it was pruned as dead; either way it no longer owns.
        if (isNoEnt(e)) continue;
        blocked = true; // unreadable or unparsable: fail closed
        continue;
      }
      if (typeof rec !== "object" || rec === null || typeof rec.runId !== "string" || typeof rec.pid !== "number" || !Number.isSafeInteger(rec.pid)) {
        blocked = true;
        continue;
      }
      if (dead(rec.pid, typeof rec.start === "string" ? rec.start : undefined, isAlive, startOf)) fs.remove(path);
      else blocked = true;
    }
    yield "classified";
  } catch (e) {
    try {
      fs.remove(own);
    } catch {
      // The error below is what matters; a leftover entry is pruned once this process is gone.
    }
    throw e;
  }
  if (blocked) {
    fs.remove(own);
    return undefined;
  }
  return {
    entry: own,
    owns: () => {
      try {
        return fs.exists(own);
      } catch {
        return false;
      }
    },
    release: () => {
      try {
        fs.remove(own);
      } catch {
        // Left behind, the entry blocks others only while this process lives; it is pruned once the process is gone.
      }
    },
  };
}

/**
 * The exclusive right to replay the reconciles of the work tree whose owners directory is `ownersDir` (R52, R61:
 * `replayOwnersDir`). Undefined: another live (or
 * unreadable) entry exists, so a replay is in progress elsewhere or a contest was lost; retried at a later startup.
 * Throws on a filesystem error (the contender's own entry is removed first).
 */
export function claimReplay(ownersDir: string, selfRunId: string, isAlive: (pid: number) => boolean, opts: ClaimOptions = {}): ReplayClaim | undefined {
  const steps = claimSteps(ownersDir, selfRunId, isAlive, opts);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
