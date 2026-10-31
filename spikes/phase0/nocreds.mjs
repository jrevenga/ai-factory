// Step 6 helper: run the valid private-tag install with NO git/ssh/npm credentials.
// usage: node spikes/phase0/nocreds.mjs <pi|npm>   (each bounded to 120 s)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runPi, SPIKE, resetScenario } from "./pi.mjs";
import { runNpm } from "./npm.mjs";

const mode = process.argv[2];
if (mode !== "pi" && mode !== "npm") {
  console.error("usage: node spikes/phase0/nocreds.mjs <pi|npm>");
  process.exit(2);
}
const out = SPIKE.out;
const home = path.join(out, "home-nocreds");
// Fresh state per run: agent dir, npm prefix, npm cache and scratch HOME are deleted and recreated.
resetScenario("nocreds", [home]);
const gitconfig = path.join(out, "empty.gitconfig");
writeFileSync(gitconfig, "");
const nul = process.platform === "win32" ? "NUL" : "/dev/null";

const env = {
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  HOME: home,
  USERPROFILE: home,
  HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ""),
  HOMEPATH: home.slice(path.parse(home).root.length - 1),
  GIT_SSH_COMMAND: `ssh -F ${nul} -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=${nul}`,
};
// Variables that must be absent (not just empty): strip from the inherited env.
for (const k of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(COUNT|KEY_.*|VALUE_.*|PARAMETERS)$/i.test(k) || /^(SSH_AUTH_SOCK|NETRC)$/i.test(k)) delete process.env[k];
}

const t0 = Date.now();
try {
  const o = { scenario: "nocreds", env, timeoutMs: 120000 };
  const r =
    mode === "pi"
      ? await runPi(["install", "git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0"], o)
      : await runNpm("npm", ["install", "-g", "git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0"], o);
  console.log(`exit=${r.code} timedOut=${r.timedOut} elapsed=${Date.now() - t0}ms`);
  console.log("--- stdout ---\n" + r.stdout);
  console.log("--- stderr ---\n" + r.stderr);
  process.exit(r.timedOut ? 3 : 0);
} catch (e) {
  console.log(`ERROR ${e.message}`);
  process.exit(3);
}
