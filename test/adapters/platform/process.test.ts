import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsafeCmdArgument } from "../../../src/adapters/platform/cmd-quote.ts";
import { ProcessTeardownFailed, runBounded, runSupervised, type ProcessDeps } from "../../../src/adapters/platform/process.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/proc/", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);
const isWindows = process.platform === "win32";

let tmp: Tmp;
// Only pids that our own fixtures wrote; killed in afterEach if a test failed midway.
const spawnedPids: number[] = [];

beforeEach(async () => {
  tmp = await makeTmp("proc");
});

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await tmp.cleanup();
});

function killProbe(pid: number): string {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "unknown";
  }
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function readPid(path: string): Promise<number> {
  const pid = Number(await readFile(path, "utf8"));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  spawnedPids.push(pid);
  return pid;
}

/** spawn-tree.mjs pids: its own (`<pidFile>.leader`) and its grandchild's (`<pidFile>`). */
async function readTreePids(pidFile: string): Promise<{ leader: number; grandchild: number }> {
  return { leader: await readPid(`${pidFile}.leader`), grandchild: await readPid(pidFile) };
}

describe("runBounded", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const r = await runBounded(process.execPath, ["-e", "process.stdout.write('hi'); process.stderr.write('err'); process.exit(3)"]);
    expect(r).toEqual({ code: 3, stdout: "hi", stderr: "err", timedOut: false, orphans: false });
  });

  it("always closes stdin", async () => {
    const r = await runBounded(process.execPath, ["-e", "process.stdin.on('end', () => process.exit(7)); process.stdin.resume()"]);
    expect(r.code).toBe(7);
  });

  it("writes input to stdin and then closes it", async () => {
    const r = await runBounded(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "abc\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("abc\n");
  });

  it("passes cwd and env (paths with spaces)", async () => {
    const r = await runBounded(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.cwd(), process.env.FACTORY_TEST_VAR]))"], {
      cwd: tmp.dir,
      env: { ...process.env, FACTORY_TEST_VAR: "a b" },
    });
    const [cwd, value] = JSON.parse(r.stdout) as [string, string];
    expect((await stat(cwd)).ino).toBe((await stat(tmp.dir)).ino);
    expect(value).toBe("a b");
  });

  it("on timeout tears down the whole tree, including a grandchild that ignores SIGTERM", async () => {
    const pidFile = join(tmp.dir, "grandchild.pid");
    const r = await runBounded(process.execPath, [fixture("spawn-tree.mjs"), pidFile], { timeoutMs: 3000 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    const { leader, grandchild } = await readTreePids(pidFile);
    expect(killProbe(grandchild)).toBe("ESRCH");
    expect(killProbe(leader)).toBe("ESRCH");
  });

  it("an AbortSignal cancels through the same teardown", async () => {
    const pidFile = join(tmp.dir, "grandchild.pid");
    const controller = new AbortController();
    const run = runBounded(process.execPath, [fixture("spawn-tree.mjs"), pidFile], { signal: controller.signal });
    await waitForFile(pidFile);
    const { leader, grandchild } = await readTreePids(pidFile);
    expect(killProbe(grandchild)).toBe("alive");
    controller.abort();
    const r = await run;
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(killProbe(grandchild)).toBe("ESRCH");
    expect(killProbe(leader)).toBe("ESRCH");
  });

  it("an already aborted signal cancels immediately", async () => {
    const r = await runBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: AbortSignal.abort() });
    expect(r.code).toBeNull();
  });

  it.runIf(!isWindows)("POSIX: cancels descendants left behind by a leader that exited (orphans)", async () => {
    const pidFile = join(tmp.dir, "child.pid");
    const r = await runBounded(process.execPath, [fixture("exit-leave-child.mjs"), pidFile]);
    expect(r.orphans).toBe(true);
    expect(r.code).toBe(0);
    const pid = await readPid(pidFile);
    expect(killProbe(pid)).toBe("ESRCH");
  });

  it.runIf(!isWindows)("POSIX: detects orphans on leader exit even when they keep the output pipes open", async () => {
    const pidFile = join(tmp.dir, "child.pid");
    const t0 = Date.now();
    const r = await runBounded(process.execPath, [fixture("exit-leave-child.mjs"), pidFile, "inherit"]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.orphans).toBe(true);
    expect(r.code).toBe(0);
    const pid = await readPid(pidFile);
    expect(killProbe(pid)).toBe("ESRCH");
  });

  it("installs parent signal handlers only while a child is active", async () => {
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    const run = runBounded(process.execPath, ["-e", "setTimeout(() => {}, 200)"]);
    expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
    await run;
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
  });

  it("rejects when the command cannot be spawned and removes its handlers", async () => {
    const before = process.listenerCount("SIGINT");
    await expect(runBounded(join(tmp.dir, "no-such-command"), [])).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it.runIf(!isWindows)("POSIX: a parent SIGTERM tears down active children and then re-raises the signal", async () => {
    const pidFile = join(tmp.dir, "grandchild.pid");
    const runner = spawn(process.execPath, ["--import", "jiti/register", fixture("signal-runner.ts"), pidFile], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    runner.stdout.on("data", (d) => (output += d));
    runner.stderr.on("data", (d) => (output += d));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      runner.on("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      await waitForFile(pidFile);
      const { leader, grandchild } = await readTreePids(pidFile);
      expect(killProbe(grandchild)).toBe("alive");
      runner.kill("SIGTERM");
      const result = await exited;
      expect(result, output).toEqual({ code: null, signal: "SIGTERM" });
      expect(killProbe(grandchild)).toBe("ESRCH");
      expect(killProbe(leader)).toBe("ESRCH");
    } finally {
      runner.kill("SIGKILL");
    }
  });

  it.runIf(isWindows)("Windows: runs a .cmd through cmd.exe with quoted arguments", async () => {
    const argvJs = join(tmp.dir, "argv.js");
    await writeFile(argvJs, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const cmdFile = join(tmp.dir, "print args.cmd");
    await writeFile(cmdFile, `@"${process.execPath}" "%~dp0argv.js" %*\r\n`);
    const r = await runBounded(cmdFile, ["install", "C:\\a b\\x"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["install", "C:\\a b\\x"]);
  });

  it.runIf(isWindows)("Windows: refuses unsafe .cmd arguments", async () => {
    const cmdFile = join(tmp.dir, "noop.cmd");
    await writeFile(cmdFile, "@exit /b 0\r\n");
    await expect(runBounded(cmdFile, ["a&b"])).rejects.toBeInstanceOf(UnsafeCmdArgument);
  });
});

// The Windows teardown branch (taskkill) with an injected tree-kill command, so it runs on every OS.
describe("runBounded Windows teardown", () => {
  const HANG = ["-e", "setInterval(() => {}, 1000)"];
  const fakeTaskkill = (script: string) => () => spawn(process.execPath, ["-e", script], { stdio: "ignore" });

  async function expectTeardownFailure(deps: Partial<ProcessDeps>): Promise<ProcessTeardownFailed> {
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    const error = await runBounded(process.execPath, HANG, { timeoutMs: 200 }, { platform: "win32", ...deps }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProcessTeardownFailed);
    const failure = error as ProcessTeardownFailed;
    spawnedPids.push(failure.pid);
    expect(killProbe(failure.pid)).toBe("alive");
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    return failure;
  }

  it("resolves as cancelled when the tree-kill command succeeds", async () => {
    const r = await runBounded(process.execPath, HANG, { timeoutMs: 200 }, {
      platform: "win32",
      spawnTaskkill: (pid) => spawn(process.execPath, ["-e", `process.kill(${pid}, "SIGKILL")`], { stdio: "ignore" }),
    });
    expect(r).toMatchObject({ code: null, timedOut: true, orphans: false });
  });

  it("rejects with ProcessTeardownFailed when taskkill cannot start", async () => {
    const failure = await expectTeardownFailure({ spawnTaskkill: () => spawn(join(tmp.dir, "no-such-taskkill"), [], { stdio: "ignore" }) });
    expect(failure.reason).toMatch(/could not start/);
  });

  it("rejects with ProcessTeardownFailed when taskkill exits non-zero", async () => {
    const failure = await expectTeardownFailure({ spawnTaskkill: fakeTaskkill("process.exit(1)") });
    expect(failure.reason).toBe("taskkill exited with 1");
  });

  it("rejects with ProcessTeardownFailed when taskkill does not finish in time", async () => {
    const failure = await expectTeardownFailure({ spawnTaskkill: fakeTaskkill("setInterval(() => {}, 1000)"), taskkillTimeoutMs: 300 });
    expect(failure.reason).toMatch(/did not finish within 300 ms/);
  });
});

describe("runSupervised (R17)", () => {
  /** Delivers `sig` to this process's listeners only (no real signal), with other listeners set aside. */
  function emitSignal(sig: NodeJS.Signals): void {
    const others = process.listeners(sig).slice(0, -1);
    for (const l of others) process.off(sig, l);
    try {
      process.emit(sig, sig);
    } finally {
      for (const l of others) process.on(sig, l);
    }
  }

  it("resolves to the child's exit code and leaves no signal listener behind", async () => {
    const before = process.listenerCount("SIGTERM");
    expect(await runSupervised(process.execPath, ["-e", "process.exit(5)"])).toBe(5);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("on a signal, POSIX: stops the child and resolves 128 + signal only after it exited", async () => {
    if (isWindows) return;
    const marker = join(tmp.dir, "child-done");
    const script = `process.on("SIGTERM", () => setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(marker)}, ""); process.exit(0); }, 300)); setInterval(() => {}, 1000); console.log("ready");`;
    const running = runSupervised(process.execPath, ["-e", script], {});
    await new Promise((r) => setTimeout(r, 500));
    emitSignal("SIGHUP");
    expect(await running).toBe(129);
    await expect(stat(marker)).resolves.toBeDefined();
  });

  it("on a signal, Windows branch: awaits taskkill of the child's tree", async () => {
    let killed: number | undefined;
    const deps: Partial<ProcessDeps> = {
      platform: "win32",
      spawnTaskkill: (pid) => {
        killed = pid;
        return spawn(process.execPath, ["-e", `process.kill(${pid}, "SIGKILL")`], { stdio: "ignore" });
      },
    };
    const running = runSupervised(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {}, deps);
    await new Promise((r) => setTimeout(r, 300));
    emitSignal("SIGTERM");
    expect(await running).toBe(143);
    expect(killed).toBeTypeOf("number");
    expect(killProbe(killed as number)).toBe("ESRCH");
  });
});
