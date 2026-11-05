import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { ensureTestPi, runPiPrint } from "../helpers/pi-harness.ts";
import { makeTmp } from "../helpers/tmp.ts";
import { RELEASE } from "../helpers/release-version.ts";

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

/** Every event of the single run under `<FACTORY_HOME>/runs/<projectId>/<runId>/events.jsonl`. */
function ledgerEvents(factoryHome: string): Array<{ type: string } & Record<string, unknown>> {
  const runs = join(factoryHome, "runs");
  const files = readdirSync(runs).flatMap((p) => readdirSync(join(runs, p)).map((r) => join(runs, p, r, "events.jsonl")));
  expect(files).toHaveLength(1);
  return readFileSync(files[0]!, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { type: string } & Record<string, unknown>);
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

/** A blocked run still completes normally; the write's tool result carries the handshake reason. */
async function expectBlocked(s: Awaited<ReturnType<typeof setup>>, extensions: string[], reasons: string) {
  const log = join(s.dir, "observed.jsonl");
  s.env.OBSERVE_FILE = log;
  const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [...extensions, OBSERVER] });
  expect(r.timedOut).toBe(false);
  expect(r.code, r.stderr).toBe(0);
  expect(existsSync(s.out)).toBe(false);
  expect(r.stderr).toContain(`factory handshake failed: ${reasons}`);
  const writes = observed(log).filter((o) => o.event === "tool_result" && o.toolName === "write");
  expect(writes).toEqual([{ event: "tool_result", toolName: "write", isError: true, text: `factory handshake failed: ${reasons}` }]);
}

describe("Pi startup handshake (e2e, faux provider)", () => {
  it("harness self-check: the faux provider alone performs the scripted write", async () => {
    const s = await setup(undefined);
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [FAUX] });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(s.out)).toBe(true);
  }, 120_000);

  it("valid state at the package version: the handshake passes and the GatePolicy decides, audited in the run ledger", async () => {
    const s = await setup(RELEASE);
    const log = join(s.dir, "observed.jsonl");
    s.env.OBSERVE_FILE = log;
    // The project sits beside the factory home: a write root may not contain it (set_route, review M6).
    const project = join(s.dir, "project");
    mkdirSync(project);
    const out = join(project, "out.txt");
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "bash", args: { command: "echo gate-ok" } },
      { tool: "write", args: { path: out, content: "x" } },
      { tool: "set_route", args: { route: "small", reason: "write out.txt" } },
      { tool: "write", args: { path: out, content: "x" } },
    ]);
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: project, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER] });
    expect(r.timedOut).toBe(false);
    expect(r.code, r.stderr).toBe(0);
    const results = observed(log).filter((o) => o.event === "tool_result");
    expect(results.map((x) => [x.toolName, x.isError])).toEqual([
      ["bash", false],
      ["write", true],
      ["set_route", false],
      ["write", false],
    ]);
    expect(results[0]?.text).toContain("gate-ok");
    // No route declared yet: the answer route is read-only.
    expect(results[1]?.text).toContain("the answer route cannot write");
    // After set_route small the project root is writable.
    expect(results[2]?.text).toBe("Route: small — write out.txt");
    expect(readFileSync(out, "utf8")).toBe("x");

    const events = ledgerEvents(s.env.FACTORY_HOME as string);
    expect(events.map((e) => e.type)).toEqual(["run_start", "gate", "gate", "gate", "route", "gate", "run_end"]);
    expect(events[1]).toMatchObject({ tool: "bash", decision: "allow", class: "read-only", summary: "echo gate-ok" });
    expect(events[2]).toMatchObject({ tool: "write", decision: "deny" });
    expect(events[3]).toMatchObject({ tool: "set_route", decision: "allow" });
    expect(events[4]).toMatchObject({ reason: "set_route", state: { route: "small", reason: "write out.txt" } });
    expect(events[5]).toMatchObject({ tool: "write", decision: "allow" });
  }, 120_000);

  it("state at another version: the write is blocked and the output names version-mismatch", async () => {
    await expectBlocked(await setup("9.9.9"), [FAUX, EXTENSION], "version-mismatch");
  }, 120_000);

  it("no state: the write is blocked as not-installed", async () => {
    await expectBlocked(await setup(undefined), [EXTENSION, FAUX], "not-installed");
  }, 120_000);

  it("emits factory:handshake to other extensions in either load order", async () => {
    for (const order of [
      [FAUX, OBSERVER, EXTENSION],
      [FAUX, EXTENSION, OBSERVER],
    ]) {
      const s = await setup(RELEASE);
      const log = join(s.dir, "observed.jsonl");
      s.env.OBSERVE_FILE = log;
      s.env.FAUX_SCRIPT = "[]";
      const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: order });
      expect(r.code, r.stderr).toBe(0);
      expect(observed(log).filter((o) => o.event === "handshake")).toEqual([
        { event: "handshake", data: { ok: true, version: RELEASE, policy: "v1", reasons: [] } },
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
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER] });
    expect(r.timedOut).toBe(false);
    expect(r.code, r.stderr).toBe(0);
    const o = observed(log);
    expect(o.find((x) => x.event === "handshake")).toEqual({
      event: "handshake",
      data: { ok: false, version: RELEASE, policy: "v1", reasons: ["version-mismatch"] },
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

  it("an invalid personal config fails the handshake", async () => {
    const s = await setup(RELEASE);
    writeFileSync(join(s.env.FACTORY_HOME as string, "config.json"), "{ not json");
    await expectBlocked(s, [FAUX, EXTENSION], "config-invalid");
  }, 120_000);

  it("a missing (unwritable) store fails the handshake", async () => {
    const s = await setup(RELEASE);
    s.env.FACTORY_HOME = join(s.dir, "missing home");
    await expectBlocked(s, [FAUX, EXTENSION], "not-installed, store-unwritable");
  }, 120_000);
});
