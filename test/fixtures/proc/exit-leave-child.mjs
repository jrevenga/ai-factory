// Test fixture: starts a child with detached stdio (same process group), writes the child's pid
// to <pidFile> and exits immediately, leaving the child running.
// usage: node exit-leave-child.mjs <pidFile>
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: exit-leave-child.mjs <pidFile>");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(`${pidFile}.tmp`, String(child.pid));
renameSync(`${pidFile}.tmp`, pidFile);
child.unref();
process.exit(0);
