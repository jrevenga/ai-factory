// Real pinned Pi: installs Pi 1.4.0 from the public npm registry into a temp FACTORY_HOME.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { npm } from "../../src/adapters/platform/npm.ts";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { PiRuntime, UnresolvableRef } from "../../src/adapters/pi/runtime.ts";
import { detectLogins } from "../../src/adapters/providers/logins.ts";
import { makeBareRepo, makeWorkTree, startGitServer, type GitServer } from "../helpers/git-server.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const isWindows = process.platform === "win32";

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
let cli: string;
let server: GitServer;
let firstInstallNpmCalls = 0;

beforeAll(async () => {
  tmp = await makeTmp("runtime-e2e");
  env = { ...isolatedEnv(tmp.dir), PI_OFFLINE: "1" };
  paths = factoryPaths(env);
  const npmSpy = vi.fn(npm);
  cli = await new PiRuntime({ npm: npmSpy }).ensurePinned(paths, "1.4.0", { env });
  firstInstallNpmCalls = npmSpy.mock.calls.length;

  const work = join(tmp.dir, "fixture work tree");
  await makeWorkTree(work, [
    {
      "package.json": JSON.stringify({ name: "ai-factory-fixture", version: "0.0.1", keywords: ["pi-package"], pi: { prompts: ["./prompts"] } }, null, 2),
      "prompts/hello.md": "Say hello.\n",
    },
  ]);
  const root = join(tmp.dir, "served root");
  await makeBareRepo(work, join(root, "fixture", "ai-factory.git"), [{ name: "v0.0.1-test" }]);
  server = await startGitServer(root);
}, 600_000);

afterAll(async () => {
  await server?.close();
  await tmp?.cleanup();
});

describe("PiRuntime (e2e, real Pi 1.4.0)", () => {
  it("ensurePinned installs Pi 1.4.0 under FACTORY_HOME/pi/1.4.0", async () => {
    expect(cli.startsWith(join(paths.piPrefixes, "1.4.0"))).toBe(true);
    expect(firstInstallNpmCalls).toBe(1);
    expect(await new PiRuntime().version(cli, { env })).toBe("1.4.0");
  });

  it("a second ensurePinned reuses the prefix and runs no npm", async () => {
    const spy = vi.fn(npm);
    expect(await new PiRuntime({ npm: spy }).ensurePinned(paths, "1.4.0", { env })).toBe(cli);
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs pinned pi, not PATH pi", async () => {
    const bin = join(tmp.dir, "fake pi bin");
    const marker = join(tmp.dir, "path pi ran.txt");
    await mkdir(bin, { recursive: true });
    if (isWindows) {
      await writeFile(join(bin, "pi.cmd"), `@echo off\r\necho ran> "${marker}"\r\necho 9.9.9\r\n`);
    } else {
      await writeFile(join(bin, "pi"), `#!/bin/sh\necho ran > "${marker}"\necho 9.9.9\n`);
      await chmod(join(bin, "pi"), 0o755);
    }
    const pathEnv = { ...env, PATH: bin + delimiter + (env.PATH ?? "") };
    const r = await new PiRuntime().run(cli, ["--version"], { env: pathEnv, timeoutMs: 60_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("1.4.0");
    expect(existsSync(marker)).toBe(false);
  });

  it("installPackage of a missing tag → UnresolvableRef, Pi settings absent", async () => {
    const ref = `git:${server.url("fixture/ai-factory.git")}@v9.9.9`;
    const err = await new PiRuntime().installPackage(cli, ref, { env, cwd: tmp.dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnresolvableRef);
    expect(err).toMatchObject({ ref, kind: "not-found" });
    expect(existsSync(join(paths.piAgentDir, "settings.json"))).toBe(false);
  });

  it("installPackage of an existing tag writes the ref into Pi settings packages", async () => {
    const ref = `git:${server.url("fixture/ai-factory.git")}@v0.0.1-test`;
    // Simulate a Windows runner's core.autocrlf=true: Pi's checkout must still be byte-identical.
    const gitconfig = join(tmp.dir, "autocrlf gitconfig");
    await writeFile(gitconfig, "[core]\n\tautocrlf = true\n");
    await new PiRuntime().installPackage(cli, ref, { env: { ...env, GIT_CONFIG_GLOBAL: gitconfig }, cwd: tmp.dir });
    const settings = JSON.parse(readFileSync(join(paths.piAgentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
    expect(settings.packages).toContain(ref);
    const prompt = readdirSync(join(paths.piAgentDir, "git"), { recursive: true, encoding: "utf8" }).find((p) => p.replace(/\\/g, "/").endsWith("prompts/hello.md"));
    expect(prompt).toBeDefined();
    expect(readFileSync(join(paths.piAgentDir, "git", prompt as string), "utf8")).toBe("Say hello.\n");
  }, 180_000);

  it("detectLogins with the pinned Pi and an empty agent dir → codex absent", async () => {
    const t = await makeTmp("runtime-e2e-logins");
    try {
      const r = await detectLogins({ piCli: cli, env: { ...isolatedEnv(t.dir), PI_OFFLINE: "1" } });
      expect(r.codex).toBe("absent");
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});
