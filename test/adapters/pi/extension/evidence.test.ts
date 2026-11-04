import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { currentRoute as currentRouteForTest, enforce, GatedChecks, InFlightCalls, MachinePostChecks, setRoute, type GateUi } from "../../../../src/adapters/pi/extension/enforce.ts";
import {
  CheckOutput,
  fingerprint,
  loadEvidence,
  RECORD_DECISION_TOOL,
  RECORD_REVIEW_TOOL,
  registerEvidence,
  RUN_CHECK_TOOL,
  type EvidenceSession,
} from "../../../../src/adapters/pi/extension/evidence.ts";
import { gitRun, resolveProgram, safePathEntries } from "../../../../src/adapters/pi/extension/facts.ts";
import { RunLedger } from "../../../../src/adapters/pi/extension/ledger.ts";
import type { SoftGateId } from "../../../../src/core/config/schema.ts";
import { SIMPLE_COMMANDS_ONLY } from "../../../../src/core/evidence/check-plan.ts";
import { validateDelivery, type CheckRecord, type ReviewDisposition } from "../../../../src/core/evidence/records.ts";
import type { RunEvent } from "../../../../src/core/ledger/events.ts";
import type { AutonomyLevel } from "../../../../src/core/policy/autonomy.ts";
import type { GateContext } from "../../../../src/core/policy/gate.ts";
import { INITIAL_ROUTE } from "../../../../src/core/route/route.ts";
import type { RouteState } from "../../../../src/core/route/types.ts";
import { MACHINE_CLOSE, MACHINE_OPEN, parseMachine, renderMachine } from "../../../../src/core/task/machine.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const isWin = process.platform === "win32";
const RUN_ID = "20261104T120000Z-1";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const ORIGINAL_PATH = process.env.PATH ?? "";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRoute(INITIAL_ROUTE);
  vi.stubEnv("PATH", ORIGINAL_PATH);
  for (const c of cleanups.splice(0)) await c();
});
beforeAll(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", isWin ? "NUL" : "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

const SCRIPTS: Record<string, string> = {
  "ok.mjs": 'console.log("ok line 1");\nconsole.log("all checks passed");\n',
  "fail.mjs": 'console.error("failing check");\nprocess.exit(3);\n',
  "mutate.mjs": 'import { writeFileSync } from "node:fs";\nwriteFileSync("README.md", "changed by the check\\n");\nconsole.log("mutated");\n',
  "leak.mjs": [
    `console.log("token ${TOKEN} printed");`,
    'console.error("password=hunter2");',
    'console.log("-----BEGIN RSA PRIVATE KEY-----");',
    'console.log("MIIEowIBAAKCAQEAsecretkeybody");',
    'console.log("-----END RSA PRIVATE KEY-----");',
    'process.stdout.write("tail without newline");',
  ].join("\n"),
  "hang.mjs": [
    'import { spawn } from "node:child_process";',
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'const c = spawn(process.execPath, ["scripts/sleeper.mjs"], { stdio: "ignore" });',
    'mkdirSync("out", { recursive: true });',
    'writeFileSync("out/grandchild.pid", String(c.pid));',
    'writeFileSync("out/hang.pid", String(process.pid));',
    'console.log("hanging");',
    "setInterval(() => {}, 1000);",
  ].join("\n"),
  "sleeper.mjs": "setInterval(() => {}, 1000);\n",
  "rewrite-task.mjs": [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const f = ".factory/knowledge/tasks/t1.md";',
    'writeFileSync(f, readFileSync(f, "utf8").replace("phase: build", "phase: hacked"));',
  ].join("\n"),
};
const DECLARED = Object.keys(SCRIPTS)
  .filter((f) => f !== "sleeper.mjs")
  .map((f) => ({ name: f.replace(/\.mjs$/, ""), argv: ["node", `scripts/${f}`] }));
const TASK_TEXT = `# Task t1\n\n${renderMachine({ phase: "build", run: "r-0" })}\n\n## Notes\n\nfree text\n`;

interface ToolLike {
  name: string;
  executionMode?: string;
  parameters: unknown;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; details: unknown }>;
}

let seq = 0;

