// Throwaway S7 probe: a Factory "subagent" = child Pi over RPC (RpcClient), native Codex, in a worktree.
// Usage: node spikes/phase0/rpc-subagent.mjs <worktreePath> <modelId>
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SPIKE } from "./pi.mjs";

const [wt, model] = process.argv.slice(2);
if (!wt || !model) throw new Error("usage: rpc-subagent.mjs <worktreePath> <modelId>");
const { RpcClient } = await import(pathToFileURL(path.join(SPIKE.root, ".prefix/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);

const client = new RpcClient({
  cliPath: SPIKE.launcher, // pi.mjs forces the isolated env inside the child itself
  cwd: path.resolve(wt),
  env: { SPIKE_TOOLLOG: path.join(SPIKE.out, "s7-tools.jsonl"), SPIKE_INVENTORY: path.join(SPIKE.out, "s7-inventory.json") },
  args: ["--no-session", "--model", model, "--extension", path.join(SPIKE.root, "gate-probe.ts")],
});
const t0 = Date.now();
let exit = 0;
try {
  await client.start();
  const events = await client.promptAndWait("Read README.md if it exists, otherwise list the files, and summarize in one sentence.", undefined, 180000);
  const durationMs = Date.now() - t0;
  const toolCalls = events.filter((e) => e.type === "tool_execution_start").map((e) => ({ name: e.toolName, args: e.args }));
  const final = await client.getLastAssistantText();
  const usage = await client.getSessionStats();
  console.log(JSON.stringify({ final, toolCalls, durationMs, usage }, null, 2));
} catch (e) {
  console.error("FAILED:", e.message);
  exit = 1;
} finally {
  await client.stop();
}
process.exit(exit);
