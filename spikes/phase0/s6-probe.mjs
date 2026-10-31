// S6 probe: one RPC session (sessions enabled), three sequential prompts, wait agent_settled after each.
// usage: node spikes/phase0/s6-probe.mjs <provider-slug> <provider/model>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { SPIKE, isolatedEnv } from "./pi.mjs";

const [slug, model] = process.argv.slice(2);
const log = path.join(SPIKE.out, `headers-${slug}.jsonl`);
mkdirSync(SPIKE.out, { recursive: true });
rmSync(log, { force: true });
const env = isolatedEnv(undefined, { SPIKE_HEADERLOG: log });
const child = spawn(process.execPath, [SPIKE.launcher, "--mode", "rpc", "--model", model, "--extension", path.join(SPIKE.root, "gate-probe.ts")], { env, stdio: ["pipe", "pipe", "inherit"] });
let buf = "", waiter = null;
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    console.log("evt", m.type + (m.type === "response" ? `:${m.command}:${m.success}` : ""));
    if (m.type === "response" && m.success === false) console.log("  error:", m.error);
    if (m.type === "agent_settled" || m.type === "agent_end") if (waiter && m.type === "agent_settled") waiter();
  }
});
const prompts = ["Say ok.", "Run the shell command: echo hi. Then say done.", "Say ok again."];
for (const [n, message] of prompts.entries()) {
  const done = new Promise((res, rej) => { waiter = res; setTimeout(() => rej(new Error("timeout")), 150000); });
  child.stdin.write(JSON.stringify({ id: String(n), type: "prompt", message }) + "\n");
  await done.catch((e) => console.log("WAIT FAILED", e.message));
  console.log(`--- prompt ${n + 1} settled`);
}
child.stdin.end(); setTimeout(() => child.kill(), 3000);
const sess = path.join(SPIKE.agentDir, "sessions");
console.log("sessions dir exists:", existsSync(sess), existsSync(sess) ? readdirSync(sess, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : []);
