import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock, borrowerLeasePath, isPidAlive, Locked, LockLost, ownerFilePath, readLockHolder, writerGroupsPath } from "../../../src/adapters/store/lock.ts";
import { deadPid } from "../../helpers/dead-pid.ts";
import { processGroupAlive, recordedProcessGroups, stopRecordedProcessGroups, WRITER_TOKEN_ENV } from "../../../src/adapters/platform/process.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
const children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await makeTmp("lock");
  env = isolatedEnv(tmp.dir);
  paths = factoryPaths(env);
});
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      const exited = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");
      await exited;
    }
  }
  await tmp.cleanup();
});

const FAST = { stale: 2000, update: 1000 };

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Spawns a child that holds the lock with FAST tuning; resolves once it reports "held". */
async function childHolder(): Promise<ChildProcess> {
  const fixture = fileURLToPath(new URL("../../fixtures/proc/hold-lock.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "jiti/register", fixture, String(FAST.stale), String(FAST.update)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let err = "";
  child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("held")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`holder exited (${code}): ${err}`)));
  });
  return child;
}

describe("isPidAlive", () => {
  it("is true for this process and false for an awaited child", async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(await deadPid())).toBe(false);
  });

  it("is false for non-positive or non-integer pids (never signals a process group)", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(isPidAlive(pid)).toBe(false);
  });
});

