import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPiSettings } from "../../../src/adapters/pi/settings-file.ts";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  snapshotId,
  SnapshotExists,
} from "../../../src/adapters/store/snapshots.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;
let paths: FactoryPaths;

const T1 = new Date("2026-10-31T09:08:07.123Z");
const T2 = new Date("2026-10-31T09:08:08.000Z");

beforeEach(async () => {
  tmp = await makeTmp("snapshots");
  paths = factoryPaths(isolatedEnv(tmp.dir));
  await mkdir(paths.home, { recursive: true });
  // Odd formatting on purpose: restore must be byte-equal, not re-serialized.
  await writeFile(paths.config, '{ "schema": 1,  "profile": "codex-only" }\r\n');
  await writeFile(paths.state, '{"schema":1,"version":"0.1.0"}');
});
afterEach(async () => {
  await tmp.cleanup();
});

async function readDirFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await readdir(dir)).sort()) out[f] = await readFile(join(dir, f), "utf8");
  return out;
}

describe("snapshotId", () => {
  it("is <UTC yyyymmddThhmmssZ>-<from>-to-<to>", () => {
    expect(snapshotId(T1, "0.1.0", "0.2.0")).toBe("20261031T090807Z-0.1.0-to-0.2.0");
  });

  it("rejects versions that are not a safe path component", () => {
    for (const bad of ["", "..", "a/b", "a\\b", "1.0.0:x"]) expect(() => snapshotId(T1, bad, "0.2.0")).toThrow();
  });
});

describe("createSnapshot", () => {
  it("copies present state documents, Pi packages and writes snapshot.json", async () => {
    await mkdir(paths.piAgentDir, { recursive: true });
    await writeFile(paths.piSettings, JSON.stringify({ packages: ["git:x@v0.1.0"], theme: "dark" }));
    const info = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    expect(info).toEqual({
      id: "20261031T090807Z-0.1.0-to-0.2.0",
      from: "0.1.0",
      to: "0.2.0",
      kind: "update",
      at: T1.toISOString(),
      files: ["config.json", "state.json", "pi-packages.json"],
    });
    const dir = join(paths.backups, info.id);
    expect(await readFile(join(dir, "config.json"), "utf8")).toBe(await readFile(paths.config, "utf8"));
    expect(JSON.parse(await readFile(join(dir, "pi-packages.json"), "utf8"))).toEqual({ packages: ["git:x@v0.1.0"] });
    expect(JSON.parse(await readFile(join(dir, "snapshot.json"), "utf8"))).toEqual(info);
  });

  it("works without memory.db and without Pi settings, and copies memory.db when present", async () => {
    const a = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    expect(a.files).not.toContain("memory.db");
    expect(JSON.parse(await readFile(join(paths.backups, a.id, "pi-packages.json"), "utf8"))).toEqual({});
    expect(existsSync(paths.piSettings)).toBe(false);

    await writeFile(paths.memoryDb, Buffer.from([0, 1, 2, 255]));
    const b = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T2 });
    expect(b.files).toContain("memory.db");
    expect(await readFile(join(paths.backups, b.id, "memory.db"))).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("creates a new directory per second and leaves the earlier snapshot untouched", async () => {
    const first = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    const firstDir = join(paths.backups, first.id);
    const before = await readDirFiles(firstDir);
    await writeFile(paths.config, '{"schema":1,"profile":"claude-codex"}');
    const second = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T2 });
    expect(second.id).not.toBe(first.id);
    expect((await readdir(paths.backups)).sort()).toEqual([first.id, second.id]);
    expect(await readDirFiles(firstDir)).toEqual(before);
  });

  it("throws SnapshotExists rather than overwriting an existing id", async () => {
    const first = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    const before = await readDirFiles(join(paths.backups, first.id));
    await writeFile(paths.config, '{"schema":1,"profile":"changed"}');
    await expect(createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 })).rejects.toBeInstanceOf(
      SnapshotExists,
    );
    expect(await readDirFiles(join(paths.backups, first.id))).toEqual(before);
  });
});

describe("listSnapshots", () => {
  it("is empty without a backups directory", async () => {
    expect(await listSnapshots(paths)).toEqual([]);
  });

  it("lists complete snapshots newest first and skips incomplete directories", async () => {
    const a = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    const b = await createSnapshot(paths, { from: "0.2.0", to: "0.1.0", kind: "rollback", now: T2 });
    await mkdir(join(paths.backups, "20991231T000000Z-9.9.9-to-9.9.10"));
    expect((await listSnapshots(paths)).map((s) => s.id)).toEqual([b.id, a.id]);
  });
});

describe("restoreSnapshot", () => {
  it("restores documents byte-equal", async () => {
    const original = await readFile(paths.config);
    const info = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    await writeFile(paths.config, '{"schema":2,"profile":"migrated"}');
    await restoreSnapshot(paths, info.id, ["config.json"]);
    expect(await readFile(paths.config)).toEqual(original);
  });

  it("restores Pi packages into Pi settings and keeps other keys", async () => {
    await mkdir(paths.piAgentDir, { recursive: true });
    await writeFile(paths.piSettings, JSON.stringify({ packages: ["git:x@v0.1.0"] }));
    const info = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    await writeFile(paths.piSettings, JSON.stringify({ packages: ["git:x@v0.2.0"], theme: "dark" }));
    await restoreSnapshot(paths, info.id, ["pi-packages.json"]);
    expect(await readPiSettings(paths.piSettings)).toEqual({ packages: ["git:x@v0.1.0"], theme: "dark" });
  });

  it("refuses a file the snapshot does not hold before restoring anything", async () => {
    const info = await createSnapshot(paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: T1 });
    await writeFile(paths.config, '{"schema":1,"profile":"changed"}');
    await expect(restoreSnapshot(paths, info.id, ["config.json", "managed-settings.json"])).rejects.toThrow(
      /managed-settings\.json/,
    );
    expect(await readFile(paths.config, "utf8")).toBe('{"schema":1,"profile":"changed"}');
  });

  it("rejects an unsafe or unknown snapshot id", async () => {
    await expect(restoreSnapshot(paths, "../x", ["config.json"])).rejects.toThrow();
    await expect(restoreSnapshot(paths, "20261031T000000Z-0.1.0-to-0.2.0", ["config.json"])).rejects.toThrow();
  });
});
