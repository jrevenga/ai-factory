// Gate suite in a real Pi 1.4.0 (faux provider, Phase 2 Task 12, acceptance 1). Each case is a faux-scripted tool call
// through the factory extension; it asserts the observable effect, the tool result and the ledger `gate` event.
// Print runs are unattended (no UI): every `ask` is denied. RPC runs have a UI and answer the gate's dialogs.
// Nothing dangerous runs: every command targets this suite's temp fixture, and the gate is expected to block it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BLOCKED,
  EXTENSION,
  FAUX,
  gateEvents,
  git,
  gitExecutable,
  isWin,
  ledgerRuns,
  makeGateWorld,
  NESTED,
  OBSERVER,
  remoteRefs,
  results,
  SECRET_MARK,
  type GateWorld,
  type LedgerEvent,
} from "../helpers/gate-world.ts";
import { ensureTestPi, runPiPrint, startPiRpc, type RpcRecord } from "../helpers/pi-harness.ts";

const RECONCILED = "Reverted on the answer route (copies in ";
const R31 = "re-issue this call after the previous call finishes (R31)";

let cli: string;
beforeAll(async () => {
  cli = await ensureTestPi();
}, 600_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function world(prefix: string): Promise<GateWorld> {
  const w = await makeGateWorld(prefix);
  cleanups.push(w.tmp.cleanup);
  return w;
}

async function runPrint(w: GateWorld, script: unknown[], extensions: string[] = [FAUX, EXTENSION, OBSERVER]): Promise<void> {
  w.env.FAUX_SCRIPT = JSON.stringify(script);
  const r = await runPiPrint({ cli, agentDir: w.agentDir, cwd: w.project, env: w.env, extensions });
  expect(r.timedOut).toBe(false);
  expect(r.code, r.stderr).toBe(0);
}

type Step = { tool: string; args: Record<string, unknown> };
const bash = (command: string): Step => ({ tool: "bash", args: { command } });
const SMALL: Step = { tool: "set_route", args: { route: "small", reason: "gate suite" } };

/** [tool, decision, hardGate] of each gate event. */
const decisions = (events: LedgerEvent[]) => events.map((e) => [e.tool, e.decision, e.hardGate]);

describe("gate suite (e2e, faux provider, unattended print mode)", () => {
  it("hard gates and route rules: answer-route deny and reconcile, small-route write, outside-root writes, machine section, secrets, destructive, R40 unknown option, allowlisted runner, unknown tool", async () => {
    const w = await world("gates-hard");
    const script: Step[] = [
      // Answer route (before set_route).
      { tool: "write", args: { path: join(w.project, "answer.txt"), content: "x" } },
      bash("npm test"),
      SMALL,
      { tool: "write", args: { path: join(w.project, "small.txt"), content: "y" } },
      { tool: "write", args: { path: join(w.outside, "new.txt"), content: "z" } },
      { tool: "edit", args: { path: join(w.outside, "target.txt"), edits: [{ oldText: "outside original", newText: "edited" }] } },
      { tool: "edit", args: { path: join(w.project, "notes.md"), edits: [{ oldText: "phase: draft", newText: "phase: done" }] } },
      { tool: "read", args: { path: join(w.project, ".env") } },
      bash("echo x > ../outside.txt"),
      bash("rm -rf ../victim"),
      bash("rm -rf src"),
      // R40: an option outside cat's grammar is unknown, so it asks (denied without a UI).
      bash("cat --bogus-option README.md"),
      // Integration into the user's branch: `git merge` is unknown in Phase 2 (no classification yet), so it asks.
      bash("git merge --no-edit main"),
      bash("npm test"),
      { tool: "dangerous_tool", args: { path: join(w.project, "dangerous.txt") } },
    ];
    await runPrint(w, script, [FAUX, EXTENSION, NESTED, OBSERVER]);

    const res = results(w);
    expect(res.map((r) => [r.toolName, r.isError])).toEqual([
      ["write", true],
      ["bash", false],
      ["set_route", false],
      ["write", false],
      ["write", true],
      ["edit", true],
      ["edit", true],
      ["read", true],
      ["bash", true],
      ["bash", true],
      ["bash", true],
      ["bash", true],
      ["bash", true],
      ["bash", false],
      ["dangerous_tool", true],
    ]);
    expect(res[0]!.text).toContain("the answer route cannot write");
    expect(res[1]!.text).toContain("npm test ran");
    expect(res[1]!.text).toContain(RECONCILED);
    expect(res[4]!.text).toContain("write outside the route's write roots in unattended mode");
    expect(res[6]!.text).toContain("the machine-owned section is written only by extension code");
    expect(res[7]!.text).toContain("requires human approval (secrets)");
    expect(res[8]!.text).toContain("requires human approval (outside-root-write)");
    expect(res[10]!.text).toContain("requires human approval (destructive)");
    expect(res[11]!.text).toContain("R40");
    expect(res[13]!.text).toContain("npm test ran");
    for (const i of [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]) expect(res[i]!.text, String(i)).toContain(BLOCKED);
    for (const r of res) expect(r.text).not.toContain(SECRET_MARK);

    // Observable effects.
    expect(existsSync(join(w.project, "answer.txt"))).toBe(false);
    expect(readFileSync(join(w.project, "small.txt"), "utf8")).toBe("y");
    expect(existsSync(join(w.outside, "new.txt"))).toBe(false);
    expect(readFileSync(join(w.outside, "target.txt"), "utf8")).toBe("outside original\n");
    expect(readFileSync(join(w.project, "notes.md"), "utf8")).toContain("phase: draft");
    expect(existsSync(join(w.dir, "outside.txt"))).toBe(false);
    expect(readFileSync(w.victim, "utf8")).toBe("must survive\n");
    expect(existsSync(join(w.project, "dangerous.txt"))).toBe(false);
    // Each run appends one line: the answer-route run was reverted (else two lines), the small-route run kept its own.
    expect(readFileSync(join(w.project, "src", "a.txt"), "utf8")).toBe("a original\nchanged by npm test\n");

    const gates = gateEvents(w);
    expect(decisions(gates)).toEqual([
      ["write", "deny", undefined],
      ["bash", "allow", undefined],
      ["set_route", "allow", undefined],
      ["write", "allow", undefined],
      ["write", "deny", "outside-root-write"],
      ["edit", "deny", "outside-root-write"],
      ["edit", "deny", undefined],
      ["read", "deny", "secrets"],
      ["bash", "deny", "outside-root-write"],
      ["bash", "deny", "outside-root-write"],
      ["bash", "deny", "destructive"],
      ["bash", "deny", undefined],
      ["bash", "deny", undefined],
      ["bash", "allow", undefined],
      ["dangerous_tool", "deny", undefined],
    ]);
    expect(gates[11]).toMatchObject({ class: "unknown" });
    expect(gates[12]).toMatchObject({ class: "unknown" });
    const reconciled = ledgerRuns(w)
      .flat()
      .filter((e) => e.type === "reconciled");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ reverted: ["src/a.txt"] });
  }, 180_000);

  it("bypass attempts: every hidden `git push` is blocked and the local bare remote stays empty; R28 pins", async () => {
    const w = await world("gates-bypass");
    const push = "git push origin main";
    const b64 = Buffer.from(push).toString("base64");
    const steps: Array<{ step: Step; hardGate?: string; class?: string }> = [
      { step: bash(push), hardGate: "remote-mutation" },
      { step: bash(`bash -c "${push}"`), class: "unknown" },
      { step: bash(`eval "${push}"`), class: "unknown" },
      { step: bash(`$(echo git) push origin main`), class: "unknown" },
      { step: bash(`echo ${b64} | base64 -d | sh`), class: "unknown" },
      { step: bash(`ls && ${push}`), hardGate: "remote-mutation" },
      // Carry-forward (Task 7 X1 residual, judged acceptable): `git apply` is unknown, so the whole line asks and an
      // unattended run denies it. The residual is the interactive case: a patch can replace the existing `key` with a
      // symlink before `cat key` runs; the owner approves the full command text (R30) and `key` exists at hook time,
      // so R28's "fresh path" rule does not fire. Pinned here as the current behaviour.
      { step: bash("git apply p.diff && cat key"), class: "unknown" },
    ];
    // Absolute executable paths: /usr/bin/git where it exists (Linux, macOS) and git's resolved path on every platform
    // (`C:/Program Files/Git/cmd/git.exe` on Windows), single-quoted because it may contain a space.
    if (!isWin && existsSync("/usr/bin/git")) steps.push({ step: bash(`/usr/bin/git push origin main`), hardGate: "remote-mutation" });
    const absGit = gitExecutable();
    expect(absGit, "git on PATH").toBeDefined();
    steps.push({ step: bash(`'${absGit!}' push origin main`), hardGate: "remote-mutation" });
    const r28 = w.symlinks && !isWin;
    if (r28) {
      // R28 (relative-symlink fixture): rel/l is harmless in rel/ and a secret once copied to the project root.
      // Copy-then-use in one command: `copy` does not exist at hook time, so the later read asks (secrets).
      steps.push({ step: bash("cp -P rel/l copy && cat copy"), class: "unknown", hardGate: "secrets" });
    }
    await runPrint(w, [SMALL, ...steps.map((s) => s.step)]);

    const res = results(w);
    expect(res[0]).toMatchObject({ toolName: "set_route", isError: false });
    expect(res.slice(1).map((r) => [r.toolName, r.isError])).toEqual(steps.map(() => ["bash", true]));
    for (const r of res.slice(1)) {
      expect(r.text).toContain(BLOCKED);
      expect(r.text).toContain("requires human approval");
      expect(r.text).not.toContain(SECRET_MARK);
    }
    expect(remoteRefs(w)).toBe("");
    expect(existsSync(join(w.project, "copy"))).toBe(false);

    const gates = gateEvents(w).slice(1);
    expect(gates).toHaveLength(steps.length);
    steps.forEach((s, i) => {
      expect(gates[i], String(s.step.args.command)).toMatchObject({ tool: "bash", decision: "deny", ...(s.class ? { class: s.class } : {}) });
      expect(gates[i]!.hardGate, String(s.step.args.command)).toBe(s.hardGate);
    });
  }, 180_000);

  it.skipIf(isWin)(
    "R28 across calls: a copied relative symlink is allowed as a copy, and reading through it is a secret read (skipped on Windows: Git Bash `cp -P` does not preserve symlinks without developer mode)",
    async () => {
      const w = await world("gates-r28");
      expect(w.symlinks).toBe(true);
      await runPrint(w, [SMALL, bash("cp -P rel/l copy"), bash("cat copy"), bash("echo x > ../outside.txt")]);
      const res = results(w);
      expect(res.map((r) => [r.toolName, r.isError])).toEqual([
        ["set_route", false],
        ["bash", false],
        ["bash", true],
        ["bash", true],
      ]);
      expect(res[2]!.text).toContain("requires human approval (secrets)");
      for (const r of res) expect(r.text).not.toContain(SECRET_MARK);
      expect(decisions(gateEvents(w))).toEqual([
        ["set_route", "allow", undefined],
        ["bash", "allow", undefined],
        ["bash", "deny", "secrets"],
        ["bash", "deny", "outside-root-write"],
      ]);
    },
    120_000,
  );

  it("feature route: writes go to the task worktree only; a write to the main checkout is outside the root", async () => {
    const w = await world("gates-feature");
    const wt = join(w.dir, "wt");
    git(w.project, "worktree", "add", "-q", "-b", "factory/t1", wt);
    await runPrint(w, [
      { tool: "set_route", args: { route: "feature", reason: "feature work", taskId: "t1", worktree: wt } },
      { tool: "write", args: { path: join(wt, ".factory", "knowledge", "tasks", "t1.md"), content: "# t1\n" } },
      { tool: "write", args: { path: join(wt, "feature.txt"), content: "f" } },
      { tool: "write", args: { path: join(w.project, "main-checkout.txt"), content: "m" } },
    ]);
    const res = results(w);
    expect(res.map((r) => [r.toolName, r.isError])).toEqual([
      ["set_route", false],
      ["write", false],
      ["write", false],
      ["write", true],
    ]);
    expect(readFileSync(join(wt, "feature.txt"), "utf8")).toBe("f");
    expect(existsSync(join(w.project, "main-checkout.txt"))).toBe(false);
    expect(decisions(gateEvents(w))).toEqual([
      ["set_route", "allow", undefined],
      ["write", "allow", undefined],
      ["write", "allow", undefined],
      ["write", "deny", "outside-root-write"],
    ]);
  }, 120_000);

  it("R31 and sequential tools: a parallel batch of two writes runs one; a batch with run_check (executionMode sequential) is serialized by Pi and runs both", async () => {
    const w = await world("gates-batch");
    await runPrint(w, [
      SMALL,
      {
        batch: [
          { tool: "write", args: { path: join(w.project, "p1.txt"), content: "1" } },
          { tool: "write", args: { path: join(w.project, "p2.txt"), content: "2" } },
        ],
      },
      {
        batch: [
          { tool: "write", args: { path: join(w.project, "s1.txt"), content: "3" } },
          { tool: "run_check", args: { command: "node scripts/ok.mjs" } },
        ],
      },
    ]);
    const res = results(w);
    expect(res.map((r) => [r.toolName, r.isError])).toEqual([
      ["set_route", false],
      ["write", false],
      ["write", true],
      ["write", false],
      ["run_check", false],
    ]);
    expect(res[2]!.text).toContain(R31);
    expect(res[4]!.text).toContain("checks passed");
    expect(existsSync(join(w.project, "p1.txt"))).toBe(true);
    expect(existsSync(join(w.project, "p2.txt"))).toBe(false);
    expect(existsSync(join(w.project, "s1.txt"))).toBe(true);
    const gates = gateEvents(w);
    expect(decisions(gates)).toEqual([
      ["set_route", "allow", undefined],
      ["write", "allow", undefined],
      ["write", "deny", undefined],
      ["write", "allow", undefined],
      ["run_check", "allow", undefined],
    ]);
    expect(String(gates[2]!.reason)).toContain(R31);
  }, 120_000);
});

