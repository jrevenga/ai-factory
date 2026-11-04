// The interactive ask path in a real Pi 1.4.0 (faux provider, Phase 2 Task 12): `pi --mode rpc` driven over JSON lines.
// The gate's `confirm` dialog arrives as an `extension_ui_request` and is answered with an `extension_ui_response`
// (Pi docs/rpc-extension-ui.md; the exported RpcClient has no method for it). A push targets the project's local bare
// remote, so a push that got through is observable. The three cases run concurrently: the unanswered one waits for
// the gate's 120 s confirm timeout.
import { describe, expect, it } from "vitest";
import { CONFIRM_TIMEOUT_MS } from "../../src/adapters/pi/extension/enforce.ts";
import { BLOCKED, EXTENSION, FAUX, gateEvents, makeGateWorld, OBSERVER, remoteRefs, results, type GateWorld } from "../helpers/gate-world.ts";
import { ensureTestPi, NO_ANSWER, startPiRpc, type RpcRecord } from "../helpers/pi-harness.ts";

const PUSH = "git push origin main";
const SCRIPT = [
  { tool: "set_route", args: { route: "small", reason: "ask suite" } },
  { tool: "bash", args: { command: PUSH } },
];

type Answer = (r: RpcRecord) => Record<string, unknown> | typeof NO_ANSWER | undefined;

/** Runs the faux script in RPC mode, answering every gate dialog with `answer`; returns the dialogs and the elapsed time. */
async function runRpc(w: GateWorld, script: unknown[], answer: Answer, settleMs: number) {
  const cli = await ensureTestPi();
  w.env.FAUX_SCRIPT = JSON.stringify(script);
  const started = Date.now();
  const rpc = startPiRpc({ cli, agentDir: w.agentDir, cwd: w.project, env: w.env, extensions: [FAUX, EXTENSION, OBSERVER], onUiRequest: answer });
  try {
    expect(await rpc.request({ type: "prompt", message: "go" })).toMatchObject({ success: true });
    await rpc.waitFor((r) => r.type === "agent_settled", settleMs);
  } finally {
    const closed = await rpc.close();
    expect(closed.killed, rpc.stderr()).toBe(false);
  }
  const confirms = rpc.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm");
  return { confirms, elapsed: Date.now() - started };
}

describe.concurrent("interactive ask over RPC (e2e, faux provider)", () => {
  it("approve: the push reaches the local bare remote and the gate event is `allow (approved)`", async () => {
    const w = await makeGateWorld("ask-approve");
    try {
      const { confirms } = await runRpc(w, SCRIPT, () => ({ confirmed: true }), 90_000);
      expect(confirms).toHaveLength(1);
      expect(confirms[0]).toMatchObject({ title: "Factory gate: remote-mutation", timeout: CONFIRM_TIMEOUT_MS });
      // R30: the owner sees the full command exactly as it will run.
      expect(String(confirms[0]!.message)).toContain(`Action (exactly as it will run):\n${PUSH}\n`);
      expect(results(w).map((r) => [r.toolName, r.isError])).toEqual([
        ["set_route", false],
        ["bash", false],
      ]);
      expect(remoteRefs(w)).toBe("refs/heads/main");
      const gates = gateEvents(w);
      expect(gates.at(-1)).toMatchObject({ tool: "bash", decision: "allow (approved)", hardGate: "remote-mutation", class: "remote-mutating" });
    } finally {
      await w.tmp.cleanup();
    }
  }, 150_000);

  it("reject: no push; an R40 unknown option also asks and is rejected", async () => {
    const w = await makeGateWorld("ask-reject");
    try {
      const script = [...SCRIPT, { tool: "bash", args: { command: "cat --bogus-option README.md" } }];
      const { confirms } = await runRpc(w, script, () => ({ confirmed: false }), 90_000);
      expect(confirms.map((r) => r.title)).toEqual(["Factory gate: remote-mutation", "Factory gate: unknown"]);
      expect(String(confirms[1]!.message)).toContain("R40");
      const res = results(w);
      expect(res.map((r) => [r.toolName, r.isError])).toEqual([
        ["set_route", false],
        ["bash", true],
        ["bash", true],
      ]);
      for (const r of res.slice(1)) expect(r.text).toContain(`${BLOCKED}: rejected by the user`);
      expect(remoteRefs(w)).toBe("");
      expect(gateEvents(w).slice(1).map((e) => [e.decision, e.hardGate, e.class])).toEqual([
        ["deny (rejected)", "remote-mutation", "remote-mutating"],
        ["deny (rejected)", undefined, "unknown"],
      ]);
    } finally {
      await w.tmp.cleanup();
    }
  }, 150_000);

  it(
    "no answer: the call is denied after the confirm timeout and nothing is pushed",
    async () => {
      const w = await makeGateWorld("ask-timeout");
      try {
        const { confirms, elapsed } = await runRpc(w, SCRIPT, () => NO_ANSWER, CONFIRM_TIMEOUT_MS + 60_000);
        expect(confirms).toHaveLength(1);
        expect(confirms[0]).toMatchObject({ title: "Factory gate: remote-mutation", timeout: CONFIRM_TIMEOUT_MS });
        expect(elapsed).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS - 1_000);
        const res = results(w);
        expect(res.map((r) => [r.toolName, r.isError])).toEqual([
          ["set_route", false],
          ["bash", true],
        ]);
        expect(res[1]!.text).toContain(`not answered within ${CONFIRM_TIMEOUT_MS / 1000} s`);
        expect(remoteRefs(w)).toBe("");
        expect(gateEvents(w).at(-1)).toMatchObject({ tool: "bash", decision: "deny (rejected)", hardGate: "remote-mutation" });
      } finally {
        await w.tmp.cleanup();
      }
    },
    CONFIRM_TIMEOUT_MS + 120_000,
  );
});
