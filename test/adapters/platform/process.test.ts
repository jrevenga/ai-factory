import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsafeCmdArgument } from "../../../src/adapters/platform/cmd-quote.ts";
import { runBounded } from "../../../src/adapters/platform/process.ts";
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
