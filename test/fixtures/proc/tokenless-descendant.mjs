// Test fixture (R21-P1): a writer group whose recorded leader has exited, leaving a descendant in the same
// process group that started with a clean environment (no FACTORY_WRITER_TOKEN). The leader starts the
// descendant (not detached: same group), waits for it to write <pidFile>, then exits. The descendant
// writes <termFile> if it ever receives SIGTERM and keeps running until killed.
// usage: node tokenless-descendant.mjs <pidFile> <termFile>
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const [pidFile, termFile] = process.argv.slice(2);
if (!pidFile || !termFile) throw new Error("usage: tokenless-descendant.mjs <pidFile> <termFile>");
const script = `const fs = require("fs");
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termFile)}, "SIGTERM"));
fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));
fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
setInterval(() => {}, 1000);`;
const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
child.unref();
const timer = setInterval(() => {
  if (existsSync(pidFile)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 20);
