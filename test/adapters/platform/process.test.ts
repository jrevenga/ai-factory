import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsafeCmdArgument } from "../../../src/adapters/platform/cmd-quote.ts";
import { liveRecordedProcessGroups, ProcessTeardownFailed, recordedProcessGroups, recordProcessGroupsIn, runBounded, runSupervised, stopRecordedProcessGroups, WRITER_GATE, WRITER_TOKEN_ENV, type ProcessDeps } from "../../../src/adapters/platform/process.ts";
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

  it.runIf(!isWindows).each(["SIGTERM", "SIGHUP"] as const)("POSIX: a parent %s tears down active children and then re-raises the signal", async (sig) => {
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
      runner.kill(sig);
      const result = await exited;
      expect(result, output).toEqual({ code: null, signal: sig });
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

describe.runIf(!isWindows)("writer process groups (R17 amended, POSIX)", () => {
  it("records each child's process group while a registry is active and removes it once the group is gone", async () => {
    const dir = join(tmp.dir, "writers");
    const stop = recordProcessGroupsIn(dir);
    let seen: number[] = [];
    try {
      const run = runBounded(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
      seen = await recordedProcessGroups(dir);
      await run;
    } finally {
      stop();
    }
    expect(seen).toHaveLength(1);
    expect(await recordedProcessGroups(dir)).toEqual([]);
    await runBounded(process.execPath, ["-e", ""]);
    expect(await recordedProcessGroups(dir)).toEqual([]); // no registry active any more
  });

  it("stopRecordedProcessGroups stops live groups (even one ignoring SIGTERM) and removes every entry", async () => {
    const dir = join(tmp.dir, "writers");
    const pidFile = join(tmp.dir, "stubborn.pid");
    const leader = spawn(process.execPath, [fixture("ignore-term.mjs"), pidFile], { detached: true, stdio: "ignore", env: { ...process.env, [WRITER_TOKEN_ENV]: "tok-1" } });
    await waitForFile(pidFile);
    const pid = await readPid(pidFile);
    spawnedPids.push(pid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, String(pid)), "tok-1");
    await writeFile(join(dir, "999999999"), ""); // a group that is long gone
    expect(await stopRecordedProcessGroups(dir)).toEqual([]);
    expect(killProbe(pid)).toBe("ESRCH");
    expect(await recordedProcessGroups(dir)).toEqual([]);
    leader.unref();
  });
});

describe.runIf(!isWindows)("writer gate (R20, POSIX)", () => {
  async function underRegistry<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = join(tmp.dir, "writers");
    const stop = recordProcessGroupsIn(dir);
    try {
      return await fn(dir);
    } finally {
      stop();
    }
  }

  it("runs the real command only after its group is recorded, with the same stdio and exit code", async () => {
    const r = await underRegistry(async (dir) => {
      const script = `const fs = require("fs"); const d = ${JSON.stringify(dir)};
        const recorded = fs.readdirSync(d); process.stdin.on("data", (b) => process.stdout.write(b));
        process.stdin.on("end", () => { process.stderr.write("recorded " + recorded.join(",") + " pgid-leader " + process.ppid); process.exit(3); });`;
      return runBounded(process.execPath, ["-e", script], { input: "hello" });
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("hello");
    // The real command saw its group (led by the gate, its parent) already recorded.
    const m = /recorded (\d+) pgid-leader (\d+)/.exec(r.stderr);
    expect(m, r.stderr).not.toBeNull();
    expect(m?.[1]).toBe(m?.[2]);
    expect(await recordedProcessGroups(join(tmp.dir, "writers"))).toEqual([]);
  });

  it("a command that cannot be spawned still rejects with its error code", async () => {
    await underRegistry(async () => {
      await expect(runBounded(join(tmp.dir, "no-such-command"), [])).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("a timeout under the gate tears down the real command's whole tree", async () => {
    const pidFile = join(tmp.dir, "grandchild.pid");
    const r = await underRegistry(() => runBounded(process.execPath, [fixture("spawn-tree.mjs"), pidFile], { timeoutMs: 1500 }));
    expect(r.timedOut).toBe(true);
    const { leader, grandchild } = await readTreePids(pidFile);
    expect(killProbe(grandchild)).toBe("ESRCH");
    expect(killProbe(leader)).toBe("ESRCH");
  });

  it("EOF on the control pipe before authorisation: the gate exits and the command never runs", async () => {
    const marker = join(tmp.dir, "ran");
    const gate = spawn(process.execPath, [WRITER_GATE, process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const exited = new Promise<number | null>((r) => gate.once("exit", (code) => r(code)));
    (gate.stdio[3] as NodeJS.WritableStream & { destroy(): void }).destroy(); // the parent died before authorising
    expect(await exited).not.toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "linux")("identity (Linux): a live recorded group without its token is unverified: still live, never signalled, entry kept (R21-P1)", async () => {
    const dir = join(tmp.dir, "writers");
    const unverified = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    spawnedPids.push(unverified.pid as number);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, String(unverified.pid)), "our-token");
    expect(await liveRecordedProcessGroups(dir)).toEqual([unverified.pid]);
    expect(await stopRecordedProcessGroups(dir)).toEqual([unverified.pid]);
    expect(killProbe(unverified.pid as number)).toBe("alive");
    expect(await recordedProcessGroups(dir)).toEqual([unverified.pid]);
    unverified.kill("SIGKILL");
  });

  it("identity: a live recorded group whose members carry its token is reported live", async () => {
    const dir = join(tmp.dir, "writers");
    const ours = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { ...process.env, [WRITER_TOKEN_ENV]: "tok-2" } });
    spawnedPids.push(ours.pid as number);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, String(ours.pid)), "tok-2");
    await new Promise((r) => setTimeout(r, 200)); // let /proc show the new environment
    expect(await liveRecordedProcessGroups(dir)).toEqual([ours.pid]);
    ours.kill("SIGKILL");
  });
});
