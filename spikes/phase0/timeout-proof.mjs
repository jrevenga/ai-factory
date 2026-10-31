// Proof that runNpm's timeout kills the whole tree: npm -> git -> sh/sleep.
// usage: node spikes/phase0/timeout-proof.mjs
import { execSync } from "node:child_process";
import { resetScenario } from "./pi.mjs";
import { runNpm } from "./npm.mjs";

resetScenario("tmo");
const ps = () => {
  try {
    return execSync("ps -eo pid,ppid,pgid,args | grep -E 'spike-tmo-marker|git --no-replace|npm install' | grep -v grep", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const t0 = Date.now();
setTimeout(() => console.log("descendants while running (t=2s):\n" + ps()), 2000);
const r = await runNpm("npm", ["install", "-g", "git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0"], {
  scenario: "tmo",
  timeoutMs: 3000,
  // Private repo + empty git config + a credential helper that sleeps => git blocks in the helper.
  env: {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!sleep 300 #spike-tmo-marker",
  },
});
console.log(`result: code=${r.code} timedOut=${r.timedOut} elapsed=${Date.now() - t0}ms`);
await new Promise((res) => setTimeout(res, 3000)); // allow SIGKILL grace to elapse
const left = ps();
console.log("leftover processes after timeout:", left === "" ? "none" : "\n" + left);
