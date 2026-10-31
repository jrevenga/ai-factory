// S10 CI checks. usage: node spikes/phase0/ci-checks.mjs
// Runs S1 probe, isolated Pi install, install-by-tag + marker, CLI install + run, bootstrap from an empty prefix.
// Prints one JSON summary {checks: [{name, ok, ms, detail}], totalMs}; exit 0 only if every check passed.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetScenario, spawnBounded } from "./pi.mjs";
import { runNpm } from "./npm.mjs";

process.env.npm_config_update_notifier = "false";
process.env.npm_config_fund = "false";
process.env.npm_config_audit = "false";

const root = path.dirname(fileURLToPath(import.meta.url));
const TAG = "spike-pkg-v0.1.0";
const win = process.platform === "win32";
const redact = (s) => String(s).replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
const tail = (s, n = 1200) => {
  const t = redact(s).trim();
  return t.length > n ? "..." + t.slice(-n) : t;
};
const summarize = (label, r) =>
  `${label}: exit=${r.code} timedOut=${r.timedOut}\nstdout: ${tail(r.stdout)}\nstderr: ${tail(r.stderr)}`;

const checks = [];
const t0 = Date.now();
async function check(name, fn) {
  const t = Date.now();
  let ok = false;
  let detail = "";
  try {
    ({ ok, detail } = await fn());
  } catch (e) {
    detail = `threw: ${redact(e?.stack ?? e)}`;
  }
  checks.push({ name, ok, ms: Date.now() - t, detail });
}

const node = (script, args, timeoutMs, extra = {}) =>
  spawnBounded(process.execPath, [path.join(root, script), ...args], { env: process.env, cwd: root, stdio: ["ignore", "pipe", "pipe"] }, { timeoutMs, ...extra });

// Run a prefix's installed executable in a fresh process (no forced npm prefix, cwd = tmp dir).
async function runInstalled(scenario) {
  const prefix = path.join(root, `.npm-global-${scenario}`);
  const exe = win ? path.join(prefix, "factory-spike.cmd") : path.join(prefix, "bin", "factory-spike");
  if (!existsSync(exe)) return { ok: false, detail: `executable missing at ${exe}` };
  const env = { ...process.env };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  // Windows: `cmd /s /c` strips the first and last quote of the command string, so the quoted shim path gets one
  // extra pair of quotes and is passed verbatim (no Node re-quoting); this keeps paths with spaces intact.
  const [cmd, args, extra] = win
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${exe}""`], { windowsVerbatimArguments: true }]
    : [exe, [], {}];
  const r = await spawnBounded(cmd, args, { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], ...extra }, { timeoutMs: 60000 });
  const ok = r.code === 0 && /factory-spike ok v/.test(r.stdout);
  return { ok, detail: `${exe}\n${summarize("run", r)}` };
}

await check("s1-sqlite-fts", async () => {
  const r = await node("sqlite-fts.mjs", [], 60000);
  return { ok: r.code === 0, detail: summarize("sqlite-fts", r) };
});

await check("isolated-pi-install", async () => {
  resetScenario("ci-pi");
  const r = await runNpm("npm", ["install", "--prefix", path.join(root, ".prefix"), "--ignore-scripts", "@earendil-works/pi-coding-agent@1.4.0"], { scenario: "ci-pi", timeoutMs: 300000 });
  const pkg = path.join(root, ".prefix", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  return { ok: r.code === 0 && existsSync(pkg), detail: summarize("npm install pi", r) };
});

await check("install-by-tag-marker", async () => {
  const r = await node("s2-probe.mjs", ["load", "ci-s2"], 300000);
  const ok = r.code === 0 && /marker carries this run's nonce: true/.test(r.stdout);
  return { ok, detail: summarize("s2-probe load", r) };
});

await check("cli-install-run", async () => {
  resetScenario("ci-cli");
  const r = await runNpm("npm", ["install", "-g", `git+https://github.com/jrevenga/ai-factory.git#${TAG}`], { scenario: "ci-cli", timeoutMs: 300000 });
  if (r.code !== 0) return { ok: false, detail: summarize("npm install -g", r) };
  const run = await runInstalled("ci-cli");
  return { ok: run.ok, detail: `${summarize("npm install -g", r)}\n${run.detail}` };
});

await check("bootstrap-empty-prefix", async () => {
  resetScenario("ci-bootstrap");
  const r = await runNpm("npx", ["-y", `github:jrevenga/ai-factory#${TAG}`, "install"], { scenario: "ci-bootstrap", timeoutMs: 300000 });
  if (r.code !== 0) return { ok: false, detail: summarize("npx bootstrap", r) };
  const run = await runInstalled("ci-bootstrap");
  return { ok: run.ok, detail: `${summarize("npx bootstrap", r)}\n${run.detail}` };
});

const summary = { platform: process.platform, node: process.version, checks, totalMs: Date.now() - t0 };
console.log("CI_SUMMARY_JSON " + JSON.stringify(summary));
console.log(JSON.stringify(summary, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