async function world(
  opts: {
    declared?: Array<{ name: string; argv: string[] }>;
    autonomy?: AutonomyLevel;
    softened?: SoftGateId[];
    effectiveTools?: () => Array<{ name: string; parameters: unknown }>;
    teardown?: EvidenceSession["teardown"];
  } = {},
) {
  const t = await makeTmp("evidence");
  cleanups.push(t.cleanup);
  const dir = realpathSync.native(t.dir);
  const project = join(dir, "project");
  mkdirSync(join(project, "scripts"), { recursive: true });
  git(project, "init", "-q");
  git(project, "config", "user.name", "Factory Test");
  git(project, "config", "user.email", "factory-test@example.invalid");
  writeFileSync(join(project, "README.md"), "readme\n");
  writeFileSync(join(project, ".gitignore"), "out/\n");
  writeFileSync(join(project, ".npmrc"), "registry=https://registry.example.invalid/\n");
  for (const [f, body] of Object.entries(SCRIPTS)) writeFileSync(join(project, "scripts", f), body);
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "init");
  const wt = join(dir, "wt");
  git(project, "worktree", "add", "-q", "-b", "factory/t1", wt);
  const taskFile = join(wt, ".factory", "knowledge", "tasks", "t1.md");
  mkdirSync(join(wt, ".factory", "knowledge", "tasks"), { recursive: true });
  writeFileSync(taskFile, TASK_TEXT);

  const ledgerDir = join(dir, "factory home", "runs", "proj");
  const ledger = new RunLedger(ledgerDir, RUN_ID);
  ledger.append({ v: 1, ts: new Date().toISOString(), runId: RUN_ID, type: "run_start", pid: process.pid, projectId: "proj", projectRoot: project, factoryVersion: "0.0.0" });
  const runDir = join(ledgerDir, RUN_ID);
  const home = join(dir, "home");
  const piAgentDir = join(dir, "pi agent");
  const declared = opts.declared ?? DECLARED;
  const gatedChecks = new GatedChecks();
  const session: EvidenceSession = {
    ledger,
    runId: RUN_ID,
    runDir,
    projectRoot: project,
    home,
    piAgentDir,
    autonomy: opts.autonomy ?? "medium",
    softened: opts.softened ?? [],
    projectCommands: declared.map((d) => d.argv),
    declared,
    gatedChecks,
    ...(opts.teardown !== undefined ? { teardown: opts.teardown } : {}),
  };
  const tools: ToolLike[] = [];
  const pi = {
    registerTool: (tool: ToolLike) => void tools.push(tool),
    getAllTools: () => (opts.effectiveTools ? opts.effectiveTools() : tools.map((x) => ({ name: x.name, parameters: x.parameters }))),
  };
  const factoryTools = new Set<string>();
  const handle = registerEvidence(pi as never, { session: async () => session, factoryTools });
  const tool = (name: string) => tools.find((x) => x.name === name)!;
  const postChecks = new MachinePostChecks();
  const inFlight = new InFlightCalls();

  const small: RouteState = { route: "small", tier: "small", taskId: "fix-1", reason: "fix", writeRoots: [project], needsReclassification: false };
  const feature: RouteState = { route: "feature", tier: "feature", taskId: "t1", reason: "feature", worktree: wt, writeRoots: [wt], needsReclassification: false };
  const answer: RouteState = { route: "answer", writeRoots: [], needsReclassification: false };

  const context = (mode: "interactive" | "unattended"): GateContext => ({
    route: { ...currentRouteForTest() },
    mode,
    autonomy: session.autonomy,
    home: realpathSync.native(homedir()),
    piAgentDir,
    projectRoot: project,
    tmpRoots: [],
    ledgerDir: join(dir, "factory home", "runs"),
    projectCommands: session.projectCommands,
    taskFileExists: true,
    gitDirs: [],
  });

  /** The Pi flow for one run_check call: tool_call hook, execute, tool_result hook. */
  async function check(command: string, o: { ui?: GateUi; mode?: "interactive" | "unattended"; timeoutSec?: number; input?: Record<string, unknown> } = {}) {
    const id = `call-${++seq}`;
    const input = { command, ...(o.timeoutSec !== undefined ? { timeoutSec: o.timeoutSec } : {}) };
    const blocked = await enforce({ toolName: RUN_CHECK_TOOL, toolCallId: id, input }, { cwd: project }, {
      policyContext: () => context(o.mode ?? (o.ui ? "interactive" : "unattended")),
      ledger,
      runId: RUN_ID,
      home: homedir(),
      postChecks,
      inFlight,
      factoryTools,
      gatedChecks,
      ...(o.ui ? { ui: o.ui } : {}),
    });
    if (blocked !== undefined) return { blocked: blocked.reason, id };
    const res = await tool(RUN_CHECK_TOOL).execute(id, o.input ?? input, undefined, undefined, {});
    const post = postChecks.afterToolResult({ toolCallId: id, content: res.content as never, isError: res.isError === true }, ledger, RUN_ID);
    inFlight.done(id);
    return { res, post, id, text: res.content.map((c) => c.text ?? "").join("\n"), record: res.details as CheckRecord | undefined };
  }

  const events = () => RunLedger.read(ledger.file);
  return { dir, project, wt, taskFile, ledgerDir, ledger, runDir, session, tools, tool, factoryTools, handle, postChecks, inFlight, small, feature, answer, check, events, context };
}