describe("acquireLock", () => {
  it("creates the lock and the owner file with this pid; release removes both", async () => {
    const lock = await acquireLock(paths);
    expect(lock.borrowed).toBe(false);
    expect(existsSync(paths.lock)).toBe(true);
    const owner = JSON.parse(await readFile(ownerFilePath(paths), "utf8")) as { pid: number; at: string };
    expect(owner.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(owner.at))).toBe(false);
    expect(await readLockHolder(paths)).toMatchObject({ pid: process.pid });
    await lock.release();
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(ownerFilePath(paths))).toBe(false);
    expect(await readLockHolder(paths)).toBeUndefined();
  });

  it("lets exactly one of many concurrent acquirers win", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(paths)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(Locked);
    for (const r of results) if (r.status === "fulfilled") await r.value.release();
  });

  it("throws Locked carrying the holder pid from the owner file", async () => {
    const child = await childHolder();
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBe(child.pid);
    expect(await readLockHolder(paths, FAST)).toMatchObject({ pid: child.pid });
  });

  it("stays held while the holder refreshes it and is taken over after the holder is killed", async () => {
    const child = await childHolder();
    await new Promise((r) => setTimeout(r, FAST.stale + 700)); // longer than stale: the heartbeat keeps it fresh
    await expect(acquireLock(paths, {}, FAST)).rejects.toBeInstanceOf(Locked);

    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    const lock = await until(() => acquireLock(paths, {}, FAST).catch((e: unknown) => {
      if (e instanceof Locked) return undefined;
      throw e;
    }), 10_000);
    expect(JSON.parse(await readFile(ownerFilePath(paths), "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("borrows the lock when its holder is ownerPid; release leaves the owner's lock", async () => {
    const owner = await acquireLock(paths);
    const borrowed = await acquireLock(paths, { ownerPid: process.pid });
    expect(borrowed.borrowed).toBe(true);
    await borrowed.release();
    expect(existsSync(paths.lock)).toBe(true);
    expect(await readLockHolder(paths)).toMatchObject({ pid: process.pid });
    await owner.release();
  });

  it("does not borrow from a different holder", async () => {
    const child = await childHolder();
    const err = await acquireLock(paths, { ownerPid: process.pid }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBe(child.pid);
  });

  it("a borrower whose lender no longer holds the lock never takes the lock itself (R17)", async () => {
    const dead = await deadPid();
    const err = await acquireLock(paths, { ownerPid: dead }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockLost);
    expect((err as Error).message).toContain(`process ${dead}`);
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("records a compromised lock without crashing and release() throws it", async () => {
    const lock = await acquireLock(paths, {}, FAST);
    await rm(paths.lock, { recursive: true, force: true }); // someone removed the lock under us
    const compromised = await until(async () => lock.compromised, 10_000);
    expect((compromised as NodeJS.ErrnoException).code).toBe("ECOMPROMISED");
    await expect(lock.release()).rejects.toBe(compromised);
  });

  it("leaves an owner file that is no longer its own on release", async () => {
    const lock = await acquireLock(paths);
    const foreign = `${JSON.stringify({ pid: 1, at: "2000-01-01T00:00:00.000Z" })}\n`;
    await writeFile(ownerFilePath(paths), foreign);
    await lock.release();
    expect(await readFile(ownerFilePath(paths), "utf8")).toBe(foreign);
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("review r3 interleaving: a stale owner file of a dead pid never lends another process's fresh lock", async () => {
    // A exited leaving its owner file; B has just created the lock directory and not yet published its owner file.
    const dead = await deadPid();
    await mkdir(paths.home, { recursive: true });
    await writeFile(ownerFilePath(paths), `${JSON.stringify({ pid: dead, at: "2026-10-31T00:00:00.000Z" })}\n`);
    await mkdir(paths.lock);
    const err = await acquireLock(paths, { ownerPid: dead }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect(existsSync(paths.lock)).toBe(true);
  });

  it("refuses to borrow when the owner pid is alive but the owner file names another lock directory", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(
      ownerFilePath(paths),
      `${JSON.stringify({ pid: process.pid, at: "2026-10-31T00:00:00.000Z", lockDir: { ino: "1", birthtimeMs: "0" } })}\n`,
    );
    await mkdir(paths.lock);
    await expect(acquireLock(paths, { ownerPid: process.pid })).rejects.toBeInstanceOf(Locked);
  });

  it("refuses to borrow from an owner file without lock directory identity", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(ownerFilePath(paths), `${JSON.stringify({ pid: process.pid, at: "2026-10-31T00:00:00.000Z" })}\n`);
    await mkdir(paths.lock);
    await expect(acquireLock(paths, { ownerPid: process.pid })).rejects.toBeInstanceOf(Locked);
  });

  it("refuses to borrow after the owner's lock directory was replaced by another acquisition", async () => {
    const owner = await acquireLock(paths);
    const recorded = await readFile(ownerFilePath(paths), "utf8");
    await owner.release();
    await mkdir(paths.lock); // a new acquisition's directory, before it publishes its owner file
    await writeFile(ownerFilePath(paths), recorded); // the previous owner's metadata is still there
    await expect(acquireLock(paths, { ownerPid: process.pid })).rejects.toBeInstanceOf(Locked);
  });

  it("refuses to borrow when only the nanosecond birth time differs (inode reused within the same millisecond)", async () => {
    const owner = await acquireLock(paths);
    const recorded = JSON.parse(await readFile(ownerFilePath(paths), "utf8")) as { lockDir: Record<string, string> };
    recorded.lockDir.birthtimeNs = (BigInt(recorded.lockDir.birthtimeNs as string) + 1n).toString();
    await writeFile(ownerFilePath(paths), JSON.stringify(recorded));
    await expect(acquireLock(paths, { ownerPid: process.pid })).rejects.toBeInstanceOf(Locked);
    await owner.release();
  });

  it("records the lock directory identity in the owner file", async () => {
    const lock = await acquireLock(paths);
    const owner = JSON.parse(await readFile(ownerFilePath(paths), "utf8")) as { lockDir: Record<string, string> };
    const st = await stat(paths.lock, { bigint: true });
    expect(owner.lockDir).toEqual({
      ino: st.ino.toString(),
      birthtimeMs: st.birthtimeMs.toString(),
      birthtimeNs: st.birthtimeNs.toString(),
    });
    await lock.release();
  });
});

describe("borrowed lock lifetime (R17)", () => {
  const POLL = { borrowCheck: 100 };

  it("verify() passes while the lender holds the same lock directory", async () => {
    const owner = await acquireLock(paths);
    const borrowed = await acquireLock(paths, { ownerPid: process.pid }, POLL);
    await expect(borrowed.verify()).resolves.toBeUndefined();
    expect(borrowed.lost.aborted).toBe(false);
    expect(borrowed.compromised).toBeUndefined();
    await borrowed.release();
    await owner.release();
  });

  it("detects a replaced lock directory: verify() throws LockLost and the lost signal aborts", async () => {
    const owner = await acquireLock(paths);
    const borrowed = await acquireLock(paths, { ownerPid: process.pid }, POLL);
    await owner.release();
    await mkdir(paths.lock); // another directory now stands where the lent one was
    await expect(borrowed.verify()).rejects.toBeInstanceOf(LockLost);
    await until(async () => (borrowed.lost.aborted ? true : undefined), 5_000);
    expect(borrowed.lost.reason).toBeInstanceOf(LockLost);
    expect(borrowed.compromised).toBeInstanceOf(LockLost);
    await borrowed.release(); // stops the watchdog; never touches the other directory
    expect(existsSync(paths.lock)).toBe(true);
    await rm(paths.lock, { recursive: true, force: true });
  });

  it("detects a lender that died (SIGKILL) while its stale lock directory is still in place", async () => {
    const child = await childHolder();
    const borrowed = await acquireLock(paths, { ownerPid: child.pid as number }, { ...FAST, ...POLL });
    expect(borrowed.borrowed).toBe(true);
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    expect(existsSync(paths.lock)).toBe(true);
    await until(async () => (borrowed.lost.aborted ? true : undefined), 5_000);
    const err = await borrowed.verify().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockLost);
    expect((err as Error).message).toContain(`${child.pid}`);
    await borrowed.release();
  });

  it("an owned lock's verify() throws once its directory was replaced", async () => {
    const lock = await acquireLock(paths);
    await rm(paths.lock, { recursive: true, force: true });
    await mkdir(paths.lock);
    await expect(lock.verify()).rejects.toBeInstanceOf(LockLost);
    await rm(paths.lock, { recursive: true, force: true });
  });
});

describe("borrower lease and writer groups (R17 amended)", () => {
  it("while the borrower's lease is fresh nobody can take the lock, even after the lender's lock is gone", async () => {
    const lender = await acquireLock(paths);
    const borrowed = await acquireLock(paths, { ownerPid: process.pid });
    expect(existsSync(borrowerLeasePath(paths))).toBe(true);
    await lender.release(); // the lender ends first; its borrower (alive) keeps the lease
    expect(existsSync(borrowerLeasePath(paths))).toBe(true);
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBe(process.pid);
    expect(existsSync(paths.lock)).toBe(false); // the refused acquirer gave the lock directory back
    await borrowed.release(); // the last holder releases
    expect(existsSync(borrowerLeasePath(paths))).toBe(false);
    await (await acquireLock(paths)).release();
  });

  it("the borrower refreshes its lease like an owner, so it never goes stale while the borrower runs", async () => {
    const lender = await acquireLock(paths, {}, FAST);
    const borrowed = await acquireLock(paths, { ownerPid: process.pid }, FAST);
    await lender.release();
    await new Promise((r) => setTimeout(r, FAST.stale + 700));
    await expect(acquireLock(paths, {}, FAST)).rejects.toBeInstanceOf(Locked);
    await borrowed.release();
  });

  it("a stale lease (its borrower stopped refreshing) does not block, and is removed", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(borrowerLeasePath(paths), JSON.stringify({ pid: process.pid, lenderPid: process.pid, staleMs: 2000 }));
    const old = new Date(Date.now() - 60_000);
    await utimes(borrowerLeasePath(paths), old, old);
    const lock = await acquireLock(paths);
    expect(existsSync(borrowerLeasePath(paths))).toBe(false);
    await lock.release();
  });

  it("the lender's release removes the lease of a borrower that has exited", async () => {
    const lender = await acquireLock(paths);
    const dead = await deadPid();
    await writeFile(borrowerLeasePath(paths), JSON.stringify({ pid: dead, lenderPid: process.pid, staleMs: 10_000 }));
    await lender.release();
    expect(existsSync(borrowerLeasePath(paths))).toBe(false);
    await (await acquireLock(paths)).release();
  });

  it.skipIf(process.platform === "win32")("a recorded writer process group that is still alive blocks the lock; dead entries are cleaned", async () => {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { ...process.env, [WRITER_TOKEN_ENV]: "tok-l" } });
    children.push(sleeper);
    await mkdir(writerGroupsPath(paths), { recursive: true });
    await writeFile(join(writerGroupsPath(paths), String(sleeper.pid)), "tok-l");
    await new Promise((r) => setTimeout(r, 200));
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Error).message).toContain(`process group ${sleeper.pid}`);
    expect(existsSync(paths.lock)).toBe(false);
    const exited = new Promise((r) => sleeper.once("exit", r));
    sleeper.kill("SIGKILL");
    await exited;
    const lock = await acquireLock(paths);
    expect(existsSync(join(writerGroupsPath(paths), String(sleeper.pid)))).toBe(false);
    await lock.release();
  });

  it.skipIf(process.platform === "win32")(
    "schedule (R21-P1): a live tokenless descendant whose recorded leader exited → Locked naming the group, record kept, never signalled",
    async () => {
      const fixture = fileURLToPath(new URL("../../fixtures/proc/tokenless-descendant.mjs", import.meta.url));
      const pidFile = join(tmp.dir, "descendant.pid");
      const termFile = join(tmp.dir, "descendant.sigterm");
      // The recorded group leader carries the token; its descendant was started with a clean environment.
      const leader = spawn(process.execPath, [fixture, pidFile, termFile], { detached: true, stdio: "ignore", env: { ...process.env, [WRITER_TOKEN_ENV]: "tok-d" } });
      children.push(leader);
      const pgid = leader.pid as number;
      await new Promise((r) => leader.once("exit", r)); // the leader is gone; its group is not
      const descendant = Number(await readFile(pidFile, "utf8"));
      try {
        expect(processGroupAlive(pgid)).toBe(true);
        await mkdir(writerGroupsPath(paths), { recursive: true });
        await writeFile(join(writerGroupsPath(paths), String(pgid)), "tok-d");

        const err = await acquireLock(paths).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Locked);
        expect((err as Error).message).toContain(`process group ${pgid}`);
        expect((err as Error).message).toContain(join(writerGroupsPath(paths), String(pgid)));
        expect(existsSync(paths.lock)).toBe(false);
        expect(await recordedProcessGroups(writerGroupsPath(paths))).toEqual([pgid]);

        if (process.platform === "linux") {
          // Lender cleanup: no positive identity → not signalled, record kept, reported as surviving.
          expect(await stopRecordedProcessGroups(writerGroupsPath(paths))).toEqual([pgid]);
          await new Promise((r) => setTimeout(r, 300));
          expect(isPidAlive(descendant)).toBe(true);
          expect(existsSync(termFile)).toBe(false);
          expect(await recordedProcessGroups(writerGroupsPath(paths))).toEqual([pgid]);
        }
      } finally {
        if (isPidAlive(descendant)) process.kill(descendant, "SIGKILL");
      }
      // Once the writer is gone, the record is cleaned and the lock is available again.
      for (let i = 0; i < 50 && processGroupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 50));
      const lock = await acquireLock(paths);
      expect(await recordedProcessGroups(writerGroupsPath(paths))).toEqual([]);
      await lock.release();
    },
  );
});
