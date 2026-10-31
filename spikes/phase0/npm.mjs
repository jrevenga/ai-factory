// Isolated npm/npx runner. Usage: node spikes/phase0/npm.mjs <scenario> <npm|npx> <args...>
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function fail(msg) {
  throw new Error(`npm.mjs: ${msg}`);
}

function npmEntry(tool) {
  const nodeDir = path.dirname(realpathSync(process.execPath));
  const base =
    process.platform === "win32"
      ? path.join(nodeDir, "node_modules", "npm", "bin")
      : path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin");
  const entry = path.resolve(base, `${tool}-cli.js`);
  if (!existsSync(entry)) fail(`cannot find ${tool}-cli.js at ${entry}`);
  return entry;
}

export function runNpm(tool, args, opts) {
  if (tool !== "npm" && tool !== "npx") fail(`unknown tool ${tool}`);
  const scenario = opts?.scenario;
  if (!scenario || !/^[A-Za-z0-9_-]+$/.test(scenario)) fail("a simple scenario name is required");
  const prefix = path.join(root, `.npm-global-${scenario}`);
  const cache = path.join(root, "out", `npm-cache-${scenario}`);
  if (!inside(root, prefix) || !inside(root, cache)) fail("prefix/cache resolve outside spikes/phase0");
  const env = { ...process.env, ...(opts.env ?? {}), npm_config_prefix: prefix, npm_config_cache: cache };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_")) delete env[k];
  for (const k of ["npm_config_prefix", "npm_config_cache"]) {
    if (!inside(root, path.resolve(env[k]))) fail(`${k} escaped isolation`);
  }
  const entry = npmEntry(tool);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [scenario, tool, ...args] = process.argv.slice(2);
  try {
    const r = await runNpm(tool, args, { scenario });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exit(r.code);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
}
