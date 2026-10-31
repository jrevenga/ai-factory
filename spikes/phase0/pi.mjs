// Isolated Pi launcher. Usage: node spikes/phase0/pi.mjs <pi args...>
// Also usable as RpcClient's cliPath. Never touches ~/.pi/agent.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Kill a child and its whole process tree. POSIX: children are spawned detached
// (own process group) so -pid reaches every descendant; SIGTERM, then SIGKILL after a grace period.
function killTree(child, graceMs = 2000) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  const send = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), graceMs).unref();
}

// Spawn with stdout/stderr capture, optional stdin, timeoutMs and AbortSignal.
// Resolves { code, stdout, stderr, timedOut } and (on timeout/abort) only after the child has exited.
export function spawnBounded(cmd, args, spawnOpts, { input, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOpts, shell: false, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const stop = () => {
      timedOut = true;
      killTree(child);
    };
    const timer = timeoutMs ? setTimeout(stop, timeoutMs) : undefined;
    if (signal) signal.aborted ? stop() : signal.addEventListener("abort", stop, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code ?? 1, stdout, stderr, timedOut });
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    }
  });
}

// Delete and recreate guarded scratch paths (only if the guard confirms they are inside spikes/phase0/).
export function resetPaths(paths) {
  for (const p of paths) {
    if (!realInside(p)) throw new Error(`resetPaths: ${p} resolves outside ${root} or to ~/.pi/agent`);
  }
  for (const p of paths) {
    rmSync(p, { recursive: true, force: true });
    mkdirSync(p, { recursive: true });
  }
}

// Fresh state for a scenario: agent dir, npm prefix, npm cache (and extra scratch dirs).
export function resetScenario(scenario, extra = []) {
  if (!scenario || !/^[A-Za-z0-9_-]+$/.test(scenario)) throw new Error("a simple scenario name is required");
  resetPaths([
    path.join(root, `.agent-${scenario}`),
    path.join(root, `.npm-global-${scenario}`),
    path.join(root, "out", `npm-cache-${scenario}`),
    ...extra,
  ]);
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
  return spawnBounded(process.execPath, [piBin(), ...args], { cwd: opts.cwd ?? process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] }, opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SPIKE.launcher) {
  // CLI mode (also RpcClient's cliPath): run Pi inside THIS process, so killing
  // the launcher kills Pi on every OS. No child process, no signal forwarding.
  const env = isolatedEnv(undefined);
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  const bin = piBin();
  process.argv = [process.execPath, bin, ...process.argv.slice(2)];
  await import(pathToFileURL(bin).href);
}
