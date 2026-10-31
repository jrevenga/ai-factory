import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock, isPidAlive, Locked, ownerFilePath, readLockHolder } from "../../../src/adapters/store/lock.ts";
import { deadPid } from "../../helpers/dead-pid.ts";
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

  it("does not borrow from a different holder, and acquires normally when the lock is free", async () => {
    const child = await childHolder();
    const err = await acquireLock(paths, { ownerPid: process.pid }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBe(child.pid);

    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    await rm(paths.lock, { recursive: true, force: true });
    const lock = await acquireLock(paths, { ownerPid: 12345 });
    expect(lock.borrowed).toBe(false);
    await lock.release();
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
});
