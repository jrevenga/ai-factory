// S8 driver: prompt (sleep 5 via bash), steer ~1.5 s after bash tool_execution_start, then follow_up.
// usage: SPIKE_EVENTLOG=<abs path> node spikes/phase0/rpc-steer.mjs <provider/model>
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SPIKE, isolatedEnv } from "./pi.mjs";

const model = process.argv[2];
if (!model || !process.env.SPIKE_EVENTLOG) throw new Error("need <model> and SPIKE_EVENTLOG");
const evlog = path.resolve(process.env.SPIKE_EVENTLOG); // relative paths resolve against the cwd, then are passed absolute to the child
mkdirSync(path.dirname(evlog), { recursive: true });
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 180000);
const failures = [];
const drv = (event, detail = null) => appendFileSync(evlog, JSON.stringify({ ts: Date.now(), event: "driver:" + event, detail }) + "\n");
const env = isolatedEnv(undefined, { SPIKE_EVENTLOG: evlog });
const child = spawn(process.execPath, [SPIKE.launcher, "--mode", "rpc", "--model", model, "--no-session", "--extension", path.join(SPIKE.root, "lifecycle-probe.ts")], { env, stdio: ["pipe", "pipe", "inherit"] });
const send = (o) => { drv("send", { type: o.type, message: o.message }); child.stdin.write(JSON.stringify(o) + "\n"); };
let buf = "", settled, exited = false;
const done = new Promise((res) => (settled = res));
let sent = false;
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "response") {
      drv("response", { command: m.command, success: m.success, data: m.data, error: m.error });
      if (m.success === false) { failures.push(`rpc ${m.command} failed: ${m.error}`); settled(); }
    }
    else if (m.type === "queue_update") drv("queue_update", { steering: m.steering, followUp: m.followUp });
    else if (m.type === "message_end" && m.message?.role === "assistant") {
      const t = (m.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (t) drv("assistant_text", t.slice(0, 200));
    }
    if (m.type === "tool_execution_start" && m.toolName === "bash" && !sent) {
      sent = true;
      setTimeout(() => send({ type: "steer", message: "STEER: also say BLUE." }), 1500);
      setTimeout(() => send({ type: "follow_up", message: "FOLLOWUP: say GREEN." }), 2000);
    }
    if (m.type === "agent_settled") { settledOk = true; settled(); }
  }
});
child.on("exit", (code, sig) => {
  if (!exited) { exited = true; if (!settledOk) { failures.push(`child exited early (code=${code} signal=${sig})`); settled(); } }
});
let settledOk = false;
send({ type: "prompt", message: "Run the bash command `sleep 5`, then reply with the single word DONE." });
const t = setTimeout(() => { drv("timeout"); failures.push(`timeout after ${TIMEOUT_MS} ms`); settled(); }, TIMEOUT_MS);
await done; clearTimeout(t);
child.stdin.end();
if (!exited) { child.kill(); }
// Required evidence: both queued inputs and agent_settled must be in the log.
const rows = readFileSync(evlog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const has = (p) => rows.some(p);
if (!has((r) => r.event === "input" && r.detail?.streamingBehavior === "steer")) failures.push("missing input(steer)");
if (!has((r) => r.event === "input" && r.detail?.streamingBehavior === "followUp")) failures.push("missing input(followUp)");
if (!has((r) => r.event === "agent_settled")) failures.push("missing agent_settled");
if (failures.length) { console.error("rpc-steer FAILED: " + failures.join("; ")); process.exit(1); }
console.log("rpc-steer ok");
process.exit(0);
