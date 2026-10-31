// Isolated Pi launcher. Usage: node spikes/phase0/pi.mjs <pi args...>
// Also usable as RpcClient's cliPath. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POSIX: true while any process of the group (pgid === leader pid) exists.
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Kill a child and its whole process tree and resolve only when the tree is gone.
// POSIX: children are spawned detached (own process group); SIGTERM, then SIGKILL after graceMs,
// polling kill(-pgid, 0) until ESRCH. Windows: taskkill /T /F, awaited.
export async function terminateTree(child, graceMs = 2000, maxMs = 15000) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise((res) => spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("close", res).on("error", res));
    return;
  }
  const pgid = child.pid;
  const send = (sig) => {
    try {
      process.kill(-pgid, sig);
    } catch {}
  };
  const t0 = Date.now();
  send("SIGTERM");
  let killed = false;
  while (groupAlive(pgid) && Date.now() - t0 < maxMs) {
    if (!killed && Date.now() - t0 >= graceMs) {
      send("SIGKILL");
      killed = true;
    }
    await sleep(50);
  }
}

// Children currently running, each with ONE cancellation path (timeout, abort, Ctrl+C and orphan cleanup
// all go through cancel(), which starts the awaited teardown once and returns the same promise).
// Children are detached, so the terminal's SIGINT does not reach them; the parent forwards it.
const active = new Set();
let handlersInstalled = false;
function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(sig, async () => {
      await Promise.all([...active].map((entry) => entry.cancel(sig)));
      process.exit(code);
    });
  }
}

// Spawn with stdout/stderr capture, optional stdin, timeoutMs and AbortSignal.
// Resolves { code, stdout, stderr, timedOut, orphans }. The promise never resolves before the whole process
// group is gone when a cancel happened. After a normal exit, descendants still alive in the group are
// treated as orphans and cancelled too (orphans: true); the child stays "active" until then.
export function spawnBounded(cmd, args, spawnOpts, { input, timeoutMs, signal } = {}) {
  installSignalHandlers();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOpts, shell: false, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let terminating;
    const entry = {
      cancel(reason) {
        terminating ??= terminateTree(child);
        entry.reason ??= reason;
        return terminating;
      },
    };
    active.add(entry);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const stop = () => {
      timedOut = true;
      entry.cancel("timeout");
    };
    const timer = timeoutMs ? setTimeout(stop, timeoutMs) : undefined;
    if (signal) signal.aborted ? stop() : signal.addEventListener("abort", stop, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      active.delete(entry);
      reject(e);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      let orphans = false;
      if (!terminating && process.platform !== "win32" && groupAlive(child.pid)) {
        orphans = true;
        entry.cancel("orphans");
      }
      if (terminating) await terminating;
      active.delete(entry);
      resolve({ code: timedOut ? null : code ?? 1, stdout, stderr, timedOut, orphans });
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
