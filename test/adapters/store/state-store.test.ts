import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MalformedJson } from "../../../src/adapters/platform/json-file.ts";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import {
  docSchemas,
  loadProfiles,
  readPersonalConfig,
  readState,
  writePersonalConfig,
  writeState,
} from "../../../src/adapters/store/state-store.ts";
import type { FactoryState } from "../../../src/core/state/schema.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;
let paths: FactoryPaths;

beforeEach(async () => {
  tmp = await makeTmp("state-store");
  paths = factoryPaths(isolatedEnv(tmp.dir));
});
afterEach(async () => {
  await tmp.cleanup();
});

const STATE: FactoryState = {
  schema: 1,
  version: "0.1.0",
  installedAt: "2026-10-31T10:00:00.000Z",
  source: "https://github.com/jrevenga/ai-factory.git",
  piVersion: "1.4.0",
  piCli: "/x/cli.js",
  history: [{ version: "0.1.0", at: "2026-10-31T10:00:00.000Z", reason: "install" }],
};

describe("state.json", () => {
  it("reads undefined when missing and round-trips, preserving unknown fields", async () => {
    expect(await readState(paths)).toBeUndefined();
    await writeState(paths, { ...STATE, extra: 1 } as FactoryState);
    expect(await readState(paths)).toEqual({ ...STATE, extra: 1 });
  });

  it("throws MalformedJson naming the path for an invalid document", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, JSON.stringify({ schema: 1, version: 3 }));
    const err = await readState(paths).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedJson);
    expect((err as MalformedJson).path).toBe(paths.state);
  });

  it("refuses to write an invalid state", async () => {
    await expect(writeState(paths, { ...STATE, history: [{ reason: "x" }] } as unknown as FactoryState)).rejects.toThrow();
  });
});

describe("config.json", () => {
  it("round-trips the personal config", async () => {
    expect(await readPersonalConfig(paths)).toBeUndefined();
    await writePersonalConfig(paths, { schema: 1, profile: "codex-only", custom: true });
    expect(await readPersonalConfig(paths)).toEqual({ schema: 1, profile: "codex-only", custom: true });
    expect((await readFile(paths.config, "utf8")).endsWith("\n")).toBe(true);
  });
});

describe("loadProfiles", () => {
  it("loads the shipped profiles sorted by file name", async () => {
    const profiles = await loadProfiles(resolve("profiles"));
    expect(profiles.map((p) => p.name)).toEqual(["claude-codex", "codex-only"]);
  });

  it("names the file of an invalid profile", async () => {
    const dir = join(tmp.dir, "profiles");
    await mkdir(dir);
    await writeFile(join(dir, "bad.json"), JSON.stringify({ schema: 1 }));
    await expect(loadProfiles(dir)).rejects.toThrow(/bad\.json/);
  });
});

describe("docSchemas", () => {
  it("reports the schema of each present state document", async () => {
    expect(await docSchemas(paths)).toEqual({});
    await writeState(paths, STATE);
    await writeFile(paths.managedSettings, JSON.stringify({ schema: 2, keys: {} }));
    expect(await docSchemas(paths)).toEqual({ "state.json": 1, "managed-settings.json": 2 });
  });

  it("throws MalformedJson for a document without an integer schema", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.config, JSON.stringify({ profile: "x" }));
    await expect(docSchemas(paths)).rejects.toBeInstanceOf(MalformedJson);
  });
});
