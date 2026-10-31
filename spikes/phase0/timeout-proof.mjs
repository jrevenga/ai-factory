// Proof that runNpm's timeout kills and reaps the whole tree, including a descendant that ignores SIGTERM.
// Tree: npm -> git -> /bin/sh -c "sleep ..." where the credential helper ignores SIGTERM.
// usage: node spikes/phase0/timeout-proof.mjs            (timeout case)
//        node spikes/phase0/timeout-proof.mjs sigint     (parent receives SIGINT; run in background, send SIGINT yourself)
import { execSync } from "node:child_process";
import { resetScenario } from "./pi.mjs";
import { runNpm } from "./npm.mjs";

const mode = process.argv[2] ?? "timeout";
const scenario = mode === "sigint" ? "sigint" : "tmo";
resetScenario(scenario);
const PS = "ps -eo pid,ppid,pgid,args | grep -E 'spike-tmo-marker|git --no-replace|npm install' | grep -v grep";
const ps = () => {
  try {
    return execSync(PS, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const members = () => {
  try {
    return execSync(`ps -eo pid,ppid,pgid,args | awk '$3==${pgid}'`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const t0 = Date.now();
let pgid;
setTimeout(() => {
  const out = ps();
  pgid = out.split("\n")[0]?.trim().split(/\s+/)[2];
  console.log("descendants while running (t=2s):\n" + out);
  console.log("process group of the whole tree:", pgid, "\nall members:\n" + members());
}, 2000);
const r = await runNpm("npm", ["install", "-g", "git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0"], {
  scenario,
  timeoutMs: mode === "sigint" ? 120000 : 3000,
  // Private repo + empty git config + a credential helper that ignores SIGTERM and sleeps => git blocks in the helper.
  env: {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!sh -c 'trap \"\" TERM; sleep 300 #spike-tmo-marker'",
  },
});
console.log(`result: code=${r.code} timedOut=${r.timedOut} elapsed=${Date.now() - t0}ms`);
const left = ps() + (pgid ? members() : ""); // checked immediately after the runner resolved, no extra wait
console.log("leftover processes (name match + every member of the process group) immediately after runner resolved:", left === "" ? "none" : "\n" + left);
