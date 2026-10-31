// Test fixture: runs spawn-tree.mjs through runBounded so a test can signal this process
// while a child tree is active. usage: node --import jiti/register signal-runner.ts <pidFile>
import { fileURLToPath } from "node:url";
import { runBounded } from "../../../src/adapters/platform/process.ts";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: signal-runner.ts <pidFile>");
const tree = fileURLToPath(new URL("./spawn-tree.mjs", import.meta.url));
await runBounded(process.execPath, [tree, pidFile]);
process.stdout.write("child finished without a signal\n");
