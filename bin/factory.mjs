#!/usr/bin/env node
// Entry point of the `factory` CLI. TypeScript source is loaded through jiti (no build step); all paths
// resolve relative to this file, so it also works when installed globally under node_modules.
import { createJiti } from "jiti";
import { installWarningFilter } from "./warning-filter.mjs";

installWarningFilter(process);

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/cli/main.ts");
process.exitCode = await main(process.argv.slice(2));
