// Test fixture: the borrowing child of lender.ts. Runs the real applyRelease (reason update, borrowing the
// lender's lock) with a fake Pi whose package install blocks until `<FACTORY_HOME>/go` exists.
// Modes: honor-abort (the install also stops when the lock's `lost` signal aborts), ignore-abort (it does
// not), slow-term (honor-abort, and SIGTERM is handled by exiting 143 after 700 ms).
// usage: node --import jiti/register borrower.ts <lenderPid> <mode>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { PiRuntime, type PiRunOptions } from "../../../src/adapters/pi/runtime.ts";
import { applyRelease } from "../../../src/cli/commands/apply-release.ts";
import { ReleaseManifest } from "../../../src/core/release/manifest.ts";

const lenderPid = Number(process.argv[2]);
const mode = process.argv[3] ?? "honor-abort";
const paths = factoryPaths();
const say = (s: string): void => void process.stdout.write(`borrower: ${s}\n`);
writeFileSync(join(paths.home, "borrower.pid"), String(process.pid));

if (mode === "slow-term") {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      say("exiting after SIGTERM");
      process.exit(143);
    }, 700);
  });
}

class BlockingPi extends PiRuntime {
  override async ensurePinned(_p: FactoryPaths, _v: string): Promise<string> {
    return "/fake/cli.js";
  }
  override async installPackage(_cli: string, _ref: string, opts: PiRunOptions = {}): Promise<void> {
    writeFileSync(join(paths.home, "blocked"), "");
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (existsSync(join(paths.home, "go"))) {
          clearInterval(timer);
          resolve();
        } else if (mode !== "ignore-abort" && opts.signal?.aborted) {
          clearInterval(timer);
          reject(opts.signal.reason);
        }
      }, 50);
    });
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
      pi: new BlockingPi(),
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
