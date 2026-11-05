import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { acquireLock } from "../../src/adapters/store/lock.ts";
import { writeState } from "../../src/adapters/store/state-store.ts";
import { registerSession as registerSessionReal } from "../../src/adapters/store/sessions.ts";
import { launch, type LaunchContext } from "../../src/cli/commands/launch.ts";
import type { DoctorCheck } from "../../src/cli/commands/doctor.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";
import { ReleaseManifest } from "../../src/core/release/manifest.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { stateAt } from "../helpers/release-world.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const manifest = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));
const FAKE_PI = resolve("test/fixtures/fake-pi.mjs");
const DRIVER = resolve("test/fixtures/launch-driver.ts");

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
let out: string;
let errs: string[];

beforeEach(async () => {
  tmp = await makeTmp("launch");
  out = join(tmp.dir, "fake-pi.log");
  env = { ...isolatedEnv(tmp.dir), PI_OFFLINE: "1", FAKE_PI_OUT: out };
  paths = factoryPaths(env);
  errs = [];
});
afterEach(async () => {
  await tmp.cleanup();
});

const io = (): CliIO => ({ out: () => {}, err: (s) => void errs.push(s), confirm: async () => false, isTTY: false });
const okDoctor = async (): Promise<DoctorCheck[]> => [];
const install = (): Promise<void> => writeState(paths, { ...stateAt("0.1.0", []), piCli: FAKE_PI });
const run = (args: string[], doctor = okDoctor): Promise<number> => launch({ paths, env, manifest, io: io(), doctor }, args);
const log = (): string => (existsSync(out) ? readFileSync(out, "utf8") : "");

describe("launch", () => {
  it.each([["--no-extensions"], ["-ne"]])("%s anywhere in the arguments exits 2 and starts nothing", async (flag) => {
    await install();
    expect(await run(["--model", "x", flag])).toBe(2);
    expect(errs.join("")).toContain(flag);
    expect(log()).toBe("");
  });

  it("missing state exits 1 with the fix and starts nothing", async () => {
    const real = { paths, env, manifest, io: io() };
    expect(await launch(real, [])).toBe(1);
    expect(errs.join("\n")).toMatch(/factory install/);
    expect(log()).toBe("");
  });

  it("a failing blocking check exits 1 with its fix; a non-blocking finding does not", async () => {
    await install();
    const failing = async (): Promise<DoctorCheck[]> => [{ id: "guard", status: "fail", message: "guard missing", fix: "factory install" }];
    expect(await run([], failing)).toBe(1);
    expect(errs.join("\n")).toMatch(/guard missing[\s\S]*fix: factory install/);
    expect(log()).toBe("");

    errs = [];
    env.FAKE_PI_MODE = "exit";
    const warning = async (): Promise<DoctorCheck[]> => [
      { id: "source-override", status: "warn", message: "w" },
      { id: "pi-settings", status: "fail", message: "not blocking" },
    ];
    expect(await run([], warning)).toBe(3);
    expect(errs.join("\n")).toMatch(/2 finding/);
  });

  it("forwards argv, returns the child's code, records piPid and removes the session", async () => {
    await install();
    env.FAKE_PI_MODE = "exit";
    expect(await run(["--model", "x", "a b"])).toBe(3);
    const l = log();
    expect(l).toContain(`argv ${JSON.stringify(["--model", "x", "a b"])}`);
    expect(l).toContain('"piPidIsMe":true');
    expect(l).toContain("telemetry 0");
    expect(readdirSync(paths.sessions)).toEqual([]);
  });

  it("a session record that cannot be removed is reported, and Pi's exit code is still returned", async () => {
    await install();
    env.FAKE_PI_MODE = "exit";
    const registerSession: LaunchContext["registerSession"] = async (p) => {
      const real = await registerSessionReal(p);
      return {
        ...real,
        end: async () => {
          await real.end();
          throw new Error("EPERM: session record is locked");
        },
      };
    };
    expect(await launch({ paths, env, manifest, io: io(), doctor: okDoctor, registerSession }, [])).toBe(3);
    expect(errs.join("\n")).toMatch(/Could not remove the session record .*EPERM: session record is locked/);
  });

  it("registration while an update holds the factory lock exits 1 and starts nothing", async () => {
    await install();
    const lock = await acquireLock(paths);
    try {
      expect(await run([])).toBe(1);
      expect(errs.join("\n")).toMatch(/update is in progress/);
      expect(log()).toBe("");
    } finally {
      await lock.release();
    }
  });

  it("a piCli that cannot run exits 1 and removes the session", async () => {
    await writeState(paths, { ...stateAt("0.1.0", []), piCli: join(tmp.dir, "missing.js") });
    expect(await run([])).toBe(1);
    expect(readdirSync(paths.sessions)).toEqual([]);
  });
});

describe("main routes to the launcher", () => {
  it.each([
    [[], []],
    [["--model", "x"], ["--model", "x"]],
    [["--", "--model", "x"], ["--model", "x"]],
    [["--", "doctor"], ["doctor"]],
  ])("%j starts Pi with %j", async (argv, expected) => {
    await install();
    env.FAKE_PI_MODE = "exit";
    expect(await main(argv, io(), { env, doctor: okDoctor })).toBe(3);
    expect(log()).toContain(`argv ${JSON.stringify(expected)}`);
  });

  it("-ne through main exits 2", async () => {
    await install();
    expect(await main(["-ne"], io(), { env, doctor: okDoctor })).toBe(2);
  });
});

function drive(args: string[], mode: string): { child: ReturnType<typeof spawn>; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, ["--import", "jiti/register", DRIVER, ...args], {
    env: { ...env, FAKE_PI_MODE: mode },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.once("exit", (code, signal) => res({ code, signal })));
  return { child, exited };
}
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
}

describe.skipIf(process.platform === "win32")("launch signals (POSIX)", () => {
  it("SIGTERM to the launcher reaches the child and the launcher exits only after it", async () => {
    await install();
    const { child, exited } = drive([], "term-handled");
    await until(() => log().includes("started"));
    child.kill("SIGTERM");
    const r = await exited;
    expect(log()).toContain("got SIGTERM");
    expect(log()).toContain("exiting");
    expect(r).toEqual({ code: 7, signal: null });
    expect(readdirSync(paths.sessions)).toEqual([]);
  });

  it("SIGHUP is forwarded too", async () => {
    await install();
    const { child, exited } = drive([], "term-handled");
    await until(() => log().includes("started"));
    child.kill("SIGHUP");
    expect(await exited).toEqual({ code: 129, signal: null });
    expect(log()).not.toContain("got SIGTERM");
  });

  it("a child killed by a signal yields 128 + signal number", async () => {
    await install();
    const { child, exited } = drive([], "hang");
    await until(() => log().includes("started"));
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 143, signal: null });
  });

  it("SIGINT does not kill the launcher; it waits for the child", async () => {
    await install();
    const { child, exited } = drive([], "term-handled");
    await until(() => log().includes("started"));
    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 400));
    let done = false;
    void exited.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    child.kill("SIGTERM");
    expect((await exited).code).toBe(7);
  });
});
