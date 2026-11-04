// R17 (amended): a borrowed factory lock never becomes reusable while any writer of the borrowing tree
// lives. Real processes: lender.ts takes the lock and hands over to borrower.ts (the real applyRelease)
// through the CLI's runner; the borrower's fake Pi runs installer.mjs through the real runBounded, in
// its own process group, like npm and Pi.
//
// Platform semantics differ, and each is asserted where it applies:
// - POSIX: SIGINT/SIGTERM/SIGHUP reach the lender's handler, which stops and awaits the borrower and
//   every installer group the borrower recorded before it releases; a borrower whose lender was
//   SIGKILLed aborts on its own, stops its installer, and keeps the lock (its lease) until then.
// - Windows: Node's SIGTERM and SIGKILL are both TerminateProcess, so no lender handler runs. libuv puts
//   every non-detached child in a KILL_ON_JOB_CLOSE job held only by its parent (src/win/process.c), so
//   the borrower is killed together with its lender, and its installer (in the borrower's job) with it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { acquireLock, borrowerLeasePath, isPidAlive, Locked, writerGroupsPath } from "../../src/adapters/store/lock.ts";
import { recordedProcessGroups } from "../../src/adapters/platform/process.ts";
import { readTxn } from "../../src/adapters/store/transaction.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const LENDER = fileURLToPath(new URL("../fixtures/proc/lender.ts", import.meta.url));
const isWindows = process.platform === "win32";
const FAST = { stale: 2000, update: 1000 };

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
const pids: number[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await makeTmp("borrow-lifetime");
  env = { ...isolatedEnv(tmp.dir), FACTORY_SOURCE: "http://127.0.0.1:1/fixture/ai-factory.git", PI_OFFLINE: "1" };
  paths = factoryPaths(env);
});
afterEach(async () => {
  // Only processes this test started: the lender, and the borrower/installer pids they reported.
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const pid of pids.splice(0)) if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
  await tmp.cleanup();
});

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Mode = "honor-abort" | "ignore-abort" | "stubborn" | "die-before-record";

interface Started {
  lender: ChildProcess;
  borrowerPid: number;
  installerPid: number;
  output: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts the lender (optionally as a process-group leader) and resolves once the borrower's installer runs. */
async function lendAndBlock(mode: Mode, opts: { ownGroup?: boolean } = {}): Promise<Started> {
  const lender = spawn(process.execPath, ["--import", "jiti/register", LENDER, mode], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: opts.ownGroup === true,
  });
  children.push(lender);
  let output = "";
  lender.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  lender.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => lender.once("exit", (code, signal) => r({ code, signal })));
  await until(() => (existsSync(join(paths.home, "blocked")) ? true : undefined), 20_000, `the borrower's installer to start (${output})`);
  const borrowerPid = Number(readFileSync(join(paths.home, "borrower.pid"), "utf8"));
  const installerPid = Number(readFileSync(join(paths.home, "installer.pid"), "utf8"));
  pids.push(installerPid, borrowerPid);
  return { lender, borrowerPid, installerPid, output: () => output, exit };
}

const gone = (pid: number) => (isPidAlive(pid) ? undefined : true);

/** Lender output: the installer was already dead when the lender released (the line order proves "before"). */
function expectInstallerStoppedBeforeRelease(out: string): void {
  const stopped = out.indexOf("lender: installer alive=false");
  expect(out, out).not.toContain("lender: installer alive=true");
  expect(stopped, out).toBeGreaterThanOrEqual(0);
  expect(out.indexOf("lender: released"), out).toBeGreaterThan(stopped);
}

/** Windows: the borrower and its installer die with their terminated lender, the borrower without printing. */
async function expectKilledWithLender(s: Started): Promise<void> {
  await until(() => gone(s.borrowerPid), 5_000, "the borrower to die with its lender");
  await until(() => gone(s.installerPid), 5_000, "the installer to die with the borrower");
  expect(s.output()).not.toContain("borrower:");
}

/** Waits for the lock (the borrower's lease, then the dead lender's stale directory) to become free. */
async function takeLockWhenFree(timeoutMs: number) {
  return until(
    () =>
      acquireLock(paths, {}, FAST).catch((e: unknown) => {
        if (e instanceof Locked) return undefined;
        throw e;
      }),
    timeoutMs,
    "the lock to become free",
  );
}

