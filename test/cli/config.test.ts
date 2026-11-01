import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { configExplain } from "../../src/cli/commands/config.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
let repo: string;
let outs: string[];
let errs: string[];

beforeEach(async () => {
  tmp = await makeTmp("config");
  env = isolatedEnv(tmp.dir);
  paths = factoryPaths(env);
  repo = join(tmp.dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(paths.home, { recursive: true });
  outs = [];
  errs = [];
});
afterEach(async () => {
  await tmp.cleanup();
});

const io = (): CliIO => ({ out: (s) => void outs.push(s), err: (s) => void errs.push(s), confirm: async () => false, isTTY: false });
const explain = (key: string): Promise<number> => configExplain({ paths, env, io: io(), root: resolve("."), cwd: repo }, key);
const personal = (extra: object): void => writeFileSync(paths.config, JSON.stringify({ schema: 1, profile: "claude-codex", ...extra }));

describe("config explain", () => {
  it("shows the personal value and what it overrides", async () => {
    personal({ autonomy: "high" });
    expect(await explain("autonomy")).toBe(0);
    expect(outs).toEqual(['autonomy = "high"  (from personal)', 'overrides: core="medium"']);
  });

  it("a core value has no overrides", async () => {
    expect(await explain("parallelism")).toBe(0);
    expect(outs).toEqual(["parallelism = 3  (from core)"]);
  });

  it("project overrides win and are listed with the personal layer below", async () => {
    personal({ language: "es" });
    mkdirSync(join(repo, ".factory"));
    writeFileSync(join(repo, ".factory/config.json"), JSON.stringify({ schema: 1, overrides: { language: "en" } }));
    expect(await explain("language")).toBe(0);
    expect(outs[0]).toBe('language = "en"  (from project)');
    expect(outs).toContain('overrides: personal="es"');
  });

  it("reports a locked-key violation", async () => {
    personal({ gates: { hard: [] } });
    expect(await explain("gates.hard")).toBe(0);
    expect(outs.join("\n")).toMatch(/violation: personal.*gates\.hard/);
  });

  it("an unknown key exits 1", async () => {
    expect(await explain("nope.nothing")).toBe(1);
    expect(errs.join("")).toMatch(/Unknown setting/);
  });

  it("routes through main and rejects bad usage with 2", async () => {
    expect(await main(["config", "explain", "parallelism"], io(), { env, cwd: repo })).toBe(0);
    expect(await main(["config"], io(), { env, cwd: repo })).toBe(2);
    expect(await main(["config", "explain"], io(), { env, cwd: repo })).toBe(2);
  });
});
