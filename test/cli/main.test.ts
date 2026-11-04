import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { factoryPaths } from "../../src/adapters/platform/paths.ts";
import { PiRuntime } from "../../src/adapters/pi/runtime.ts";
import { acquireLock } from "../../src/adapters/store/lock.ts";
import { writeState } from "../../src/adapters/store/state-store.ts";
import { main } from "../../src/cli/main.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeWorld, stateAt } from "../helpers/release-world.ts";
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

  it("doctor rejects unknown flags with exit 2", async () => {
    const c = capture();
    expect(await main(["doctor", "--bogus"], c.io)).toBe(2);
  });

  it.each([
    [["install", "--bogus"]],
    [["install", "extra"]],
    [["install", "--parent-lock", "abc"]],
    [["_apply-release"]],
    [["_apply-release", "--reason", "bogus"]],
    [["_apply-release", "--reason", "update", "--parent-lock", "abc"]],
    [["_apply-release", "--reason", "update", "--parent-lock", "0"]],
    [["update", "--bogus"]],
    [["update", "0.2.0"]],
    [["rollback", "--to", "0.1.0"]],
    [["rollback", "0.1.0", "0.0.9"]],
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

  it.each([
    [["install"], 1],
    [["install", "--yes"], 0],
    [["_apply-release", "--reason", "install"], 1],
    [["_apply-release", "--reason", "install", "--yes"], 0],
  ] as const)("%j on a terminal asks about the proposed profile unless --yes (R15)", async (argv, questions) => {
    const t = await makeTmp("main-profile");
    const env = { ...isolatedEnv(t.dir), FACTORY_SOURCE: "http://127.0.0.1:1/x/ai-factory.git", PI_OFFLINE: "1" };
    const pi = new (class extends PiRuntime {
      override async ensurePinned(): Promise<string> {
        return "/fake/cli.js";
      }
      override async installPackage(): Promise<void> {}
    })();
    try {
      const asked: string[] = [];
      const c = capture();
      const io: CliIO = { ...c.io, isTTY: true, confirm: async (q) => (asked.push(q), true) };
      const code = await main([...argv], io, {
        env,
        pi,
        applyDeps: { detectLogins: async () => ({ claude: "absent", codex: "present" }), runDoctor: async () => [] },
      });
      expect(code, c.err.join("\n")).toBe(0);
      expect(asked).toHaveLength(questions);
    } finally {
      await t.cleanup();
    }
  });

  it("install --parent-lock borrows the bootstrapping process's lock and leaves it held (R18)", async () => {
    const t = await makeTmp("main-install-borrow");
    const env = { ...isolatedEnv(t.dir), FACTORY_SOURCE: "http://127.0.0.1:1/x/ai-factory.git", PI_OFFLINE: "1" };
    const paths = factoryPaths(env);
    const pi = new (class extends PiRuntime {
      override async ensurePinned(): Promise<string> {
        return "/fake/cli.js";
      }
      override async installPackage(): Promise<void> {}
    })();
    const held = await acquireLock(paths);
    try {
      const c = capture();
      const code = await main(["install", "--yes", "--parent-lock", String(process.pid)], c.io, {
        env,
        pi,
        applyDeps: { detectLogins: async () => ({ claude: "absent", codex: "present" }), runDoctor: async () => [] },
      });
      expect(code, c.err.join("\n")).toBe(0);
      expect(JSON.parse(readFileSync(paths.state, "utf8")).history.at(-1).reason).toBe("install");
      expect(existsSync(paths.lock)).toBe(true);
    } finally {
      await held.release();
      await t.cleanup();
    }
  });

  it("--reason install refuses while txn.json exists and keeps it (ruling R8)", async () => {
    const t = await makeTmp("main-apply-txn");
    const env = { ...isolatedEnv(t.dir), FACTORY_SOURCE: "http://127.0.0.1:1/x/ai-factory.git", PI_OFFLINE: "1" };
    const paths = factoryPaths(env);
    const pi = new (class extends PiRuntime {
      override async ensurePinned(): Promise<string> {
        throw new Error("must not run");
      }
    })();
    try {
      mkdirSync(paths.home, { recursive: true });
      writeFileSync(paths.txn, "{}");
      const c = capture();
      expect(await main(["_apply-release", "--reason", "install", "--yes"], c.io, { env, pi })).toBe(1);
      expect(c.err.join("\n")).toBe('A previous update did not finish. Run "factory rollback".');
      expect(readFileSync(paths.txn, "utf8")).toBe("{}");
    } finally {
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

describe("main update/rollback", () => {
  it("maps update --to/--yes and rollback <version>/--yes onto the commands", async () => {
    const w = await makeWorld("main-release");
    try {
      await writeState(w.paths, stateAt("0.2.0", [{ version: "0.2.0", at: "2026-10-01T00:00:00.000Z", reason: "install" }]));
      w.tags = ["v0.2.0"];
      const c = capture();
      expect(await main(["update", "--to", "v9.9.9", "--yes"], c.io, { env: w.env, releaseDeps: w.ctx().deps })).toBe(1);
      expect(c.err.join("\n")).toContain("Release v9.9.9 was not found");

      w.releases = { "v0.1.0": {} };
      const r = capture();
      expect(await main(["rollback", "v0.1.0", "--yes"], r.io, { env: w.env, releaseDeps: w.ctx().deps }), r.err.join("\n")).toBe(0);
      expect(w.log).toContain("clone v0.1.0");
      expect(w.log.at(-1)).toMatch(/_apply-release --reason rollback --from 0\.2\.0 --parent-lock \d+ --yes$/);
    } finally {
      await w.cleanup();
    }
  });
});

describe("unexpected errors (top-level catch)", () => {
  async function brokenRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const t = await makeTmp("main-broken");
    writeFileSync(`${t.dir}/release.json`, "{ not json");
    return { root: t.dir, cleanup: t.cleanup };
  }

  it("an error outside a command's own handling prints one line and exits 1, without a stack", async () => {
    const b = await brokenRoot();
    try {
      const c = capture();
      expect(await main(["version"], c.io, { root: b.root, env: {} })).toBe(1);
      expect(c.err).toHaveLength(1);
      expect(c.err[0]).toMatch(/^factory: .*JSON/);
      expect(c.err[0]).not.toContain("\n");
      expect(c.err[0]).toContain("FACTORY_DEBUG=1");
    } finally {
      await b.cleanup();
    }
  });

  it("FACTORY_DEBUG=1 adds the stack", async () => {
    const b = await brokenRoot();
    try {
      const c = capture();
      expect(await main(["version"], c.io, { root: b.root, env: { FACTORY_DEBUG: "1" } })).toBe(1);
      expect(c.err.join("\n")).toMatch(/\n\s+at /);
    } finally {
      await b.cleanup();
    }
  });
});
