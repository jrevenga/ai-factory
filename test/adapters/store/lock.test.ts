import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock, isPidAlive, type Lock, Locked, readLockHolder } from "../../../src/adapters/store/lock.ts";
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

const gen = (n: number): string => join(paths.lock, `${n}.json`);

/** Plants generation record `n` as if another process had written it. */
async function plant(n: number, content: string): Promise<string> {
  await mkdir(paths.lock, { recursive: true });
  await writeFile(gen(n), content);
  return content;
}
const holder = (pid: number, at = new Date().toISOString()): string => `${JSON.stringify({ pid, at })}\n`;

async function records(): Promise<string[]> {
  return (await readdir(paths.lock)).sort();
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
  it("creates generation 1 with this pid and marks it released on release", async () => {
    const lock = await acquireLock(paths);
    expect(lock.path).toBe(gen(1));
    const content = JSON.parse(await readFile(gen(1), "utf8")) as { pid: number; at: string };
    expect(content.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(content.at))).toBe(false);
    expect(lock.borrowed).toBe(false);
    expect((await readLockHolder(paths))?.pid).toBe(process.pid);
    await lock.release();
    expect(JSON.parse(await readFile(gen(1), "utf8")).released).toBe(true);
    expect(await readLockHolder(paths)).toBeUndefined();
  });

  it("moves to the next generation after a release and removes older records", async () => {
    await (await acquireLock(paths)).release();
    const second = await acquireLock(paths);
    expect(second.path).toBe(gen(2));
    expect(await records()).toEqual(["2.json"]);
    await second.release();
  });

  it("throws Locked with the holder pid when a live process holds it", async () => {
    const live = await plant(1, holder(process.pid));
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect(err).toMatchObject({ pid: process.pid, path: gen(1) });
    expect(await readFile(gen(1), "utf8")).toBe(live);
    expect(await records()).toEqual(["1.json"]);
  });

  it("takes over a lock held by a dead pid by moving to the next generation", async () => {
    await plant(1, holder(await deadPid()));
    const lock = await acquireLock(paths);
    expect(lock.path).toBe(gen(2));
    expect(await records()).toEqual(["2.json"]);
    await lock.release();
  });

  it("is acquired (borrowed) when the holder is ownerPid, and release leaves the owner's lock", async () => {
    const live = await plant(1, holder(process.pid));
    const lock = await acquireLock(paths, { ownerPid: process.pid });
    expect(lock.borrowed).toBe(true);
    await lock.release();
    expect(await readFile(gen(1), "utf8")).toBe(live);
  });

  it("lets exactly one of many concurrent acquirers win", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(paths)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(Locked);
  });

  it("lets exactly one of many concurrent acquirers take over a stale lock", async () => {
    await plant(1, holder(await deadPid()));
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(paths)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(Locked);
  });

  it("does not mark a record it no longer owns as released", async () => {
    const lock = await acquireLock(paths);
    const other = await plant(1, holder(process.pid, "2000-01-01T00:00:00.000Z"));
    await lock.release();
    expect(await readFile(gen(1), "utf8")).toBe(other);
  });

  it("treats a freshly written malformed record as held and an old malformed record as free", async () => {
    await plant(1, "");
    const err = await acquireLock(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Locked);
    expect((err as Locked).pid).toBeUndefined();

    const old = new Date(Date.now() - 60_000);
    await utimes(gen(1), old, old);
    const lock = await acquireLock(paths);
    expect(lock.path).toBe(gen(2));
    await lock.release();
  });

  it("ignores files that are not generation records", async () => {
    await plant(1, holder(await deadPid()));
    await writeFile(join(paths.lock, "7.json.tmp-1-abc"), holder(process.pid));
    await writeFile(join(paths.lock, "notes.txt"), "x");
    const lock = await acquireLock(paths);
    expect(lock.path).toBe(gen(2));
    await lock.release();
  });

  it("a paused acquirer that judged the lock free and resumes after another won never holds it", async () => {
    let b: Lock | undefined;
    const a = await acquireLock(paths, {}, {
      afterJudgedFree: async () => {
        b ??= await acquireLock(paths);
      },
    }).catch((e: unknown) => e);
    expect(b).toBeDefined();
    expect(a).toBeInstanceOf(Locked);
    expect((await readLockHolder(paths))?.pid).toBe(process.pid);
    await b?.release();
    expect(await readLockHolder(paths)).toBeUndefined();
  });

  it("an acquirer overtaken by a higher generation before it verifies backs off", async () => {
    const higher = holder(process.pid, "2026-10-31T00:00:00.000Z");
    const a = await acquireLock(paths, {}, {
      afterCreate: async () => {
        await writeFile(gen(99), higher);
      },
    }).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(Locked);
    expect(await readFile(gen(99), "utf8")).toBe(higher);
    expect(await records()).toEqual(["99.json"]);
    expect(await readLockHolder(paths)).toMatchObject({ pid: process.pid, at: "2026-10-31T00:00:00.000Z" });
  });

  it("review r1 interleaving: a stale takeover paused while others take over, release and clean up never ends with two holders", async () => {
    await plant(1, holder(await deadPid()));
    let c: Lock | undefined;
    const a = await acquireLock(paths, {}, {
      afterJudgedFree: async () => {
        if (c) return;
        // While A is paused with candidate generation 2: B takes over and releases, then C takes over and
        // deletes every record below its own, so A's candidate path 2 is free again when A resumes.
        const b = await acquireLock(paths);
        expect(b.path).toBe(gen(2));
        await b.release();
        c = await acquireLock(paths);
        expect(c.path).toBe(gen(3));
        expect(await records()).toEqual(["3.json"]);
      },
    }).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(Locked);
    expect((a as Locked).path).toBe(gen(3));
    expect(await records()).toEqual(["3.json"]);
    expect(await readLockHolder(paths)).toMatchObject({ path: gen(3), pid: process.pid });
    await c?.release();
  });
});
