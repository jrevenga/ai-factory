// Test fixture: ignores SIGTERM, writes its pid to <pidFile> and stays alive until killed.
// usage: node ignore-term.mjs <pidFile>
import { renameSync, writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: ignore-term.mjs <pidFile>");
process.on("SIGTERM", () => {});
writeFileSync(`${pidFile}.tmp`, String(process.pid));
renameSync(`${pidFile}.tmp`, pidFile);
setInterval(() => {}, 1000);
