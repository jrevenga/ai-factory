#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

const REPO = "git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0";

if (process.argv[2] === "install") {
  // Same resolution as spikes/phase0/npm.mjs: node + npm's JS entry, no shell.
  const nodeDir = path.dirname(realpathSync(process.execPath));
  const base =
    process.platform === "win32"
      ? path.join(nodeDir, "node_modules", "npm", "bin")
      : path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin");
  const entry = path.resolve(base, "npm-cli.js");
  const child = spawn(process.execPath, [entry, "install", "-g", REPO], {
    stdio: "inherit",
    shell: false,
    env: process.env, // inherits npm_config_prefix
  });
  child.on("error", (e) => {
    console.error(e.message);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 1));
} else {
  console.log(`factory-spike ok ${process.version}`);
}
