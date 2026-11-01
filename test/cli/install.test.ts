import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/adapters/platform/process.ts";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { PiRuntime } from "../../src/adapters/pi/runtime.ts";
import type { ApplyContext } from "../../src/cli/commands/apply-release.ts";
import type { DoctorCheck } from "../../src/cli/commands/doctor.ts";
import { install, isNpxPath, type InstallDeps } from "../../src/cli/commands/install.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { ReleaseManifest } from "../../src/core/release/manifest.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const manifest = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));
const SOURCE = "http://127.0.0.1:1/fixture/ai-factory.git";
const NPX_CLI = "/home/u/.npm/_npx/abc/node_modules/ai-factory/bin/factory.mjs";
const GLOBAL_CLI = "/home/u/.npm-global/lib/node_modules/ai-factory/bin/factory.mjs";

describe("isNpxPath", () => {
  it.each([
    [NPX_CLI, true],
    ["C:\\Users\\a b\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\ai-factory\\bin\\factory.mjs", true],
    [GLOBAL_CLI, false],
    ["C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\ai-factory\\bin\\factory.mjs", false],
    ["/home/u/my_npx_tools/ai-factory/bin/factory.mjs", false],
  ])("%s → %s", (p, expected) => {
    expect(isNpxPath(p)).toBe(expected);
  });
});

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
let log: string[];
let out: string[];
let err: string[];

beforeEach(async () => {
  tmp = await makeTmp("install");
  env = { ...isolatedEnv(tmp.dir), FACTORY_SOURCE: SOURCE, PI_OFFLINE: "1" };
  paths = factoryPaths(env);
  log = [];
  out = [];
  err = [];
});
afterEach(async () => {
  await tmp.cleanup();
});

class FakePi extends PiRuntime {
  override async ensurePinned(): Promise<string> {
    log.push("ensurePinned");
    return "/fake/cli.js";
  }
  override async installPackage(_cli: string, ref: string): Promise<void> {
    log.push(`installPackage ${ref}`);
  }
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, orphans: false });
const REQS_OK: DoctorCheck[] = ["node-version", "node-sqlite-fts5", "git", "npm", "npm-prefix-writable"].map((id) => ({ id, status: "ok", message: `${id} fine` }));

function ctx(): ApplyContext {
  const io: CliIO = { out: (s) => void out.push(s), err: (s) => void err.push(s), confirm: async () => false, isTTY: false };
  return {
    paths,
    env,
    manifest,
    io,
    pi: new FakePi(),
    now: () => new Date("2026-11-01T10:00:00.000Z"),
    deps: {
      detectLogins: async () => ({ claude: "absent", codex: "present" }),
      runDoctor: async () => [],
    },
  };
}

function deps(over: Partial<InstallDeps> = {}): Partial<InstallDeps> {
  return {
    cliPath: GLOBAL_CLI,
    requirements: async () => REQS_OK,
    npm: async (args) => {
      log.push(`npm ${args.join(" ")}`);
      return args[0] === "root" ? ok(`${join(tmp.dir, "global root")}\n`) : ok();
    },
    runNode: async (args) => {
      log.push(`node ${args.join(" ")}`);
      return 3;
    },
    ...over,
  };
}

describe("install", () => {
  it("failing minimum requirements → prints the fixes, exit 1, nothing installed", async () => {
    const reqs: DoctorCheck[] = [...REQS_OK.slice(0, 2), { id: "git", status: "fail", message: "git was not found on PATH", fix: "Install Git" }];
    const code = await install(ctx(), { yes: true }, deps({ requirements: async () => reqs }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("git was not found on PATH");
    expect(err.join("\n")).toContain("Install Git");
    expect(log).toEqual([]);
    expect(existsSync(paths.state)).toBe(false);
  });

  it("outside npx → applies the release with reason install, exit 0", async () => {
    const code = await install(ctx(), { yes: true }, deps());
    expect(code).toBe(0);
    expect(log).toEqual(["ensurePinned", `installPackage git:${SOURCE}@v0.1.0`]);
    const state = JSON.parse(readFileSync(paths.state, "utf8")) as { history: Array<{ reason: string }> };
    expect(state.history[0]?.reason).toBe("install");
  });

  it.each([GLOBAL_CLI, NPX_CLI])("refuses while txn.json exists (ruling R8), from %s", async (cliPath) => {
    await mkdir(paths.home, { recursive: true });
    const txn = JSON.stringify({ id: "t", kind: "update", from: "0.0.9", to: "0.1.0", snapshot: "s", startedAt: "2026-11-01T09:00:00.000Z" });
    await writeFile(paths.txn, txn);
    expect(await install(ctx(), { yes: true }, deps({ cliPath }))).toBe(1);
    expect(err.join("\n")).toBe('A previous update did not finish. Run "factory rollback".');
    expect(readFileSync(paths.txn, "utf8")).toBe(txn);
    expect(log).toEqual([]);
    expect(existsSync(paths.state)).toBe(false);
  });

  it("outside npx, a failed apply → exit 1", async () => {
    const c = ctx();
    c.pi = new (class extends FakePi {
      override async installPackage(): Promise<void> {
        throw new Error("boom");
      }
    })();
    expect(await install(c, { yes: true }, deps())).toBe(1);
    expect(err.join("\n")).toContain("Install did not complete: boom");
  });

  it("under npx → global npm install with --legacy-peer-deps, then runs the global CLI install with the same flags", async () => {
    const globalCli = join(tmp.dir, "global root", "ai-factory", "bin", "factory.mjs");
    await mkdir(join(globalCli, ".."), { recursive: true });
    await writeFile(globalCli, "// stand-in for the globally installed CLI\n");
    const code = await install(ctx(), { yes: true, profile: "codex-only" }, deps({ cliPath: NPX_CLI }));
    expect(code).toBe(3);
    expect(log).toEqual([
      `npm install -g --legacy-peer-deps git+${SOURCE}#v0.1.0`,
      "npm root -g",
      `node ${globalCli} install --yes --profile codex-only`,
    ]);
    expect(existsSync(paths.state)).toBe(false);
  });

  it("under npx, a failed global npm install → exit 1 and the global CLI is not run", async () => {
    const failing = deps({
      cliPath: NPX_CLI,
      npm: async (args) => {
        log.push(`npm ${args.join(" ")}`);
        return { code: 1, stdout: "", stderr: "npm ERR! could not clone", timedOut: false, orphans: false };
      },
    });
    expect(await install(ctx(), { yes: false }, failing)).toBe(1);
    expect(err.join("\n")).toContain("npm ERR! could not clone");
    expect(log.some((l) => l.startsWith("node "))).toBe(false);
  });

  it("under npx, a global install without the CLI file → exit 1 and nothing is run", async () => {
    expect(await install(ctx(), { yes: true }, deps({ cliPath: NPX_CLI }))).toBe(1);
    expect(err.join("\n")).toContain("does not exist");
    expect(log.some((l) => l.startsWith("node "))).toBe(false);
  });
});
