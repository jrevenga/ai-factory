// S2 probes. usage: node spikes/phase0/s2-probe.mjs <load|badref> <scenario>
// Every run resets the scenario's guarded paths and uses a fresh nonce.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPi, SPIKE, resetScenario } from "./pi.mjs";

const [mode, scenario] = process.argv.slice(2);
if (!["load", "badref"].includes(mode) || !scenario) {
  console.error("usage: node spikes/phase0/s2-probe.mjs <load|badref> <scenario>");
  process.exit(2);
}
const MODEL = "openai-codex/gpt-6.1-sol";
const TAG = mode === "load" ? "spike-pkg-v0.1.0" : "does-not-exist";
const SRC = `git:github.com/jrevenga/ai-factory@${TAG}`;
const show = (label, r) => {
  console.log(`$ ${label}\nexit=${r.code} timedOut=${r.timedOut}\n--- stdout ---\n${r.stdout}--- stderr ---\n${r.stderr.split("\n").map((l) => (l.length > 240 ? l.slice(0, 240) + " [line truncated]" : l)).join("\n")}`);
};

console.log(`node ${process.version}; reset scenario ${scenario}`);
resetScenario(scenario);
const agent = path.join(SPIKE.root, `.agent-${scenario}`);
const marker = path.join(SPIKE.out, `marker-${scenario}.json`);
rmSync(marker, { force: true });

if (mode === "load") {
  show(`pi install ${SRC}`, await runPi(["install", SRC], { scenario, timeoutMs: 120000 }));
  show("pi list", await runPi(["list"], { scenario, timeoutMs: 60000 }));
  console.log("ms dir exists:", existsSync(path.join(agent, "git/github.com/jrevenga/ai-factory/node_modules/ms")));
} else {
  show(`pi install ${SRC}`, await runPi(["install", SRC], { scenario, timeoutMs: 120000 }));
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [SRC] }) + "\n");
}
const nonce = randomUUID();
console.log(`nonce=${nonce}`);
const r = await runPi(["--mode", "rpc", "--no-session", "--model", MODEL], {
  scenario,
  timeoutMs: 120000,
  env: { SPIKE_MARKER: marker, SPIKE_NONCE: nonce },
  input: '{"id":"1","type":"get_state"}\n',
});
show("pi --mode rpc --no-session --model " + MODEL + "  <<< get_state", { ...r, stdout: r.stdout.slice(0, 160) + " [stdout truncated]\n" });
const got = existsSync(marker) ? readFileSync(marker, "utf8") : null;
console.log("marker:", got);
let ok = false;
try { ok = got && JSON.parse(got).nonce === nonce; } catch {}
console.log(`marker carries this run's nonce: ${ok}`);
process.exit(mode === "load" ? (r.code === 0 && ok ? 0 : 1) : ok ? 1 : 0);
