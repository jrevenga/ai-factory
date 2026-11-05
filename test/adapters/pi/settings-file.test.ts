import lockfile from "proper-lockfile";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MalformedJson, readJson } from "../../../src/adapters/platform/json-file.ts";
import { factoryPaths } from "../../../src/adapters/platform/paths.ts";
import { applyManagedPiSettings, readPiSettings, SettingsLocked, withPiSettingsLock } from "../../../src/adapters/pi/settings-file.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;
let paths: ReturnType<typeof factoryPaths>;

beforeEach(async () => {
  tmp = await makeTmp("settings");
  paths = factoryPaths(isolatedEnv(tmp.dir));
});
afterEach(async () => {
  await tmp.cleanup();
});

describe("applyManagedPiSettings", () => {
  it("creates settings and the managed record when nothing exists", async () => {
    const changes = await applyManagedPiSettings(paths, "0.1.0");
    expect(changes.map((c) => c.action)).toEqual(["set", "set"]);
    expect(await readPiSettings(paths.piSettings)).toEqual({ enableInstallTelemetry: false, transport: "sse" });
    const record = (await readJson(paths.managedSettings)) as { schema: number; keys: Record<string, { value: unknown }> };
    expect(record.schema).toBe(1);
    expect(record.keys.transport?.value).toBe("sse");
  });

  it("is idempotent and preserves packages", async () => {
    await withPiSettingsLock(paths.piSettings, async () => ({ next: { packages: ["git:x@v1"] }, result: undefined }));
    await applyManagedPiSettings(paths, "0.1.0");
    const again = await applyManagedPiSettings(paths, "0.1.0");
    expect(again.map((c) => c.action)).toEqual(["unchanged", "unchanged"]);
    expect((await readPiSettings(paths.piSettings)).packages).toEqual(["git:x@v1"]);
  });

  it("respects a user change after the factory wrote the value", async () => {
    await applyManagedPiSettings(paths, "0.1.0");
    const cur = await readPiSettings(paths.piSettings);
    await writeFile(paths.piSettings, JSON.stringify({ ...cur, transport: "websocket" }));
    const changes = await applyManagedPiSettings(paths, "0.1.1");
    expect(changes.find((c) => c.key === "transport")?.action).toBe("kept-user-value");
    expect((await readPiSettings(paths.piSettings)).transport).toBe("websocket");
  });

  it("malformed settings: MalformedJson, bytes unchanged, no record written", async () => {
    await applyManagedPiSettings(paths, "0.1.0"); // creates dirs
    const bad = "{ not json";
    await writeFile(paths.piSettings, bad);
    const recordBefore = await readFile(paths.managedSettings, "utf8");
    await expect(applyManagedPiSettings(paths, "0.1.0")).rejects.toBeInstanceOf(MalformedJson);
    expect(await readFile(paths.piSettings, "utf8")).toBe(bad);
    expect(await readFile(paths.managedSettings, "utf8")).toBe(recordBefore);
  });

  it("while Pi's lock is held rejects with SettingsLocked and leaves bytes unchanged; succeeds after release", async () => {
    await applyManagedPiSettings(paths, "0.1.0");
    const original = await readFile(paths.piSettings, "utf8");
    const release = lockfile.lockSync(paths.piSettings, { realpath: false });
    let released = false;
    try {
      const err = await applyManagedPiSettings(paths, "0.1.1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SettingsLocked);
      expect((err as SettingsLocked).path).toBe(paths.piSettings);
      expect(await readFile(paths.piSettings, "utf8")).toBe(original);
      await writeFile(paths.piSettings, JSON.stringify({ ...JSON.parse(original), packages: ["git:y@v2"] }));
      release();
      released = true;
    } finally {
      if (!released) release();
    }
    await applyManagedPiSettings(paths, "0.1.1");
    expect((await readPiSettings(paths.piSettings)).packages).toEqual(["git:y@v2"]);
  });
});

describe("concurrency and release failures", () => {
  it("two concurrent first-time applies never lose ownership", async () => {
    const [a, b] = await Promise.all([applyManagedPiSettings(paths, "0.1.0"), applyManagedPiSettings(paths, "0.1.0")]);
    const all = [...a, ...b].map((c) => c.action).sort();
    expect(all).toEqual(["set", "set", "unchanged", "unchanged"]);
    const record = (await readJson(paths.managedSettings)) as { keys: Record<string, unknown> };
    expect(Object.keys(record.keys).sort()).toEqual(["enableInstallTelemetry", "transport"]);
  });

  it("propagates a release failure", async () => {
    const path = join(tmp.dir, "r.json");
    const lock = async () => async () => { throw new Error("release failed"); };
    await expect(withPiSettingsLock(path, async () => ({ result: 1 }), { lock })).rejects.toThrow("release failed");
  });

  it("surfaces both errors when the operation and the release fail", async () => {
    const path = join(tmp.dir, "r2.json");
    const lock = async () => async () => { throw new Error("release failed"); };
    const err = await withPiSettingsLock(path, async () => { throw new Error("op failed"); }, { lock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(["op failed", "release failed"]);
  });
});

describe("withPiSettingsLock", () => {
  it("does not write when fn returns no next, and releases the lock when fn throws", async () => {
    const path = join(tmp.dir, "s.json");
    await expect(withPiSettingsLock(path, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withPiSettingsLock(path, async (c) => ({ result: c }))).toEqual({});
    expect(await readFile(path, "utf8")).toBe("{}\n");
  });
});
