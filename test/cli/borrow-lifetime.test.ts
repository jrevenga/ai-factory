// R17: a borrowed factory lock lives only as long as its lender holds it. Real processes: lender.ts
// takes the lock and hands over to borrower.ts (the real applyRelease) through the CLI's runner.
//
// Platform semantics differ, and each is asserted where it applies:
// - POSIX: SIGTERM reaches the lender's handler, which stops and awaits the borrower before releasing;
//   after SIGKILL the borrower notices on its own (watchdog) and commits nothing.
// - Windows: Node's SIGTERM and SIGKILL are both TerminateProcess, so no lender handler runs. libuv puts
//   every non-detached child in a KILL_ON_JOB_CLOSE job held only by its parent (src/win/process.c), so
//   the borrower is killed together with its lender, before it can print or commit anything; its own
//   children die the same way with it. The borrower's watchdog is covered on Windows by the lock tests.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { acquireLock, isPidAlive, Locked } from "../../src/adapters/store/lock.ts";
import { beginTxn, readTxn } from "../../src/adapters/store/transaction.ts";
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

interface Started {
  lender: ChildProcess;
  borrowerPid: number;
  output: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts the lender and resolves once its borrower is blocked inside the Pi package install. */
async function lendAndBlock(mode: "honor-abort" | "ignore-abort" | "slow-term"): Promise<Started> {
  const lender = spawn(process.execPath, ["--import", "jiti/register", LENDER, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(lender);
  let output = "";
  lender.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  lender.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => lender.once("exit", (code, signal) => r({ code, signal })));
  await until(() => (existsSync(join(paths.home, "blocked")) ? true : undefined), 20_000, `the borrower to block (${output})`);
  const borrowerPid = Number(readFileSync(join(paths.home, "borrower.pid"), "utf8"));
  pids.push(borrowerPid);
  return { lender, borrowerPid, output: () => output, exit };
}

describe("borrowed lock lifetime (R17)", () => {
  /** Windows: the borrower dies with its terminated lender, without printing (it never got to run again). */
  async function expectKilledWithLender(s: Started): Promise<void> {
    await until(() => (isPidAlive(s.borrowerPid) ? undefined : true), 5_000, "the borrower to die with its lender");
    expect(s.output()).not.toContain("borrower:");
  }

  it("a lender sent SIGTERM stops the borrower and waits for it to exit before releasing the lock", async () => {
    const s = await lendAndBlock("slow-term");
    s.lender.kill("SIGTERM");
    const { code } = await s.exit;
    if (isWindows) {
      // TerminateProcess: no handler runs in the lender; the job object takes the borrower down with it.
      await expectKilledWithLender(s);
      expect(s.output()).not.toContain("lender: released");
      expect(existsSync(paths.state)).toBe(false);
      expect((await readTxn(paths))?.id).toBe("lender-txn");
      return;
    }
    expect(isPidAlive(s.borrowerPid)).toBe(false);
    const out = s.output();
    const exiting = out.indexOf("borrower: exiting after SIGTERM");
    const childExited = out.indexOf("lender: child exited 143");
    const released = out.indexOf("lender: released");
    expect(exiting, out).toBeGreaterThanOrEqual(0);
    expect(childExited, out).toBeGreaterThan(exiting);
    expect(released, out).toBeGreaterThan(childExited);
    expect(code).toBe(143);
    // Nothing was committed; the journal stays for "factory rollback".
    expect(existsSync(paths.state)).toBe(false);
    expect((await readTxn(paths))?.id).toBe("lender-txn");
  });

  it("a lender killed with SIGKILL makes the borrower stop its install and abort on its own", async () => {
    const s = await lendAndBlock("honor-abort");
    s.lender.kill("SIGKILL");
    await s.exit;
    if (isWindows) await expectKilledWithLender(s);
    else {
      await until(() => (isPidAlive(s.borrowerPid) ? undefined : true), 10_000, "the borrower to exit");
      expect(s.output()).toContain("is no longer held for this process");
    }
    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.config)).toBe(false);
    expect((await readTxn(paths))?.id).toBe("lender-txn");
  });

  it("after the lender is killed and a concurrent rollback takes the lock, the borrower never overwrites its state or journal", async () => {
    const s = await lendAndBlock("ignore-abort");
    s.lender.kill("SIGKILL");
    await s.exit;
    if (isWindows) await expectKilledWithLender(s);
    // The concurrent rollback: takes the lock once the dead lender's lock is stale, then commits.
    const rollback = await until(
      () =>
        acquireLock(paths, {}, FAST).catch((e: unknown) => {
          if (e instanceof Locked) return undefined;
          throw e;
        }),
      15_000,
      "the stale lock to be taken over",
    );
    try {
      const rolledBack = `${JSON.stringify({ schema: 1, version: "0.0.8", installedAt: "2026-10-01T00:00:00.000Z", source: "x", piVersion: "1.4.0", piCli: "/old/cli.js", history: [] }, null, 2)}\n`;
      await writeFile(paths.state, rolledBack);
      await rm(paths.txn, { force: true });
      await beginTxn(paths, { id: "rollback-txn", kind: "rollback", from: "0.1.0", to: "0.0.8", snapshot: "rollback-txn" });
      const journal = readFileSync(paths.txn, "utf8");
      await writeFile(join(paths.home, "go"), ""); // the borrower's install now finishes
      await until(() => (isPidAlive(s.borrowerPid) ? undefined : true), 10_000, "the borrower to exit");
      if (!isWindows) {
        expect(s.output()).toContain("borrower: failed");
        expect(s.output()).toContain("is no longer held for this process");
      }
      expect(readFileSync(paths.state, "utf8")).toBe(rolledBack);
      expect(readFileSync(paths.txn, "utf8")).toBe(journal);
      expect(existsSync(paths.config)).toBe(false);
    } finally {
      await rollback.release();
    }
  });
});
