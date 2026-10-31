// S3 driver: reset scenario, run one npm/npx leg, optional alternate node. usage: node s3-probe.mjs <scenario> <npm|npx> <node|-> <args...>
import { resetScenario } from "./pi.mjs";
import { runNpm } from "./npm.mjs";
const [scenario, tool, node, ...args] = process.argv.slice(2);
resetScenario(scenario);
const t = Date.now();
const r = await runNpm(tool, args, { scenario, node: node === "-" ? undefined : node, timeoutMs: 240000 });
console.log(`exit=${r.code} timedOut=${r.timedOut} durationMs=${Date.now() - t}\n--- stdout ---\n${r.stdout}--- stderr ---\n${r.stderr}`);
process.exit(r.code ?? 3);
