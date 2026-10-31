// Test fixture: starts a child in the same process group, writes the child's pid to <pidFile> and exits
// immediately, leaving the child running. Default: the child's stdio is detached ("ignore").
// With "inherit", the child keeps the leader's stdout/stderr pipes open after the leader exits.
// usage: node exit-leave-child.mjs <pidFile> [inherit]
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: exit-leave-child.mjs <pidFile> [inherit]");
const stdio = process.argv[3] === "inherit" ? "inherit" : "ignore";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio });
writeFileSync(`${pidFile}.tmp`, String(child.pid));
renameSync(`${pidFile}.tmp`, pidFile);
child.unref();
process.exit(0);
