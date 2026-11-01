#!/usr/bin/env node
// Entry point of the `factory` CLI. TypeScript source is loaded through jiti (no build step); all paths
// resolve relative to this file, so it also works when installed globally under node_modules.
import { createJiti } from "jiti";

// node:sqlite is still flagged experimental on the supported Node versions; hide only that notice.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const first = args[0];
  const type = typeof first === "string" ? first : (first?.type ?? warning?.name);
  const message = typeof warning === "string" ? warning : (warning?.message ?? "");
  if (type === "ExperimentalWarning" && /SQLite/.test(message)) return;
  return emitWarning.call(process, warning, ...args);
};

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/cli/main.ts");
process.exitCode = await main(process.argv.slice(2));
