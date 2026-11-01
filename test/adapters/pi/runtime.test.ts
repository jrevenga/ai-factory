import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { factoryPaths } from "../../../src/adapters/platform/paths.ts";
import type { RunResult } from "../../../src/adapters/platform/process.ts";
import { parsePiGitRef, PiInstallFailed, PiRuntime, UnresolvableRef } from "../../../src/adapters/pi/runtime.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const PKG = ["node_modules", "@earendil-works", "pi-coding-agent"];
let tmp: Tmp;

beforeEach(async () => {
  tmp = await makeTmp("pi-runtime");
});

afterEach(async () => {
  await tmp.cleanup();
});

async function fakePiInstall(prefix: string, version: string): Promise<string> {
  const pkg = join(prefix, ...PKG);
  await mkdir(join(pkg, "dist", "bundle"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  const cli = join(pkg, "dist", "bundle", "cli.js");
  await writeFile(cli, `console.log(${JSON.stringify(version)});\n`);
  return cli;
}

const ok = (): RunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, orphans: false });

describe("parsePiGitRef", () => {
  it("splits Pi git refs into a clone URL and a ref", () => {
    expect(parsePiGitRef("git:http://127.0.0.1:4567/fixture/ai-factory.git@v0.0.1-test")).toEqual({ url: "http://127.0.0.1:4567/fixture/ai-factory.git", ref: "v0.0.1-test" });
    expect(parsePiGitRef("git:https://github.com/jrevenga/ai-factory.git@v0.1.0")).toEqual({ url: "https://github.com/jrevenga/ai-factory.git", ref: "v0.1.0" });
    expect(parsePiGitRef("git:github.com/jrevenga/ai-factory@v0.1.0")).toEqual({ url: "https://github.com/jrevenga/ai-factory", ref: "v0.1.0" });
    expect(parsePiGitRef("git:git@github.com:jrevenga/ai-factory.git@v0.1.0")).toEqual({ url: "git@github.com:jrevenga/ai-factory.git", ref: "v0.1.0" });
  });

  it("returns a missing ref for unpinned refs and undefined for non-git refs", () => {
    expect(parsePiGitRef("git:https://github.com/jrevenga/ai-factory.git")).toEqual({ url: "https://github.com/jrevenga/ai-factory.git", ref: undefined });
    expect(parsePiGitRef("npm:pi-claude-bridge@0.9.3")).toBeUndefined();
  });
});

describe("PiRuntime.ensurePinned", () => {
  it("reuses a prefix whose Pi package.json version matches, without npm", async () => {
    const paths = factoryPaths(isolatedEnv(tmp.dir));
    const cli = await fakePiInstall(join(paths.piPrefixes, "1.4.0"), "1.4.0");
    const npm = vi.fn(async () => ok());
    expect(await new PiRuntime({ npm }).ensurePinned(paths, "1.4.0")).toBe(cli);
    expect(npm).not.toHaveBeenCalled();
  });

  it("installs into a staging prefix and moves it into place when the version differs", async () => {
    const env = isolatedEnv(tmp.dir);
    const paths = factoryPaths(env);
    await fakePiInstall(join(paths.piPrefixes, "1.4.0"), "1.3.9");
    const npm = vi.fn(async (args: string[]) => {
      await fakePiInstall(args[args.indexOf("--prefix") + 1] as string, "1.4.0");
      return ok();
    });
    const cli = await new PiRuntime({ npm }).ensurePinned(paths, "1.4.0", { env });
    expect(cli).toBe(join(paths.piPrefixes, "1.4.0", ...PKG, "dist", "bundle", "cli.js"));
    expect(JSON.parse(await readFile(join(paths.piPrefixes, "1.4.0", ...PKG, "package.json"), "utf8")).version).toBe("1.4.0");
    expect(npm).toHaveBeenCalledTimes(1);
    const [args, opts] = npm.mock.calls[0] as unknown as [string[], { env?: NodeJS.ProcessEnv }];
    expect(args).toEqual(["install", "--prefix", args[2], "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "@earendil-works/pi-coding-agent@1.4.0"]);
    expect(dirname(args[2] as string)).toBe(paths.piPrefixes);
    expect(opts.env?.FACTORY_HOME).toBe(env.FACTORY_HOME);
    expect(await readdir(paths.piPrefixes)).toEqual(["1.4.0"]);
  });

  it("a failed npm install throws PiInstallFailed and leaves no prefix behind", async () => {
    const paths = factoryPaths(isolatedEnv(tmp.dir));
    const npm = vi.fn(async (args: string[]) => {
      await mkdir(args[args.indexOf("--prefix") + 1] as string, { recursive: true });
      return { ...ok(), code: 1, stderr: "E404" };
    });
    await expect(new PiRuntime({ npm }).ensurePinned(paths, "1.4.0")).rejects.toThrow(PiInstallFailed);
    expect(existsSync(join(paths.piPrefixes, "1.4.0"))).toBe(false);
    expect(await readdir(paths.piPrefixes)).toEqual([]);
  });

  it("rejects a version that is not a plain semver", async () => {
    const paths = factoryPaths(isolatedEnv(tmp.dir));
    const npm = vi.fn(async () => ok());
    await expect(new PiRuntime({ npm }).ensurePinned(paths, "../1.4.0")).rejects.toThrow(/version/i);
    expect(npm).not.toHaveBeenCalled();
  });
});

describe("PiRuntime.run / version", () => {
  it("runs node <cli> with stdin closed and PI_TELEMETRY=0", async () => {
    const cli = join(tmp.dir, "cli probe.mjs");
    await writeFile(
      cli,
      `let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => { console.log(JSON.stringify({ argv: process.argv.slice(2), telemetry: process.env.PI_TELEMETRY, input })); });\n`,
    );
    const r = await new PiRuntime().run(cli, ["a b", "--x"], { env: { ...isolatedEnv(tmp.dir), PI_TELEMETRY: "1" }, timeoutMs: 30_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ argv: ["a b", "--x"], telemetry: "0", input: "" });
  });

  it("version() returns the trimmed --version output", async () => {
    const cli = await fakePiInstall(join(tmp.dir, "prefix"), "1.4.0");
    expect(await new PiRuntime().version(cli, { env: isolatedEnv(tmp.dir) })).toBe("1.4.0");
  });
});

describe("PiRuntime.installPackage refusals (no Pi run)", () => {
  it("an unpinned git ref → UnresolvableRef invalid-ref, Pi settings untouched", async () => {
    const env = isolatedEnv(tmp.dir);
    const err = await new PiRuntime().installPackage(join(tmp.dir, "no-cli.js"), "git:https://github.com/a/b.git", { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnresolvableRef);
    expect((err as UnresolvableRef).kind).toBe("invalid-ref");
    expect(existsSync(factoryPaths(env).piSettings)).toBe(false);
  });

  it("an unreachable git server → UnresolvableRef network, Pi settings untouched", async () => {
    const env = isolatedEnv(tmp.dir);
    const ref = "git:http://127.0.0.1:1/fixture/ai-factory.git@v0.0.1-test";
    const err = await new PiRuntime().installPackage(join(tmp.dir, "no-cli.js"), ref, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnresolvableRef);
    expect(err).toMatchObject({ ref, kind: "network" });
    expect(existsSync(factoryPaths(env).piSettings)).toBe(false);
  });
});
