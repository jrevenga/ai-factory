// Isolated Pi launcher. Usage: node spikes/phase0/pi.mjs <pi args...>
// Also usable as RpcClient's cliPath. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const real = path.join(os.homedir(), ".pi", "agent");
  for (const [name, p] of [["PI_CODING_AGENT_DIR", agentDir], ["PI_CODING_AGENT_SESSION_DIR", sessionDir], ["npm_config_prefix", npmPrefix]]) {
    if (!inside(root, p)) die(`${name}=${p} is outside ${root}`);
    if (path.resolve(p) === path.resolve(real)) die(`${name} resolves to ${real}`);
  }
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_")) delete env[k];
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  env.npm_config_prefix = npmPrefix;
  // Final check on what the child will actually see.
  for (const k of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "npm_config_prefix"]) {
    if (!inside(root, path.resolve(env[k]))) die(`${k} escaped isolation`);
  }
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
  // CLI mode: inherit stdio so it works as an RPC cliPath.
  const env = isolatedEnv(undefined);
  const child = spawn(process.execPath, [piBin(), ...process.argv.slice(2)], {
    env,
    shell: false,
    stdio: "inherit",
  });
  child.on("error", (e) => die(String(e)));
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
