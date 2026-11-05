// Route state in a real Pi 1.4.0 (faux provider): set_route opens the project for writes, the route survives a
// `--continue`, the routing prompt section and the per-call reminder reach the provider, and a steering message
// consumed mid-run (RPC mode) closes the route again until set_route re-declares it (ruling 20).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { ensureTestPi, runPiPrint, startPiRpc } from "../helpers/pi-harness.ts";
import { makeTmp } from "../helpers/tmp.ts";
import { RELEASE } from "../helpers/release-version.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAUX = join(ROOT, "test", "fixtures", "faux-provider.ts");
const EXTENSION = join(ROOT, "src", "adapters", "pi", "extension", "index.ts");
const OBSERVER = join(ROOT, "test", "fixtures", "observer.ts");
const isWin = process.platform === "win32";
const ANSWER_DENY = "the answer route cannot write";
const RECLASSIFY = "a new user message arrived: re-declare the route with set_route";

type Result = { event: "tool_result"; toolName: string; isError: boolean; text: string };
type LedgerEvent = { type: string } & Record<string, unknown>;

function jsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as T);
}

function results(file: string): Array<[string, boolean, string]> {
  return jsonLines<{ event: string } & Partial<Result>>(file)
    .filter((o): o is Result => o.event === "tool_result")
    .map((r) => [r.toolName, r.isError, r.text]);
}

/** Events of every run of the project, oldest run first. */
function ledgerRuns(factoryHome: string): LedgerEvent[][] {
  const runs = join(factoryHome, "runs");
  return readdirSync(runs)
    .flatMap((p) => readdirSync(join(runs, p)).map((r) => join(runs, p, r, "events.jsonl")))
    .sort()
    .map((f) => jsonLines<LedgerEvent>(f));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

let cli: string;
beforeAll(async () => {
  cli = await ensureTestPi();
}, 600_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A committed git project beside (never containing) the isolated factory home and Pi agent dir. */
async function setup() {
  const t = await makeTmp("route-e2e");
  cleanups.push(t.cleanup);
  const env = isolatedEnv(t.dir);
  const home = env.FACTORY_HOME as string;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      schema: 1,
      version: RELEASE,
      installedAt: "2026-10-31T00:00:00.000Z",
      source: "https://github.com/jrevenga/ai-factory.git",
      piVersion: "1.4.0",
      piCli: "/nonexistent/cli.js",
      history: [{ version: RELEASE, at: "2026-10-31T00:00:00.000Z", reason: "install" }],
    }),
  );
  const project = join(t.dir, "project");
  mkdirSync(project);
  git(project, "init", "-q");
  writeFileSync(join(project, "README.md"), "x\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "init");
  const log = join(t.dir, "observed.jsonl");
  env.OBSERVE_FILE = log;
  return { dir: t.dir, env, home, project, realProject: realpathSync.native(project), log, agentDir: env.PI_CODING_AGENT_DIR as string };
}

