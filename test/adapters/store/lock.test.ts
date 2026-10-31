import { existsSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock, isPidAlive, Locked } from "../../../src/adapters/store/lock.ts";
import { deadPid } from "../../helpers/dead-pid.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;
let paths: FactoryPaths;

beforeEach(async () => {
  tmp = await makeTmp("lock");
  paths = factoryPaths(isolatedEnv(tmp.dir));
});
afterEach(async () => {
  await tmp.cleanup();
});

async function writeHolder(pid: number, at = new Date().toISOString()): Promise<void> {
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.lock, `${JSON.stringify({ pid, at })}\n`);
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
  it("creates the lock file with this pid and removes it on release", async () => {
    const lock = await acquireLock(paths);
    const content = JSON.parse(await readFile(paths.lock, "utf8")) as { pid: number; at: string };
    expect(content.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(content.at))).toBe(false);
    expect(lock.borrowed).toBe(false);
    await lock.release();
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("throws Locked with the holder pid when a live process holds it", async () => {
    await writeHolder(process.pid);
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect(err).toMatchObject({ pid: process.pid });
    expect(JSON.parse(await readFile(paths.lock, "utf8")).pid).toBe(process.pid);
  });

  it("replaces a lock held by a dead pid", async () => {
    const dead = await deadPid();
    await writeHolder(dead);
    const lock = await acquireLock(paths);
    expect(JSON.parse(await readFile(paths.lock, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("is acquired (borrowed) when the holder is ownerPid, and release leaves the owner's lock", async () => {
    await writeHolder(process.pid);
    const before = await readFile(paths.lock, "utf8");
    const lock = await acquireLock(paths, { ownerPid: process.pid });
    expect(lock.borrowed).toBe(true);
    await lock.release();
    expect(await readFile(paths.lock, "utf8")).toBe(before);
  });

  it("lets exactly one of many concurrent acquirers win", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(paths)));
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(Locked);
  });

  it("lets exactly one of many concurrent acquirers take over a stale lock", async () => {
    await writeHolder(await deadPid());
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(paths)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(Locked);
  });

  it("never deletes a lock that was replaced after it was judged stale", async () => {
    await writeHolder(await deadPid());
    const live = `${JSON.stringify({ pid: process.pid, at: "2026-10-31T00:00:00.000Z" })}\n`;
    const err = await acquireLock(paths, {}, { beforeTakeover: () => writeFile(paths.lock, live) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBe(process.pid);
    expect(await readFile(paths.lock, "utf8")).toBe(live);
  });

  it("leaves a stale lock alone while another process holds a fresh takeover marker", async () => {
    const dead = await deadPid();
    await writeHolder(dead);
    const before = await readFile(paths.lock, "utf8");
    await writeFile(`${paths.lock}.takeover`, "");
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBe(dead);
    expect(await readFile(paths.lock, "utf8")).toBe(before);
  });

  it("does not remove a lock it no longer owns on release", async () => {
    const lock = await acquireLock(paths);
    await writeHolder(process.pid, "2000-01-01T00:00:00.000Z");
    await lock.release();
    expect(JSON.parse(await readFile(paths.lock, "utf8")).at).toBe("2000-01-01T00:00:00.000Z");
  });

  it("treats a freshly written malformed lock as held and an old malformed lock as stale", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.lock, "");
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBeUndefined();

    const old = new Date(Date.now() - 60_000);
    await utimes(paths.lock, old, old);
    const lock = await acquireLock(paths);
    expect(JSON.parse(await readFile(paths.lock, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("removes an abandoned takeover marker and proceeds", async () => {
    await writeHolder(await deadPid());
    await writeFile(`${paths.lock}.takeover`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${paths.lock}.takeover`, old, old);
    const lock = await acquireLock(paths);
    expect(existsSync(`${paths.lock}.takeover`)).toBe(false);
    await lock.release();
  });
});
