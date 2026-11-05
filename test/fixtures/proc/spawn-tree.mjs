// Test fixture: leader that writes its own pid to <pidFile>.leader, starts a grandchild
// (ignore-term.mjs, which writes <pidFile>) and then stays alive.
// usage: node spawn-tree.mjs <pidFile>
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: spawn-tree.mjs <pidFile>");
writeFileSync(`${pidFile}.leader`, String(process.pid));
const grandchild = fileURLToPath(new URL("./ignore-term.mjs", import.meta.url));
spawn(process.execPath, [grandchild, pidFile], { stdio: "inherit" });
setInterval(() => {}, 1000);
