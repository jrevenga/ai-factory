// Stand-in for the pinned Pi CLI in launcher tests. Behaviour comes from FAKE_PI_MODE.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env.FAKE_PI_OUT;
const mode = process.env.FAKE_PI_MODE ?? "exit";
const log = (line) => appendFileSync(out, `${line}\n`);
log(`argv ${JSON.stringify(process.argv.slice(2))}`);
log(`telemetry ${process.env.PI_TELEMETRY}`);

const sessionsDir = join(process.env.FACTORY_HOME, "sessions");
for (let i = 0; i < 100; i++) {
  const names = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  const rec = names.length ? JSON.parse(readFileSync(join(sessionsDir, names[0]), "utf8")) : undefined;
  if (rec?.piPid !== undefined) {
    log(`session ${JSON.stringify({ piPidIsMe: rec.piPid === process.pid })}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 20));
}

if (mode === "exit") process.exit(3);
if (mode === "term-handled") {
  process.on("SIGTERM", () => {
    log("got SIGTERM");
    setTimeout(() => {
      log("exiting");
      process.exit(7);
    }, 300);
  });
}
log("started");
setInterval(() => {}, 1000);