describe("gate suite (e2e, faux provider, RPC mode with a UI)", () => {
  /** Approves only the confirm dialog of a top-level `nested_call`; rejects every other gate dialog. */
  const approveParentsOnly = (r: RpcRecord) => ({ confirmed: String(r.message).startsWith("Tool: nested_call\n") });

  it("nested calls (ctx.executeTool): a nested write outside the root is gated with parentToolCallId; nested calls of a running parent follow R31", async () => {
    const w = await world("gates-nested");
    w.env.FAUX_SCRIPT = JSON.stringify([
      SMALL,
      { tool: "nested_call", args: { calls: [{ tool: "write", args: { path: join(w.outside, "nested.txt"), content: "n" } }] } },
      {
        tool: "nested_call",
        args: {
          calls: [
            { tool: "write", args: { path: join(w.project, "n1.txt"), content: "1" } },
            { tool: "write", args: { path: join(w.project, "n2.txt"), content: "2" } },
          ],
        },
      },
      {
        tool: "nested_call",
        args: {
          parallel: true,
          calls: [
            { tool: "bash", args: { command: "sleep 2 && touch slow.txt" } },
            { tool: "write", args: { path: join(w.project, "fast.txt"), content: "f" } },
          ],
        },
      },
    ]);
    const rpc = startPiRpc({ cli, agentDir: w.agentDir, cwd: w.project, env: w.env, extensions: [FAUX, EXTENSION, NESTED, OBSERVER], onUiRequest: approveParentsOnly });
    try {
      expect(await rpc.request({ type: "prompt", message: "go" })).toMatchObject({ success: true });
      await rpc.waitFor((r) => r.type === "agent_settled", 90_000);
    } finally {
      const closed = await rpc.close();
      expect(closed, rpc.stderr()).toEqual({ code: 0, signal: null, killed: false });
    }

    const res = results(w);
    expect(res.map((r) => [r.toolName, r.isError])).toEqual([
      ["set_route", false],
      ["nested_call", false],
      ["nested_call", false],
      ["nested_call", false],
    ]);
    const nested = (i: number) => res[i]!.text.split("\n").map((l) => JSON.parse(l) as { id: string; tool: string; isError: boolean; text: string });
    const [outside] = nested(1);
    expect(outside).toMatchObject({ tool: "write", isError: true });
    expect(outside!.text).toContain(BLOCKED);
    expect(nested(2).map((n) => [n.tool, n.isError])).toEqual([
      ["write", false],
      ["write", false],
    ]);
    const parallel = nested(3);
    expect(parallel.map((n) => [n.tool, n.isError])).toEqual([
      ["bash", false],
      ["write", true],
    ]);
    expect(parallel[1]!.text).toContain(R31);
    expect(existsSync(join(w.outside, "nested.txt"))).toBe(false);
    expect(existsSync(join(w.project, "n1.txt")) && existsSync(join(w.project, "n2.txt"))).toBe(true);
    expect(existsSync(join(w.project, "slow.txt"))).toBe(true);
    expect(existsSync(join(w.project, "fast.txt"))).toBe(false);

    const gates = gateEvents(w);
    const parents = gates.filter((e) => e.tool === "nested_call");
    expect(parents.map((e) => e.decision)).toEqual(["allow (approved)", "allow (approved)", "allow (approved)"]);
    const children = gates.filter((e) => e.parentToolCallId !== undefined);
    expect(children.map((e) => [e.tool, e.decision, e.hardGate])).toEqual([
      ["write", "deny (rejected)", "outside-root-write"],
      ["write", "allow", undefined],
      ["write", "allow", undefined],
      ["bash", "allow", undefined],
      ["write", "deny", undefined],
    ]);
    // Each nested call names its running parent; the parent ids are the top-level nested_call ids.
    expect(children[0]!.parentToolCallId).toBe(parents[0]!.toolCallId);
    expect(children[0]!.toolCallId).toBe(outside!.id);
    expect(children.slice(1, 3).every((e) => e.parentToolCallId === parents[1]!.toolCallId)).toBe(true);
    expect(children.slice(3).every((e) => e.parentToolCallId === parents[2]!.toolCallId)).toBe(true);
    // Only the parents and the outside-root nested write asked.
    const confirms = rpc.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm");
    expect(confirms.map((r) => String(r.title))).toEqual([
      "Factory gate: unclassified",
      "Factory gate: outside-root-write",
      "Factory gate: unclassified",
      "Factory gate: unclassified",
    ]);
  }, 180_000);
});