describe("borrowed lock lifetime (R17 amended)", () => {
  it("a lender sent SIGTERM stops the borrower and its (SIGTERM-ignoring) installer before releasing the lock", async () => {
    const s = await lendAndBlock("stubborn");
    s.lender.kill("SIGTERM");
    const { code } = await s.exit;
    if (isWindows) {
      await expectKilledWithLender(s);
    } else {
      expect(code).toBe(143);
      expect(isPidAlive(s.borrowerPid)).toBe(false);
      expect(isPidAlive(s.installerPid)).toBe(false);
      expect(s.output()).toContain("lender: child exited 143");
      expectInstallerStoppedBeforeRelease(s.output());
      expect(existsSync(borrowerLeasePath(paths))).toBe(false);
    }
    expect(existsSync(paths.state)).toBe(false);
    expect((await readTxn(paths))?.id).toBe("lender-txn");
  });

  it.skipIf(isWindows)("terminal-group SIGHUP (lender and borrower) leaves no installer alive and no release before the tree is gone", async () => {
    const s = await lendAndBlock("stubborn", { ownGroup: true });
    process.kill(-(s.lender.pid as number), "SIGHUP"); // what a closing terminal sends its foreground group
    const { code } = await s.exit;
    expect(code).toBe(129);
    expect(isPidAlive(s.borrowerPid)).toBe(false);
    expect(isPidAlive(s.installerPid)).toBe(false);
    expectInstallerStoppedBeforeRelease(s.output());
    expect(existsSync(borrowerLeasePath(paths))).toBe(false);
    await (await acquireLock(paths)).release();
    expect((await readTxn(paths))?.id).toBe("lender-txn");
  });

  it.skipIf(isWindows)("a borrower killed outright: the lender stops the installer group it recorded before releasing", async () => {
    const s = await lendAndBlock("honor-abort");
    process.kill(s.borrowerPid, "SIGKILL");
    const { code } = await s.exit;
    expect(code).toBe(1);
    expect(isPidAlive(s.installerPid)).toBe(false);
    expectInstallerStoppedBeforeRelease(s.output());
    expect(existsSync(borrowerLeasePath(paths))).toBe(false); // the lender removed its dead borrower's lease
    await (await acquireLock(paths)).release();
  });

  it.skipIf(isWindows)("schedule: the borrower is SIGKILLed after spawning an installer but before recording it → the installer never runs, no orphan, the lender releases cleanly (R20)", async () => {
    const lender = spawn(process.execPath, ["--import", "jiti/register", LENDER, "die-before-record"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(lender);
    let out = "";
    lender.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    lender.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((r) => lender.once("exit", (c) => r(c)));
    const gatePid = Number(readFileSync(join(paths.home, "gate.pid"), "utf8"));
    pids.push(gatePid);
    expect(code, out).toBe(1); // the borrower was killed
    expect(out).toContain("lender: released");
    // The gate saw EOF on its control pipe and exited without starting the installer.
    await until(() => gone(gatePid), 5_000, "the gate to exit");
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(join(paths.home, "installer.pid")), "the installer must never have run").toBe(false);
    expect(await recordedProcessGroups(writerGroupsPath(paths))).toEqual([]);
    expect(existsSync(borrowerLeasePath(paths))).toBe(false);
    await (await acquireLock(paths)).release();
    expect(existsSync(paths.state)).toBe(false);
    expect((await readTxn(paths))?.id).toBe("lender-txn");
  });

  it("a lender killed with SIGKILL: the borrower stops its installer, aborts on its own and only then frees the lock", async () => {
    const s = await lendAndBlock("honor-abort");
    s.lender.kill("SIGKILL");
    await s.exit;
    if (isWindows) {
      await expectKilledWithLender(s);
    } else {
      await until(() => gone(s.borrowerPid), 10_000, "the borrower to exit");
      expect(isPidAlive(s.installerPid)).toBe(false);
      expect(s.output()).toContain("is no longer held for this process");
      expect(existsSync(borrowerLeasePath(paths))).toBe(false);
    }
    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.config)).toBe(false);
    expect((await readTxn(paths))?.id).toBe("lender-txn");
  });

  it("schedule: lender killed while the borrower still writes → a concurrent rollback is refused until the borrower has finished", async () => {
    const s = await lendAndBlock("ignore-abort");
    s.lender.kill("SIGKILL");
    await s.exit;
    if (isWindows) {
      // The borrowing tree died with the lender; the rollback gets the lock once the lender's lock is stale.
      await expectKilledWithLender(s);
      await (await takeLockWhenFree(15_000)).release();
    } else {
      // Long after the dead lender's lock went stale, the borrower (still installing) keeps the lock.
      await new Promise((r) => setTimeout(r, FAST.stale + 1000));
      const refused = await acquireLock(paths, {}, FAST).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(Locked);
      expect((refused as Locked).pid).toBe(s.borrowerPid);
      await writeFile(join(paths.home, "go"), ""); // the installer finishes; the borrower reaches its commit check
      await until(() => gone(s.borrowerPid), 10_000, "the borrower to exit");
      expect(s.output()).toContain("borrower: failed");
      expect(s.output()).toContain("is no longer held for this process");
      await (await takeLockWhenFree(5_000)).release();
    }
    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.config)).toBe(false);
    expect((await readTxn(paths))?.id).toBe("lender-txn");
  });
});
