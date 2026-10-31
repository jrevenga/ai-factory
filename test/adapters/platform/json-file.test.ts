import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MalformedJson, readJson, renameWithRetry, writeJsonAtomic } from "../../../src/adapters/platform/json-file.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;

beforeEach(async () => {
  tmp = await makeTmp("json");
});

afterEach(async () => {
  await tmp.cleanup();
});

describe("readJson / writeJsonAtomic", () => {
  it("round-trips with 2-space indent and a trailing newline, leaving no temp files", async () => {
    const path = join(tmp.dir, "state.json");
    const value = { schema: 1, list: [1, "two"], nested: { a: null } };
    await writeJsonAtomic(path, value);
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(await readJson(path)).toEqual(value);
    await writeJsonAtomic(path, { schema: 2 });
    expect(await readJson(path)).toEqual({ schema: 2 });
    expect(await readdir(tmp.dir)).toEqual(["state.json"]);
  });

  it("returns undefined for a missing file", async () => {
    expect(await readJson(join(tmp.dir, "missing.json"))).toBeUndefined();
  });

  it("tolerates a UTF-8 BOM", async () => {
    const path = join(tmp.dir, "bom.json");
    await writeFile(path, '﻿{"a":1}');
    expect(await readJson(path)).toEqual({ a: 1 });
  });

  it("throws MalformedJson naming the path", async () => {
    const path = join(tmp.dir, "bad.json");
    await writeFile(path, "{bad");
    const error = await readJson(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MalformedJson);
    expect((error as MalformedJson).path).toBe(path);
    expect((error as Error).message).toContain(path);
  });
});

describe("renameWithRetry", () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it("retries EPERM/EBUSY on Windows", async () => {
    let calls = 0;
    const rename = async () => {
      calls++;
      if (calls < 3) throw busy(calls === 1 ? "EPERM" : "EBUSY");
    };
    await renameWithRetry("a", "b", { rename, platform: "win32", delayMs: 1 });
    expect(calls).toBe(3);
  });

  it("gives up after 5 retries", async () => {
    let calls = 0;
    const rename = async () => {
      calls++;
      throw busy("EPERM");
    };
    await expect(renameWithRetry("a", "b", { rename, platform: "win32", delayMs: 1 })).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(6);
  });

  it("does not retry on other platforms or other errors", async () => {
    let calls = 0;
    const rename = async () => {
      calls++;
      throw busy("EPERM");
    };
    await expect(renameWithRetry("a", "b", { rename, platform: "linux", delayMs: 1 })).rejects.toMatchObject({ code: "EPERM" });
    const enoent = async () => {
      calls++;
      throw busy("ENOENT");
    };
    await expect(renameWithRetry("a", "b", { rename: enoent, platform: "win32", delayMs: 1 })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(2);
  });
});
