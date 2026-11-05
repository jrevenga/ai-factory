// Test fixture: stands in for an npm/Pi installer started by the borrower in its own process group.
// Writes its pid to <pidFile>, then runs until <goFile> exists (exit 0). "stubborn" ignores SIGTERM.
// usage: node installer.mjs <pidFile> <goFile> [stubborn]
import { existsSync, renameSync, writeFileSync } from "node:fs";

const [pidFile, goFile, mode] = process.argv.slice(2);
if (!pidFile || !goFile) throw new Error("usage: installer.mjs <pidFile> <goFile> [stubborn]");
if (mode === "stubborn") process.on("SIGTERM", () => {});
writeFileSync(`${pidFile}.tmp`, String(process.pid));
renameSync(`${pidFile}.tmp`, pidFile);
setInterval(() => {
  if (existsSync(goFile)) process.exit(0);
}, 50);
