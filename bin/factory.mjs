#!/usr/bin/env node
// Entry point of the `factory` CLI. TypeScript source is loaded through jiti (no build step); all paths
// resolve relative to this file, so it also works when installed globally under node_modules.
import { createJiti } from "jiti";
import { installWarningFilter } from "./warning-filter.mjs";

installWarningFilter(process);

// main() reports its own errors; this catch covers a CLI that cannot even be loaded (one line, exit 1,
// the stack only with FACTORY_DEBUG=1).
try {
  const jiti = createJiti(import.meta.url);
  const { main } = await jiti.import("../src/cli/main.ts");
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " ");
  process.stderr.write(
    process.env.FACTORY_DEBUG === "1"
      ? `factory: ${message}\n${e instanceof Error ? (e.stack ?? "") : ""}\n`
      : `factory: ${message} (set FACTORY_DEBUG=1 for details)\n`,
  );
  process.exitCode = 1;
}
