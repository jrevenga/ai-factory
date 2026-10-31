import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { ensureTestPi, runPiPrint } from "../helpers/pi-harness.ts";
import { makeTmp } from "../helpers/tmp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAUX = join(ROOT, "test", "fixtures", "faux-provider.ts");
const EXTENSION = join(ROOT, "src", "adapters", "pi", "extension", "index.ts");
const OBSERVER = join(ROOT, "test", "fixtures", "observer.ts");

type Observed = { event: "handshake"; data: unknown } | { event: "tool_result"; toolName: string; isError: boolean; text: string };
function observed(file: string): Observed[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Observed);
}

let cli: string;
beforeAll(async () => {
  cli = await ensureTestPi();
}, 600_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(stateVersion: string | undefined) {
  const t = await makeTmp("handshake-e2e");
  cleanups.push(t.cleanup);
  const env = isolatedEnv(t.dir);
  const home = env.FACTORY_HOME as string;
  mkdirSync(home, { recursive: true });
  if (stateVersion !== undefined) {
    const state = {
      schema: 1,
      version: stateVersion,
      installedAt: "2026-10-31T00:00:00.000Z",
      source: "https://github.com/jrevenga/ai-factory.git",
      piVersion: "1.4.0",
      piCli: "/nonexistent/cli.js",
      history: [{ version: stateVersion, at: "2026-10-31T00:00:00.000Z", reason: "install" }],
    };
    writeFileSync(join(home, "state.json"), JSON.stringify(state));
  }
  const out = join(t.dir, "out.txt");
  env.FAUX_SCRIPT = JSON.stringify([{ tool: "write", args: { path: out, content: "x" } }]);
  return { dir: t.dir, env, out, agentDir: env.PI_CODING_AGENT_DIR as string };
}

describe("Pi startup handshake (e2e, faux provider)", () => {
  it("harness self-check: the faux provider alone performs the scripted write", async () => {
    const s = await setup(undefined);
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [FAUX] });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(s.out)).toBe(true);
  }, 120_000);

  it("valid state at the package version: the handshake passes and the write happens", async () => {
    const s = await setup("0.1.0");
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [FAUX, EXTENSION] });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(s.out)).toBe(true);
  }, 120_000);

  it("state at another version: the write is blocked and the output names version-mismatch", async () => {
    const s = await setup("9.9.9");
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [FAUX, EXTENSION] });
    expect(existsSync(s.out)).toBe(false);
    expect(r.stdout + r.stderr).toContain("version-mismatch");
  }, 120_000);

  it("no state: the write is blocked as not-installed", async () => {
    const s = await setup(undefined);
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [EXTENSION, FAUX] });
    expect(existsSync(s.out)).toBe(false);
    expect(r.stdout + r.stderr).toContain("not-installed");
  }, 120_000);

  it("emits factory:handshake to other extensions in either load order", async () => {
    for (const order of [
      [FAUX, OBSERVER, EXTENSION],
      [FAUX, EXTENSION, OBSERVER],
    ]) {
      const s = await setup("0.1.0");
      const log = join(s.dir, "observed.jsonl");
      s.env.OBSERVE_FILE = log;
      s.env.FAUX_SCRIPT = "[]";
      const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: order });
      expect(r.code, r.stderr).toBe(0);
      expect(observed(log).filter((o) => o.event === "handshake")).toEqual([
        { event: "handshake", data: { ok: true, version: "0.1.0", policy: "none", reasons: [] } },
      ]);
    }
  }, 120_000);

  it("a failed handshake still allows read-only tools and blocks the rest with the reason", async () => {
    const s = await setup("9.9.9");
    const log = join(s.dir, "observed.jsonl");
    s.env.OBSERVE_FILE = log;
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "read", args: { path: join(s.env.FACTORY_HOME as string, "state.json") } },
      { tool: "bash", args: { command: "echo hi" } },
      { tool: "write", args: { path: s.out, content: "x" } },
    ]);
    await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER] });
    const o = observed(log);
    expect(o.find((x) => x.event === "handshake")).toEqual({
      event: "handshake",
      data: { ok: false, version: "0.1.0", policy: "none", reasons: ["version-mismatch"] },
    });
    const results = o.filter((x) => x.event === "tool_result");
    expect(results.map((x) => [x.toolName, x.isError])).toEqual([
      ["read", false],
      ["bash", true],
      ["write", true],
    ]);
    for (const x of results.slice(1)) expect(x.text).toContain("factory handshake failed: version-mismatch");
    expect(existsSync(s.out)).toBe(false);
  }, 120_000);

  it("an invalid personal config or an unwritable store fails the handshake", async () => {
    const s = await setup("0.1.0");
    writeFileSync(join(s.env.FACTORY_HOME as string, "config.json"), "{ not json");
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [FAUX, EXTENSION] });
    expect(existsSync(s.out)).toBe(false);
    expect(r.stderr).toContain("factory handshake failed: config-invalid");

    const s2 = await setup("0.1.0");
    s2.env.FACTORY_HOME = join(s2.dir, "missing home");
    const r2 = await runPiPrint({ cli, agentDir: s2.agentDir, cwd: s2.dir, env: s2.env, extensions: [FAUX, EXTENSION] });
    expect(existsSync(s2.out)).toBe(false);
    expect(r2.stderr).toContain("factory handshake failed: not-installed, store-unwritable");
  }, 120_000);
});
