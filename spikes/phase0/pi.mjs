// Isolated Pi launcher. Usage: node spikes/phase0/pi.mjs <pi args...>
// Also usable as RpcClient's cliPath. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export const SPIKE = {
  root,
  launcher: fileURLToPath(import.meta.url),
  agentDir: path.join(root, ".agent"),
  out: path.join(root, "out"),
};

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Real path of p, or of its nearest existing ancestor plus the missing tail.
export function realTarget(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync(cur), ...tail);
}

// True only if the REAL path of child is strictly inside the REAL spike root
// and is not the owner's real ~/.pi/agent.
export function realInside(child) {
  const real = realTarget(child);
  if (!inside(realTarget(root), real)) return false;
  const owner = realTarget(path.join(os.homedir(), ".pi", "agent"));
  return real !== owner && !real.startsWith(owner + path.sep);
}

const STRIP = /^(PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|NPM_CONFIG_PREFIX|NPM_CONFIG_CACHE|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN)$/i;

// Copy of the environment with every casing variant of the controlled keys removed.
export function cleanEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (STRIP.test(k) || /^ANTHROPIC_/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function die(msg) {
  process.stderr.write(`pi.mjs isolation guard: ${msg}\n`);
  process.exit(2);
}

function piBin() {
  const pkgDir = path.join(root, ".prefix", "node_modules", "@earendil-works", "pi-coding-agent");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    die(`Pi is not installed under ${pkgDir}; run the Task 1 Step 1 install first`);
  }
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi ?? Object.values(pkg.bin ?? {})[0];
  if (!bin) die("Pi package.json has no bin entry");
  return path.join(pkgDir, bin);
}

export function isolatedEnv(scenario, extra = {}) {
  const suffix = scenario ? `-${scenario}` : "";
  const agentDir = path.join(root, `.agent${suffix}`);
  const sessionDir = path.join(agentDir, "sessions");
  const npmPrefix = path.join(root, `.npm-global${suffix}`);
  for (const [name, p] of [["PI_CODING_AGENT_DIR", agentDir], ["PI_CODING_AGENT_SESSION_DIR", sessionDir], ["npm_config_prefix", npmPrefix]]) {
    if (!realInside(p)) die(`${name}=${p} resolves outside ${root} or to ~/.pi/agent (real path ${realTarget(p)})`);
  }
  const env = cleanEnv({ ...process.env, ...extra });
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  env.npm_config_prefix = npmPrefix;
  return env;
}

export function runPi(args, opts = {}) {
  const env = isolatedEnv(opts.scenario, opts.env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [piBin(), ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SPIKE.launcher) {
  // CLI mode: inherit stdio so it works as an RPC cliPath; forward termination to Pi.
  const env = isolatedEnv(undefined);
  const child = spawn(process.execPath, [piBin(), ...process.argv.slice(2)], {
    env,
    shell: false,
    stdio: "inherit",
  });
  let exiting = false;
  const forward = (sig) => () => {
    exiting = true;
    try {
      child.kill(sig);
    } catch {}
  };
  // On Windows Node maps SIGTERM/SIGINT kills to TerminateProcess; "SIGBREAK"/"SIGHUP" are best effort.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(sig, forward(sig));
    } catch {}
  }
  child.on("error", (e) => die(String(e)));
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1) : exiting ? 1 : 0)));
}