const approve = (): GateUi => ({ confirm: async () => true });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function blobExists(cwd: string, file: string): boolean {
  const sha = git(cwd, "hash-object", "--", file);
  try {
    execFileSync("git", ["cat-file", "-e", sha], { cwd, env: GIT_ENV, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("fingerprint (ruling 11)", () => {
  it("is stable under task-file edits and new task files, changes on a code edit and on a new untracked file", async () => {
    const x = await world();
    const fp = fingerprint(x.wt);
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(x.taskFile, `${TASK_TEXT}\nmore notes\n`);
    writeFileSync(join(x.wt, ".factory", "knowledge", "tasks", "other.md"), "other task\n");
    expect(fingerprint(x.wt)).toBe(fp);
    // A committed task file (a checkpoint) still does not count.
    git(x.wt, "add", "-A");
    git(x.wt, "commit", "-q", "-m", "checkpoint");
    writeFileSync(x.taskFile, `${TASK_TEXT}\nafter the checkpoint\n`);
    expect(fingerprint(x.wt)).toBe(fp);

    writeFileSync(join(x.wt, "README.md"), "edited\n");
    const edited = fingerprint(x.wt);
    expect(edited).not.toBe(fp);
    writeFileSync(join(x.wt, "new.ts"), "export {};\n");
    const added = fingerprint(x.wt);
    expect(added).not.toBe(edited);
    // Ignored output does not count.
    mkdirSync(join(x.wt, "out"), { recursive: true });
    writeFileSync(join(x.wt, "out", "build.log"), "x\n");
    expect(fingerprint(x.wt)).toBe(added);
  });

  it("never writes the user's index and leaves no temporary index behind", async () => {
    const x = await world();
    writeFileSync(join(x.project, "README.md"), "edited\n");
    writeFileSync(join(x.project, "staged.ts"), "1\n");
    git(x.project, "add", "staged.ts");
    const index = join(x.project, ".git", "index");
    const before = readFileSync(index);
    const status = git(x.project, "status", "--porcelain");
    const temps = () => readdirSync(tmpdir()).filter((n) => n.startsWith("factory-fingerprint-")).length;
    const tempsBefore = temps();
    fingerprint(x.project);
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(git(x.project, "status", "--porcelain")).toBe(status);
    expect(temps()).toBe(tempsBefore);
  });

  it("decision 6: changed secret-path files count by hash but their blobs are never written into .git/objects", async () => {
    const x = await world();
    const fp = fingerprint(x.project);
    writeFileSync(join(x.project, ".env.local"), `API_KEY=${TOKEN}\n`);
    writeFileSync(join(x.project, ".npmrc"), `//registry.example.invalid/:_authToken=${TOKEN}\n`);
    const withSecrets = fingerprint(x.project);
    expect(withSecrets).not.toBe(fp);
    expect(blobExists(x.project, ".env.local")).toBe(false);
    expect(blobExists(x.project, ".npmrc")).toBe(false);
    writeFileSync(join(x.project, ".env.local"), `API_KEY=${TOKEN}-rotated\n`);
    expect(fingerprint(x.project)).not.toBe(withSecrets);
    expect(blobExists(x.project, ".env.local")).toBe(false);
    // A non-secret file is fingerprinted the ordinary way.
    writeFileSync(join(x.project, "plain.ts"), "export const plain = 1;\n");
    fingerprint(x.project);
    expect(blobExists(x.project, "plain.ts")).toBe(true);
  });

  it("fails outside a git work tree", async () => {
    const t = await makeTmp("evidence-nogit");
    cleanups.push(t.cleanup);
    expect(() => fingerprint(t.dir)).toThrow(/not inside a git work tree/);
  });
});

describe("tool registration", () => {
  it("registers run_check, record_review and record_decision as sequential factory tools; a shadowed name is dropped", async () => {
    const x = await world();
    expect(x.tools.map((t) => t.name)).toEqual([RUN_CHECK_TOOL, RECORD_REVIEW_TOOL, RECORD_DECISION_TOOL]);
    for (const t of x.tools) expect(t.executionMode).toBe("sequential");
    x.handle.verifyTools();
    expect([...x.factoryTools]).toEqual([RUN_CHECK_TOOL, RECORD_REVIEW_TOOL, RECORD_DECISION_TOOL]);
    const shadowed = await world({ effectiveTools: () => [{ name: RUN_CHECK_TOOL, parameters: { type: "object" } }] });
    shadowed.handle.verifyTools();
    expect(shadowed.factoryTools.has(RUN_CHECK_TOOL)).toBe(false);
  });
});

describe("run_check", () => {
  it("records a declared command: exit 0, fingerprints before and after, the log and the last lines", async () => {
    const x = await world();
    setRoute(x.small);
    const r = await x.check("node scripts/ok.mjs");
    expect(r.blocked).toBeUndefined();
    const rec = r.record!;
    expect(rec).toMatchObject({ command: "node scripts/ok.mjs", exitCode: 0, cwd: x.project, mutated: false, declaredAs: "ok" });
    expect(rec.id).toMatch(/^chk-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(rec.fingerprint).toBe(fingerprint(x.project));
    expect(rec.fingerprintAfter).toBe(rec.fingerprint);
    expect(rec.logPath).toBe(join(x.runDir, "checks", `${rec.id}.log`));
    const log = readFileSync(rec.logPath, "utf8");
    expect(log).toContain("$ node scripts/ok.mjs");
    expect(log).toContain("all checks passed");
    expect(r.text).toContain("exit 0");
    expect(r.text).toContain("ok line 1\nall checks passed");
    const checks = x.events().filter((e): e is Extract<RunEvent, { type: "check" }> => e.type === "check");
    expect(checks.map((e) => e.record)).toEqual([rec]);
    const gate = x.events().filter((e) => e.type === "gate");
    expect(gate).toEqual([expect.objectContaining({ tool: RUN_CHECK_TOOL, decision: "allow" })]);
  });

  it("rejects an unknown command (node -e) and the prefix of a declared command; the owner is never asked", async () => {
    const x = await world();
    setRoute(x.small);
    const asked: string[] = [];
    const ui: GateUi = { confirm: async (title) => (asked.push(title), true) };
    for (const cmd of ['node -e "process.exit"', "node scripts/ok.mjs --extra"]) {
      const r = await x.check(cmd, { ui });
      expect(r.blocked, cmd).toContain("run_check runs only read-only, allowlisted or project-declared commands");
    }
    expect(asked).toEqual([]);
    expect(x.events().some((e) => e.type === "check")).toBe(false);
  });

  it("rejects pipelines, other operators and redirections", async () => {
    const x = await world();
    setRoute(x.small);
    for (const cmd of ["node scripts/ok.mjs | cat", "node scripts/ok.mjs; node scripts/ok.mjs", "node scripts/ok.mjs > out/x.txt"]) {
      const r = await x.check(cmd, { ui: approve() });
      expect(r.blocked, cmd).toContain(SIMPLE_COMMANDS_ONLY);
    }
  });

  it("runs `&&` segments in order and stops at the first failure", async () => {
    const x = await world();
    setRoute(x.small);
    const r = await x.check("node scripts/fail.mjs && node scripts/ok.mjs");
    expect(r.record).toMatchObject({ exitCode: 3, mutated: false });
    const log = readFileSync(r.record!.logPath, "utf8");
    expect(log).toContain("failing check");
    expect(log).not.toContain("all checks passed");
    expect(r.record!.declaredAs).toBeUndefined();
  });

  it("a declared command that rewrites a tracked file is recorded as mutated and never satisfies delivery", async () => {
    const x = await world();
    setRoute(x.small);
    const r = await x.check("node scripts/mutate.mjs");
    const rec = r.record!;
    expect(rec.exitCode).toBe(0);
    expect(rec.mutated).toBe(true);
    expect(rec.fingerprintAfter).not.toBe(rec.fingerprint);
    expect(r.text).toContain("mutated");
    const v = validateDelivery({ taskId: "fix-1", tier: "small", fingerprint: rec.fingerprintAfter, checks: [rec], dispositions: [], requiredCheckIds: [rec.id] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join("\n")).toContain("mutated the working tree");
  });

  it("a check followed by a further edit no longer validates delivery (fingerprint mismatch)", async () => {
    const x = await world();
    setRoute(x.small);
    const rec = (await x.check("node scripts/ok.mjs")).record!;
    const current = fingerprint(x.project);
    expect(validateDelivery({ taskId: "fix-1", tier: "small", fingerprint: current, checks: [rec], dispositions: [], requiredCheckIds: [rec.id] })).toEqual({ ok: true });
    writeFileSync(join(x.project, "README.md"), "edited after the check\n");
    const v = validateDelivery({ taskId: "fix-1", tier: "small", fingerprint: fingerprint(x.project), checks: [rec], dispositions: [], requiredCheckIds: [rec.id] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join("\n")).toContain("different fingerprint");
  });

  it("decision 1: hard gates apply unchanged — a secret read asks (denied without a UI, runs when approved) and an outside-root write asks", async () => {
    const x = await world();
    setRoute(x.small);
    writeFileSync(join(x.project, ".env"), `API_KEY=${TOKEN}\n`);
    const denied = await x.check("cat .env");
    expect(denied.blocked).toContain("requires human approval (secrets)");

    const outside = await x.check("mkdir ../outside-dir");
    expect(outside.blocked).toContain("outside-root-write");
    expect(existsSync(join(x.dir, "outside-dir"))).toBe(false);

    // `cat` is not a Windows program (Git Bash's is not guaranteed on PATH): the approved run is checked on POSIX.
    if (isWin) return;
    const asked: string[] = [];
    const approved = await x.check("cat .env", { ui: { confirm: async (title, message) => (asked.push(`${title}\n${message}`), true) } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Factory gate: secrets");
    expect(asked[0]).toContain(`run_check in ${x.project}:`);
    expect(approved.record?.exitCode).toBe(0);
    // Decision 3: what reaches the log and the result is redacted.
    expect(readFileSync(approved.record!.logPath, "utf8")).toContain("API_KEY=***");
    expect(readFileSync(approved.record!.logPath, "utf8")).not.toContain(TOKEN);
    expect(approved.text).not.toContain(TOKEN);
  });

  it("decision 7: a declared command is still subject to hard gates", async () => {
    const x = await world({ declared: [{ name: "test", argv: ["git", "push"] }] });
    setRoute(x.small);
    const asked: string[] = [];
    const r = await x.check("git push", { ui: { confirm: async (t) => (asked.push(t), true) } });
    expect(r.blocked).toContain("run_check runs only read-only, allowlisted or project-declared commands");
    expect(r.blocked).toContain("git push mutates a remote");
    expect(asked).toEqual([]);
    expect(x.events().some((e) => e.type === "check")).toBe(false);
  });

  it("M9: environment assignments — an allowed name reaches the step env only, any other name is refused", async () => {
    const x = await world({ declared: [...DECLARED, { name: "env", argv: ["node", "scripts/env.mjs"] }] });
    writeFileSync(join(x.project, "scripts", "env.mjs"), 'console.log(`CI=${process.env.CI ?? "unset"}`);\n');
    setRoute(x.small);
    const ok = await x.check("CI=factory node scripts/env.mjs");
    expect(ok.record?.exitCode).toBe(0);
    expect(ok.text).toContain("CI=factory");
    expect(process.env.CI === "factory").toBe(false);
    for (const cmd of ["NODE_OPTIONS=--require=./x.js node scripts/ok.mjs", "PATH=. git status", "GIT_DIR=/tmp git status"]) {
      const r = await x.check(cmd, { ui: approve() });
      expect(r.blocked, cmd).toContain("is not allowed");
    }
  });

  it("M9: `cd` and a declared command chained with an unknown one are refused before any ask", async () => {
    const x = await world();
    setRoute(x.small);
    const asked: string[] = [];
    const ui: GateUi = { confirm: async (t) => (asked.push(t), true) };
    const cd = await x.check("cd scripts && node ok.mjs", { ui });
    expect(cd.blocked).toContain("run_check runs only read-only, allowlisted or project-declared commands");
    expect(cd.blocked).toContain("cd");
    const chained = await x.check('node scripts/ok.mjs && node -e "process.exit"', { ui });
    expect(chained.blocked).toContain("run_check runs only read-only, allowlisted or project-declared commands");
    expect(chained.blocked).toContain("segment 2 (node)");
    expect(asked).toEqual([]);
    expect(x.events().some((e) => e.type === "check")).toBe(false);
  });

  it("decision 2: on the answer route a runner is denied with the R29 message; a read-only command runs in the project root", async () => {
    const x = await world();
    setRoute(x.answer);
    const runner = await x.check("node scripts/ok.mjs");
    expect(runner.blocked).toContain("answer-route runner reconciliation is not available yet");
    const ro = await x.check("git status --short");
    expect(ro.record).toMatchObject({ exitCode: 0, cwd: x.project, mutated: false });
  });

  it("decision 1: a call the gate did not clear, or whose command changed after the gate, never runs", async () => {
    const x = await world();
    setRoute(x.small);
    const direct = await x.tool(RUN_CHECK_TOOL).execute("never-gated", { command: "node scripts/mutate.mjs" }, undefined, undefined, {});
    expect(direct.isError).toBe(true);
    expect(direct.content[0]!.text).toContain("not cleared by the factory gate");
    const swapped = await x.check("node scripts/ok.mjs", { input: { command: "node scripts/mutate.mjs" } });
    expect(swapped.res!.isError).toBe(true);
    expect(swapped.text).toContain("not cleared by the factory gate");
    expect(readFileSync(join(x.project, "README.md"), "utf8")).toBe("readme\n");
  });

  it("decision 1: run_check is a writing call for R31 (denied while another call is in flight, blocks others while it runs)", async () => {
    const x = await world();
    setRoute(x.small);
    x.inFlight.add("read-1", "", false);
    const r = await x.check("git status");
    expect(r.blocked).toContain("R31");
    x.inFlight.done("read-1");
    const ctx = x.context("unattended");
    const deps = { policyContext: () => ctx, ledger: x.ledger, runId: RUN_ID, home: homedir(), postChecks: x.postChecks, inFlight: x.inFlight, factoryTools: x.factoryTools, gatedChecks: x.session.gatedChecks };
    expect(await enforce({ toolName: RUN_CHECK_TOOL, toolCallId: "rc-1", input: { command: "git status" } }, { cwd: x.project }, deps)).toBeUndefined();
    const read = await enforce({ toolName: "read", toolCallId: "rd-2", input: { path: "README.md" } }, { cwd: x.project }, deps);
    expect(read?.reason).toContain("another call that may change files is still running");
  });

  it("decision 3: the log, the result tail and the ledger are redacted", async () => {
    const x = await world();
    setRoute(x.small);
    const r = await x.check("node scripts/leak.mjs");
    const log = readFileSync(r.record!.logPath, "utf8");
    for (const leaked of [TOKEN, "hunter2", "secretkeybody"]) {
      expect(log, leaked).not.toContain(leaked);
      expect(r.text, leaked).not.toContain(leaked);
    }
    expect(log).toContain("token *** printed");
    expect(log).toContain("password=***");
    expect(r.text).toContain("tail without newline");
    if (!isWin) {
      const echo = await x.check(`echo ${TOKEN}`);
      expect(echo.record?.exitCode).toBe(0);
      expect(readFileSync(x.ledger.file, "utf8")).not.toContain(TOKEN);
      expect(readFileSync(echo.record!.logPath, "utf8")).not.toContain(TOKEN);
      expect(echo.text).not.toContain(TOKEN);
    }
  });

  it("decision 5: a timeout tears down the whole process tree and is recorded", async () => {
    const x = await world();
    setRoute(x.small);
    const r = await x.check("node scripts/hang.mjs", { timeoutSec: 1 });
    expect(r.record).toMatchObject({ exitCode: 124, timedOut: true });
    expect(r.text).toContain("timed out");
    const pid = Number(readFileSync(join(x.project, "out", "grandchild.pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it.skipIf(isWin)("R36: a failed teardown (taskkill exiting non-zero) is noted in the log and does not hang the check", async () => {
    const failing = () => {
      const k = new EventEmitter() as EventEmitter & { kill(): void };
      k.kill = () => undefined;
      setTimeout(() => k.emit("close", 1, null), 10);
      return k as never;
    };
    const x = await world({ teardown: { platform: "win32", spawnTaskkill: failing, taskkillTimeoutMs: 1000 } });
    setRoute(x.small);
    const r = await x.check("node scripts/hang.mjs", { timeoutSec: 1 });
    try {
      expect(r.record).toMatchObject({ exitCode: 124, timedOut: true });
      const log = readFileSync(r.record!.logPath, "utf8");
      expect(log).toContain("process tree teardown failed");
      expect(log).toContain("taskkill exited with 1");
    } finally {
      // The fake taskkill left the tree running: end it here.
      const leader = Number(readFileSync(join(x.project, "out", "hang.pid"), "utf8"));
      try {
        process.kill(-leader, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 30_000);

  it.skipIf(isWin)("refuses a check log directory that is a symbolic link", async () => {
    const x = await world();
    setRoute(x.small);
    const elsewhere = join(x.dir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(x.runDir, "checks"));
    const r = await x.check("node scripts/ok.mjs");
    expect(r.res!.isError).toBe(true);
    expect(r.text).toContain("not a plain directory inside the run directory");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("decision 8: a check that rewrites the task file's machine section is repaired by the ruling-8 post-check", async () => {
    const x = await world();
    setRoute(x.feature);
    const r = await x.check("node scripts/rewrite-task.mjs");
    expect(r.record?.exitCode).toBe(0);
    expect(r.record?.mutated).toBe(false);
    const p = parseMachine(readFileSync(x.taskFile, "utf8"));
    expect(p && !("invalid" in p) ? p.fields.phase : undefined).toBe("build");
    const note = (r.post?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
    expect(note).toContain("machine-owned section");
    expect(readFileSync(x.taskFile, "utf8")).toContain(MACHINE_OPEN);
    expect(readFileSync(x.taskFile, "utf8")).toContain(MACHINE_CLOSE);
  });
});

describe("check log cap (M7)", () => {
  it("once the cap is hit nothing but the final truncation note is written (no gaps)", async () => {
    const t = await makeTmp("evidence-log");
    cleanups.push(t.cleanup);
    const file = join(t.dir, "x.log");
    const out = new CheckOutput(openSync(file, "wx"), 100);
    out.data("stdout", Buffer.from("first line\n"));
    out.data("stdout", Buffer.from(`${"y".repeat(120)}\n`));
    out.data("stdout", Buffer.from("small\n"));
    out.note("a note");
    out.close();
    const log = readFileSync(file, "utf8");
    expect(log).toContain("first line\n");
    expect(log).not.toContain("yyyy");
    expect(log).not.toContain("small");
    expect(log).not.toContain("a note");
    expect(log.trimEnd().split("\n").at(-1)).toMatch(/^\[run_check\] log truncated at 100 bytes: \d+ further bytes of output were not written$/);
  });
});

describe("ruling-8 post-check for bash (M6)", () => {
  it("an allowed non-read-only bash command on a feature route that rewrites the machine section is repaired; read-only bash is not tracked", async () => {
    const x = await world();
    setRoute(x.feature);
    const deps = { policyContext: () => x.context("unattended"), ledger: x.ledger, runId: RUN_ID, home: homedir(), postChecks: x.postChecks, inFlight: x.inFlight, factoryTools: x.factoryTools };
    expect(await enforce({ toolName: "bash", toolCallId: "ro-1", input: { command: "git status" } }, { cwd: x.wt }, deps)).toBeUndefined();
    expect(x.postChecks.size).toBe(0);
    x.inFlight.done("ro-1");
    expect(await enforce({ toolName: "bash", toolCallId: "b-1", input: { command: "node scripts/rewrite-task.mjs" } }, { cwd: x.wt }, deps)).toBeUndefined();
    execFileSync(process.execPath, ["scripts/rewrite-task.mjs"], { cwd: x.wt });
    const post = x.postChecks.afterToolResult({ toolCallId: "b-1", content: [{ type: "text", text: "done" }], isError: false }, x.ledger, RUN_ID);
    const p = parseMachine(readFileSync(x.taskFile, "utf8"));
    expect(p && !("invalid" in p) ? p.fields.phase : undefined).toBe("build");
    expect((post?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("")).toContain("machine-owned section");
  });

  it("a small route has no task file to protect", async () => {
    const x = await world();
    setRoute(x.small);
    const deps = { policyContext: () => x.context("unattended"), ledger: x.ledger, runId: RUN_ID, home: homedir(), postChecks: x.postChecks, inFlight: x.inFlight, factoryTools: x.factoryTools };
    expect(await enforce({ toolName: "bash", toolCallId: "b-2", input: { command: "node scripts/ok.mjs" } }, { cwd: x.project }, deps)).toBeUndefined();
    expect(x.postChecks.size).toBe(0);
  });
});

describe("resolveProgram (decision 4, M2)", () => {
  const files = new Set(["C:\\node\\node.exe", "C:\\node\\npm.cmd", "C:\\tools\\run.bat", "C:\\repo\\git.exe", "C:\\node\\script.js", "C:\\repo\\bin\\cat.exe", "C:\\sys\\cat.exe"]);
  // Windows file names are case-insensitive (PATHEXT entries are upper case).
  const lower = new Set([...files].map((f) => f.toLowerCase()));
  const win = (env: NodeJS.ProcessEnv, excludeRoots: string[] = ["C:\\repo"]) => ({
    platform: "win32" as const,
    env,
    isFile: (p: string) => lower.has(p.toLowerCase()),
    excludeRoots,
    real: (p: string) => p,
  });
  const env = { Path: "C:\\node;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD;.JS" };

  it("resolves through PATH and PATHEXT to an .exe on Windows", () => {
    const r = resolveProgram("node", "C:\\repo", win(env));
    expect(r.ok && r.file.toLowerCase()).toBe("c:\\node\\node.exe");
  });

  it("refuses .cmd/.bat (Node will not spawn them without a shell) and other non-programs", () => {
    for (const name of ["npm", "run"]) {
      const r = resolveProgram(name, "C:\\repo", win(env));
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.error).toContain("batch file");
    }
    const js = resolveProgram("script", "C:\\repo", win(env));
    expect(js.ok).toBe(false);
    if (!js.ok) expect(js.error).toContain("only .exe and .com");
  });

  it("never picks a program from the current directory, a relative or empty PATH entry, or a PATH entry inside the project", () => {
    const r = resolveProgram("git", "C:\\repo", win(env));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found on PATH");
    const planted = resolveProgram("cat", "C:\\repo", win({ Path: ".;;bin;C:\\repo\\bin;C:\\sys", PATHEXT: ".EXE" }));
    expect(planted.ok && planted.file.toLowerCase()).toBe("c:\\sys\\cat.exe");
  });

  it("POSIX: searches only absolute PATH entries outside the project for an executable file", () => {
    const exec = new Set(["/repo/node_modules/.bin/cat", "/usr/bin/cat", "/repo/bin/cat"]);
    const posix = { platform: "linux" as const, env: { PATH: "node_modules/.bin::/repo/bin:/usr/bin" }, isFile: (p: string) => exec.has(p), excludeRoots: ["/repo"], real: (p: string) => p };
    expect(resolveProgram("cat", "/repo", posix)).toEqual({ ok: true, file: "/usr/bin/cat" });
    const missing = resolveProgram("nope", "/repo", posix);
    expect(missing.ok).toBe(false);
    // A path-qualified program (only a declared command gets here) is taken as named, relative to the cwd.
    expect(resolveProgram("node_modules/.bin/vitest", "/repo", posix)).toEqual({ ok: true, file: "/repo/node_modules/.bin/vitest" });
  });

  it("safePathEntries drops relative, empty and in-project entries", () => {
    expect(safePathEntries({ PATH: ":.:bin:/repo/x:/repo:/usr/bin:/opt/b" }, "linux", ["/repo"], (p) => p)).toEqual(["/usr/bin", "/opt/b"]);
  });
});

describe("planted programs (M2)", () => {
  it.skipIf(isWin)("run_check never runs a program planted in the project through a relative or in-project PATH entry", async () => {
    const x = await world();
    setRoute(x.small);
    const bin = join(x.project, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cat"), `#!/bin/sh\necho planted > "${join(x.dir, "marker")}"\n`, { mode: 0o755 });
    for (const PATH of [`node_modules/.bin:${process.env.PATH}`, `${bin}:${process.env.PATH}`, `:${process.env.PATH}`]) {
      vi.stubEnv("PATH", PATH);
      const r = await x.check("cat README.md");
      expect(r.record?.exitCode, PATH).toBe(0);
      expect(r.text, PATH).toContain("readme");
      expect(existsSync(join(x.dir, "marker")), PATH).toBe(false);
    }
    vi.stubEnv("PATH", ORIGINAL_PATH);
  });

  it.skipIf(isWin)("factory git never runs a git planted in the repository through `.` or an in-repository PATH entry", async () => {
    const x = await world();
    const plant = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "git"), `#!/bin/sh\necho planted > "${join(x.dir, "marker")}"\nexit 0\n`, { mode: 0o755 });
    };
    plant(x.project);
    plant(join(x.project, "tools"));
    for (const PATH of [`.:${process.env.PATH}`, `${join(x.project, "tools")}:${process.env.PATH}`]) {
      vi.stubEnv("PATH", PATH);
      expect(gitRun(x.project, ["rev-parse", "--show-toplevel"]).stdout.trim(), PATH).toBe(x.project);
      expect(fingerprint(x.project), PATH).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(x.dir, "marker")), PATH).toBe(false);
    }
    vi.stubEnv("PATH", ORIGINAL_PATH);
  });

  it("factory git fails closed with a clear message when no git is found outside the project", async () => {
    const x = await world();
    vi.stubEnv("PATH", join(x.dir, "empty"));
    const r = gitRun(x.project, ["status"]);
    expect(r.status).toBeNull();
    expect(r.stderr).toContain("git was not found on PATH");
    expect(() => fingerprint(x.project)).toThrow(/git was not found on PATH/);
    vi.stubEnv("PATH", ORIGINAL_PATH);
  });
});

describe("record_review", () => {
  it("binds the disposition to the current fingerprint of the task's write root and audits a review event", async () => {
    const x = await world();
    setRoute(x.feature);
    const res = await x.tool(RECORD_REVIEW_TOOL).execute("rv-1", { taskId: "t1", disposition: "approved", reviewer: "codex", findingsSummary: `no findings; token=${TOKEN}` }, undefined, undefined, {});
    expect(res.isError).toBeUndefined();
    const d = res.details as ReviewDisposition;
    expect(d).toMatchObject({ taskId: "t1", disposition: "approved", reviewer: "codex", fingerprint: fingerprint(x.wt) });
    const reviews = x.events().filter((e): e is Extract<RunEvent, { type: "review" }> => e.type === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.disposition.fingerprint).toBe(d.fingerprint);
    expect(readFileSync(x.ledger.file, "utf8")).not.toContain(TOKEN);
  });

  it("refuses another task, an unknown disposition and the answer route", async () => {
    const x = await world();
    setRoute(x.feature);
    const exec = (p: Record<string, unknown>) => x.tool(RECORD_REVIEW_TOOL).execute("rv", { taskId: "t1", disposition: "approved", reviewer: "r", findingsSummary: "f", ...p }, undefined, undefined, {});
    expect((await exec({ taskId: "t2" })).content[0]!.text).toContain("not the current route's task");
    expect((await exec({ disposition: "maybe" })).content[0]!.text).toContain("disposition must be one of");
    setRoute(x.answer);
    expect((await exec({})).content[0]!.text).toContain("needs the task's small, feature or project route");
    expect(x.events().some((e) => e.type === "review")).toBe(false);
  });
});

describe("record_decision", () => {
  const exec = (x: Awaited<ReturnType<typeof world>>, p: Record<string, unknown>) => x.tool(RECORD_DECISION_TOOL).execute("d", p, undefined, undefined, {});

  it("autonomy low: a soft-gate skip is rejected with an error explaining the level", async () => {
    const x = await world({ autonomy: "low" });
    const r = await exec(x, { kind: "soft-gate-skipped", gate: "design-approval", justification: "trivial change" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("autonomy low");
    expect(x.events().some((e) => e.type === "decision")).toBe(false);
  });

  it("autonomy high: the skip is recorded as a decision event", async () => {
    const x = await world({ autonomy: "high" });
    const r = await exec(x, { kind: "soft-gate-skipped", gate: "design-approval", justification: "trivial change" });
    expect(r.isError).toBeUndefined();
    expect(x.events().filter((e) => e.type === "decision")).toEqual([
      expect.objectContaining({ kind: "soft-gate-skipped", gate: "design-approval", justification: "trivial change" }),
    ]);
  });

  it("autonomy medium skips only softened gates; hard gates are never skipped; a ruling needs no gate", async () => {
    const x = await world({ autonomy: "medium", softened: ["new-dependency"] });
    expect((await exec(x, { kind: "soft-gate-skipped", gate: "new-dependency", justification: "dev-only dependency" })).isError).toBeUndefined();
    const no = await exec(x, { kind: "soft-gate-skipped", gate: "design-approval", justification: "x" });
    expect(no.isError).toBe(true);
    expect(no.content[0]!.text).toContain("gates.soften (new-dependency)");
    const hard = await exec(x, { kind: "soft-gate-skipped", gate: "destructive", justification: "x" });
    expect(hard.content[0]!.text).toContain("hard gate");
    expect((await exec(x, { kind: "soft-gate-resolved", justification: "x" })).content[0]!.text).toContain("needs the soft gate id");
    expect((await exec(x, { kind: "ruling", justification: "use the lexer segments for execution" })).isError).toBeUndefined();
    expect(x.events().filter((e) => e.type === "decision")).toHaveLength(2);
  });
});

describe("loadEvidence", () => {
  it("returns the check records and known review dispositions of the project's runs, optionally limited to some runs", async () => {
    const x = await world();
    setRoute(x.feature);
    const rec = (await x.check("node scripts/ok.mjs")).record!;
    await x.tool(RECORD_REVIEW_TOOL).execute("rv", { taskId: "t1", disposition: "approved", reviewer: "codex", findingsSummary: "none" }, undefined, undefined, {});
    const other = new RunLedger(x.ledgerDir, "20261104T130000Z-2");
    const ts = new Date().toISOString();
    other.append({ v: 1, ts, runId: "20261104T130000Z-2", type: "review", disposition: { taskId: "t1", fingerprint: "f", disposition: "maybe-later", reviewer: "r", findingsSummary: "s", at: ts } });
    const all = loadEvidence(x.ledgerDir);
    expect(all.checks).toEqual([rec]);
    expect(all.dispositions).toHaveLength(1);
    expect(all.dispositions[0]).toMatchObject({ taskId: "t1", disposition: "approved", fingerprint: rec.fingerprint });
    // Check and review at the same fingerprint satisfy delivery for the feature tier.
    expect(validateDelivery({ taskId: "t1", tier: "feature", fingerprint: fingerprint(x.wt), checks: all.checks, dispositions: all.dispositions, requiredCheckIds: [rec.id] })).toEqual({ ok: true });
    expect(loadEvidence(x.ledgerDir, ["20261104T130000Z-2"])).toEqual({ checks: [], dispositions: [] });
    expect(loadEvidence(join(x.dir, "missing"))).toEqual({ checks: [], dispositions: [] });
  });
});
