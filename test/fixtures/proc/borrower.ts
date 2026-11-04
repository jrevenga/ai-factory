// Test fixture: the borrowing child of lender.ts. Runs the real applyRelease (reason update, borrowing the
// lender's lock) with a fake Pi whose package install runs installer.mjs through the real runBounded (its
// own process group, recorded as a writer group), which ends once `<FACTORY_HOME>/go` exists.
// Modes: honor-abort (the install stops when the lock's `lost` signal aborts), ignore-abort (it does
// not), stubborn (honor-abort with an installer that ignores SIGTERM), die-before-record (the borrower
// SIGKILLs itself right after spawning the installer, before its group is recorded; R20).
// usage: node --import jiti/register borrower.ts <lenderPid> <mode>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { runBounded } from "../../../src/adapters/platform/process.ts";
import { PiRuntime, type PiRunOptions } from "../../../src/adapters/pi/runtime.ts";
import { applyRelease } from "../../../src/cli/commands/apply-release.ts";
import { ReleaseManifest } from "../../../src/core/release/manifest.ts";

const lenderPid = Number(process.argv[2]);
const mode = process.argv[3] ?? "honor-abort";
const paths = factoryPaths();
const say = (s: string): void => void process.stdout.write(`borrower: ${s}\n`);
const INSTALLER = fileURLToPath(new URL("./installer.mjs", import.meta.url));
writeFileSync(join(paths.home, "borrower.pid"), String(process.pid));

class InstallingPi extends PiRuntime {
  override async ensurePinned(_p: FactoryPaths, _v: string): Promise<string> {
    return "/fake/cli.js";
  }
  override async installPackage(_cli: string, _ref: string, opts: PiRunOptions = {}): Promise<void> {
    const pidFile = join(paths.home, "installer.pid");
    const beforeRecord =
      mode === "die-before-record"
        ? (pid: number): void => {
            writeFileSync(join(paths.home, "gate.pid"), String(pid));
            process.kill(process.pid, "SIGKILL");
          }
        : undefined;
    const run = runBounded(
      process.execPath,
      [INSTALLER, pidFile, join(paths.home, "go"), mode === "stubborn" ? "stubborn" : ""],
      { signal: mode === "ignore-abort" ? undefined : opts.signal, timeoutMs: 120_000 },
      { beforeRecord },
    );
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(paths.home, "blocked"), "");
    const r = await run;
    if (mode !== "ignore-abort" && opts.signal?.aborted) throw opts.signal.reason;
    if (r.code !== 0) throw new Error(`installer exited with ${r.code}`);
  }
}

const manifest = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));
try {
  await applyRelease(
    {
      paths,
      env: process.env,
      manifest,
      io: { out: say, err: (s) => void process.stderr.write(`borrower: ${s}\n`), confirm: async () => false, isTTY: false },
      pi: new InstallingPi(),
      now: () => new Date(),
      deps: { detectLogins: async () => ({ claude: "absent", codex: "present" }), runDoctor: async () => [] },
    },
    { reason: "update", from: "0.0.9", parentLockPid: lenderPid, yes: true },
  );
  say("applied");
  process.exitCode = 0;
} catch {
  say("failed");
  process.exitCode = 1;
}