describe("route state (e2e, faux provider)", () => {
  it("a write is blocked on the answer route and allowed in the project after set_route small; the prompt carries the routing rule and the reminder", async () => {
    const s = await setup();
    const capture = join(s.dir, "capture.jsonl");
    s.env.FAUX_CAPTURE = capture;
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "write", args: { path: join(s.project, "before.txt"), content: "x" } },
      { tool: "set_route", args: { route: "small", reason: "add a file" } },
      { tool: "write", args: { path: join(s.project, "after.txt"), content: "y" } },
    ]);
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER] });
    expect(r.timedOut).toBe(false);
    expect(r.code, r.stderr).toBe(0);

    const res = results(s.log);
    expect(res.map(([n, e]) => [n, e])).toEqual([
      ["write", true],
      ["set_route", false],
      ["write", false],
    ]);
    expect(res[0]?.[2]).toContain(ANSWER_DENY);
    expect(res[1]?.[2]).toBe("Route: small — add a file");
    expect(existsSync(join(s.project, "before.txt"))).toBe(false);
    expect(readFileSync(join(s.project, "after.txt"), "utf8")).toBe("y");

    const [events] = ledgerRuns(s.home);
    const route = events!.filter((e) => e.type === "route");
    expect(route).toEqual([
      expect.objectContaining({
        reason: "set_route",
        state: { route: "small", tier: "small", reason: "add a file", writeRoots: [s.realProject], needsReclassification: false, base: git(s.project, "rev-parse", "HEAD") },
      }),
    ]);

    // Every provider call saw the routing section and, last, the route reminder (answer, answer, small, small).
    const calls = jsonLines<{ messages: Array<{ role: string; content: unknown; sections?: Record<string, string> }> }>(capture);
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      const sections = c.messages.find((m) => m.role === "system" && m.sections?.["factory-routing"] !== undefined)?.sections;
      expect(sections?.["factory-routing"]).toContain("Declare the route with set_route before modifying anything");
    }
    const reminders = calls.map((c) => JSON.stringify(c.messages.at(-1)));
    expect(reminders.map((m) => /"role":"user"/.test(m))).toEqual([true, true, true, true]);
    expect(reminders.map((m) => /Current route: (\w+)/.exec(m)?.[1])).toEqual(["answer", "answer", "small", "small"]);
  }, 120_000);

  it("the declared route survives `--continue`: the next session restores it from its session entries", async () => {
    const s = await setup();
    const sessions = join(s.dir, "sessions");
    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "set_route", args: { route: "small", reason: "edit docs" } }]);
    const first = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER], sessionDir: sessions });
    expect(first.code, first.stderr).toBe(0);

    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "write", args: { path: join(s.project, "resumed.txt"), content: "z" } }]);
    const second = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER], sessionDir: sessions, args: ["--continue"] });
    expect(second.code, second.stderr).toBe(0);
    expect(results(s.log).map(([n, e]) => [n, e])).toEqual([
      ["set_route", false],
      ["write", false],
    ]);
    expect(readFileSync(join(s.project, "resumed.txt"), "utf8")).toBe("z");
    const runs = ledgerRuns(s.home);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.find((e) => e.type === "route")).toMatchObject({ reason: "restored from session", state: { route: "small", reason: "edit docs" } });
  }, 120_000);

  it("C1: a session forked into another project does not carry its route there (the write is blocked)", async () => {
    const s = await setup();
    const sessions = join(s.dir, "sessions");
    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "set_route", args: { route: "small", reason: "fix typo in A" } }]);
    const first = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER], sessionDir: sessions });
    expect(first.code, first.stderr).toBe(0);
    const files = (readdirSync(sessions, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const other = join(s.dir, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    writeFileSync(join(other, "README.md"), "y\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "init");
    const pwned = join(other, "pwned.txt");
    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "write", args: { path: pwned, content: "x" } }]);
    const second = await runPiPrint({
      cli,
      agentDir: s.agentDir,
      cwd: other,
      env: s.env,
      extensions: [FAUX, EXTENSION, OBSERVER],
      sessionDir: sessions,
      args: ["--fork", join(sessions, files[0]!)],
    });
    expect(second.code, second.stderr).toBe(0);
    expect(results(s.log).map(([n, e]) => [n, e])).toEqual([
      ["set_route", false],
      ["write", true],
    ]);
    expect(existsSync(pwned)).toBe(false);
    expect(second.stderr).toContain(`declared for ${s.realProject}`);
  }, 120_000);

  it("RPC steering: a user message consumed mid-run blocks the next write until set_route re-declares the route", async () => {
    const s = await setup();
    const signal = join(s.dir, "held");
    const release = join(s.dir, "release");
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "set_route", args: { route: "small", reason: "first task" } },
      // Held: the steer is queued while this call is in flight and delivered after its tool runs.
      { tool: "write", args: { path: join(s.project, "a.txt"), content: "a" }, hold: { signal, release } },
      { tool: "write", args: { path: join(s.project, "b.txt"), content: "b" } },
      { tool: "set_route", args: { route: "small", reason: "steered task" } },
      { tool: "write", args: { path: join(s.project, "c.txt"), content: "c" } },
    ]);
    const rpc = startPiRpc({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER] });
    try {
      const prompt = await rpc.request({ type: "prompt", message: "go" });
      expect(prompt).toMatchObject({ success: true });
      const deadline = Date.now() + 60_000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error(`the held call never started; stderr:\n${rpc.stderr()}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      const steer = await rpc.request({ type: "steer", message: "stop, do something else instead" });
      expect(steer).toMatchObject({ success: true, data: { disposition: "queued" } });
      writeFileSync(release, "");
      await rpc.waitFor((r) => r.type === "agent_settled", 60_000);
    } finally {
      const closed = await rpc.close();
      expect(closed.killed, rpc.stderr()).toBe(false);
    }

    const res = results(s.log);
    expect(res.map(([n, e]) => [n, e])).toEqual([
      ["set_route", false],
      ["write", false],
      ["write", true],
      ["set_route", false],
      ["write", false],
    ]);
    expect(res[2]?.[2]).toContain(RECLASSIFY);
    expect(existsSync(join(s.project, "a.txt"))).toBe(true);
    expect(existsSync(join(s.project, "b.txt"))).toBe(false);
    expect(existsSync(join(s.project, "c.txt"))).toBe(true);
    // No dialog was needed: every decision here is allow or deny.
    expect(rpc.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm")).toEqual([]);

    const [events] = ledgerRuns(s.home);
    const route = events!.filter((e) => e.type === "route").map((e) => [e.reason, (e.state as { needsReclassification: boolean }).needsReclassification, e.input]);
    expect(route).toEqual([
      ["set_route", false, undefined],
      ["user input consumed", true, "stop, do something else instead"],
      ["set_route", false, undefined],
    ]);
  }, 180_000);

  it("Task 10: run_check runs a command declared in .factory/config.json after the gate clears it and records it in the ledger; a prefix match is denied", async () => {
    const s = await setup();
    mkdirSync(join(s.project, "scripts"));
    writeFileSync(join(s.project, "scripts", "ok.mjs"), 'console.log("checks passed");\n');
    mkdirSync(join(s.project, ".factory"));
    writeFileSync(join(s.project, ".factory", "config.json"), JSON.stringify({ schema: 1, commands: { test: "node scripts/ok.mjs" } }));
    git(s.project, "add", "-A");
    git(s.project, "commit", "-q", "-m", "declare the test command");
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "set_route", args: { route: "small", reason: "verify" } },
      { tool: "run_check", args: { command: "node scripts/ok.mjs" } },
      { tool: "run_check", args: { command: "node scripts/ok.mjs --extra" } },
    ]);
    const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions: [FAUX, EXTENSION, OBSERVER] });
    expect(r.timedOut).toBe(false);
    expect(r.code, r.stderr).toBe(0);
    const res = results(s.log);
    expect(res.map(([n, e]) => [n, e])).toEqual([
      ["set_route", false],
      ["run_check", false],
      ["run_check", true],
    ]);
    expect(res[1]?.[2]).toContain("exit 0");
    expect(res[1]?.[2]).toContain("checks passed");
    expect(res[2]?.[2]).toContain("run_check runs only read-only, allowlisted or project-declared commands");
    const [events] = ledgerRuns(s.home);
    const checks = events!.filter((e) => e.type === "check").map((e) => e.record as Record<string, unknown>);
    expect(checks).toEqual([expect.objectContaining({ exitCode: 0, mutated: false, declaredAs: "test", cwd: s.realProject })]);
    expect(readFileSync(checks[0]!.logPath as string, "utf8")).toContain("checks passed");
  }, 180_000);
});
