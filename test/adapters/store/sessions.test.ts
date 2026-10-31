import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson } from "../../../src/adapters/platform/json-file.ts";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock, Locked } from "../../../src/adapters/store/lock.ts";
import { liveSessions, registerSession } from "../../../src/adapters/store/sessions.ts";
import { deadPid } from "../../helpers/dead-pid.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;
let paths: FactoryPaths;

beforeEach(async () => {
  tmp = await makeTmp("sessions");
  paths = factoryPaths(isolatedEnv(tmp.dir));
});
afterEach(async () => {
  await tmp.cleanup();
});

async function writeRecord(launcherPid: number, piPid?: number): Promise<string> {
  await mkdir(paths.sessions, { recursive: true });
  const p = join(paths.sessions, `${launcherPid}.json`);
  await writeFile(p, JSON.stringify({ launcherPid, piPid, at: new Date().toISOString() }));
  return p;
}

describe("registerSession", () => {
  it("writes sessions/<launcherPid>.json and releases the lock", async () => {
    const session = await registerSession(paths);
    expect(session.launcherPid).toBe(process.pid);
    const rec = (await readJson(join(paths.sessions, `${process.pid}.json`))) as Record<string, unknown>;
    expect(rec).toMatchObject({ launcherPid: process.pid });
    expect(rec.piPid).toBeUndefined();
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("propagates Locked while another holder has the lock and writes nothing", async () => {
    const held = await acquireLock(paths);
    try {
      await expect(registerSession(paths)).rejects.toBeInstanceOf(Locked);
      expect(existsSync(join(paths.sessions, `${process.pid}.json`))).toBe(false);
    } finally {
      await held.release();
    }
  });

  it("setPiPid records the Pi pid and end removes the record", async () => {
    const session = await registerSession(paths);
    await session.setPiPid(4242);
    const p = join(paths.sessions, `${process.pid}.json`);
    expect(((await readJson(p)) as { piPid: number }).piPid).toBe(4242);
    await session.end();
    expect(existsSync(p)).toBe(false);
    await expect(session.end()).resolves.toBeUndefined();
  });
});

describe("liveSessions", () => {
  it("is empty when there is no sessions directory", async () => {
    expect(await liveSessions(paths)).toEqual([]);
  });

  it("lists a record whose launcher is alive", async () => {
    await registerSession(paths);
    expect(await liveSessions(paths)).toEqual([process.pid]);
  });

  it("lists a record with a dead launcher but a live piPid", async () => {
    const dead = await deadPid();
    await writeRecord(dead, process.pid);
    expect(await liveSessions(paths)).toEqual([dead]);
  });

  it("removes a record whose launcher and piPid are both dead", async () => {
    const dead = await deadPid();
    const p = await writeRecord(dead, await deadPid());
    expect(await liveSessions(paths)).toEqual([]);
    expect(existsSync(p)).toBe(false);
  });

  it("removes malformed records and ignores non-record files", async () => {
    await mkdir(paths.sessions, { recursive: true });
    await writeFile(join(paths.sessions, "123.json"), "{not json");
    await writeFile(join(paths.sessions, "notes.txt"), "keep");
    expect(await liveSessions(paths)).toEqual([]);
    expect((await readdir(paths.sessions)).sort()).toEqual(["notes.txt"]);
  });
});
