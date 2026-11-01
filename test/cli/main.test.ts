import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { factoryPaths } from "../../src/adapters/platform/paths.ts";
import { PiRuntime } from "../../src/adapters/pi/runtime.ts";
import { acquireLock } from "../../src/adapters/store/lock.ts";
import { main } from "../../src/cli/main.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp } from "../helpers/tmp.ts";

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => void out.push(s), err: (s) => void err.push(s), confirm: async () => false, isTTY: false } };
}

describe("main router", () => {
  it("unknown command prints usage and exits 2", async () => {
    const c = capture();
    expect(await main(["nope"], c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/Unknown command: nope[\s\S]*Usage:/);
  });

  it("version prints the release version", async () => {
    const c = capture();
    expect(await main(["version"], c.io)).toBe(0);
    expect(c.out).toEqual(["0.1.0"]);
  });

  it.each(["runs", "eval", "radar"])("%s arrives in a later phase", async (cmd) => {
    const c = capture();
    expect(await main([cmd], c.io)).toBe(2);
    expect(c.err.join("")).toBe(`factory ${cmd} arrives in a later phase`);
  });

  it("commands owned by later tasks are stubs that exit 2", async () => {
    const c = capture();
    expect(await main(["update"], c.io)).toBe(2);
    expect(c.err.join("")).toMatch(/not implemented yet/);
  });

  it("doctor rejects unknown flags with exit 2", async () => {
    const c = capture();
    expect(await main(["doctor", "--bogus"], c.io)).toBe(2);
  });

  it.each([
    [["install", "--bogus"]],
    [["install", "extra"]],
    [["_apply-release"]],
    [["_apply-release", "--reason", "bogus"]],
    [["_apply-release", "--reason", "update", "--parent-lock", "abc"]],
    [["_apply-release", "--reason", "update", "--parent-lock", "0"]],
  ])("%j is a usage error (exit 2)", async (argv) => {
    const c = capture();
    expect(await main(argv, c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/Usage:/);
  });
});

describe("main _apply-release", () => {
  it("maps --reason/--from/--parent-lock/--profile/--yes onto applyRelease", async () => {
    const t = await makeTmp("main-apply");
    const env = { ...isolatedEnv(t.dir), FACTORY_SOURCE: "http://127.0.0.1:1/x/ai-factory.git", PI_OFFLINE: "1" };
    const paths = factoryPaths(env);
    const installs: string[] = [];
    const pi = new (class extends PiRuntime {
      override async ensurePinned(): Promise<string> {
        return "/fake/cli.js";
      }
      override async installPackage(_cli: string, ref: string): Promise<void> {
        installs.push(ref);
      }
    })();
    const held = await acquireLock(paths);
    try {
      const c = capture();
      const argv = ["_apply-release", "--reason", "update", "--from", "0.0.9", "--parent-lock", String(process.pid), "--profile", "codex-only", "--yes"];
      const code = await main(argv, c.io, {
        env,
        pi,
        applyDeps: { detectLogins: async () => ({ claude: "absent", codex: "absent" }), runDoctor: async () => [] },
      });
      expect(code, c.err.join("\n")).toBe(0);
      expect(installs).toEqual(["git:http://127.0.0.1:1/x/ai-factory.git@v0.1.0"]);
      const state = JSON.parse(readFileSync(paths.state, "utf8")) as { history: unknown[] };
      expect(state.history).toEqual([{ version: "0.1.0", at: expect.any(String), reason: "update", from: "0.0.9" }]);
      expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual({ schema: 1, profile: "codex-only" });
    } finally {
      await held.release();
      await t.cleanup();
    }
  });

  it("a failed apply exits 1 with the recovery message", async () => {
    const t = await makeTmp("main-apply-fail");
    const env = { ...isolatedEnv(t.dir), FACTORY_SOURCE: "http://127.0.0.1:1/x/ai-factory.git", PI_OFFLINE: "1" };
    const pi = new (class extends PiRuntime {
      override async ensurePinned(): Promise<string> {
        throw new Error("no registry");
      }
    })();
    try {
      const c = capture();
      expect(await main(["_apply-release", "--reason", "install"], c.io, { env, pi })).toBe(1);
      expect(c.err.join("\n")).toContain("Install did not complete: no registry. Previous state kept.");
      expect(existsSync(factoryPaths(env).state)).toBe(false);
    } finally {
      await t.cleanup();
    }
  });
});
