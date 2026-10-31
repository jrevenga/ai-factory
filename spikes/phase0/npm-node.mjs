// Positive control of the npm install leg under an alternate node binary.
// usage: node spikes/phase0/npm-node.mjs <scenario> <node-binary>
import { resetScenario } from "./pi.mjs";
import { runNpm } from "./npm.mjs";
const [scenario, node] = process.argv.slice(2);
resetScenario(scenario);
const r = await runNpm("npm", ["install", "-g", "git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0"], { scenario, node, timeoutMs: 180000 });
console.log(`exit=${r.code} timedOut=${r.timedOut}\n--- stdout ---\n${r.stdout}--- stderr ---\n${r.stderr}`);
process.exit(r.code ?? 3);
