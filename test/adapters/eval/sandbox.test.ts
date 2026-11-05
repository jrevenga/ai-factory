import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBounded } from "../../../src/adapters/platform/process.ts";
import { bwrapUsable, sandboxArgs, type SandboxSpec } from "../../../src/adapters/eval/sandbox.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const usable = await bwrapUsable();

describe("sandboxArgs", () => {
  it("builds the exact argument order", () => {
    const spec: SandboxSpec = {
      hide: ["/h/child/deep", "/h", "/h", "/other"],
      roBinds: ["/h/tools"],
      rwBinds: ["/h/ws"],
      cwd: "/h/ws",
      network: false,
    };
    const p = (s: string) => resolve(s);
    expect(sandboxArgs(spec, "node", ["-v"])).toEqual([
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      "--tmpfs", p("/h"), "--tmpfs", p("/other"), "--tmpfs", p("/h/child/deep"),
      "--ro-bind", p("/h/tools"), p("/h/tools"),
      "--bind", p("/h/ws"), p("/h/ws"),
      "--chdir", p("/h/ws"),
      "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session",
      "--unshare-net",
      "--", "node", "-v",
    ]);
  });

  it("omits --unshare-net when the network is on", () => {
    const args = sandboxArgs({ hide: [], roBinds: [], rwBinds: [], cwd: resolve("/w"), network: true }, "true", []);
    expect(args).not.toContain("--unshare-net");
    expect(args.slice(-2)).toEqual(["--", "true"]);
  });

  it("throws on a relative path", () => {
    const base: SandboxSpec = { hide: [], roBinds: [], rwBinds: [], cwd: resolve("/w"), network: false };
    expect(() => sandboxArgs({ ...base, hide: ["rel"] }, "x", [])).toThrow(/absolute/);
    expect(() => sandboxArgs({ ...base, roBinds: ["rel"] }, "x", [])).toThrow(/absolute/);
    expect(() => sandboxArgs({ ...base, rwBinds: ["rel"] }, "x", [])).toThrow(/absolute/);
    expect(() => sandboxArgs({ ...base, cwd: "rel" }, "x", [])).toThrow(/absolute/);
  });
});

describe("bwrapUsable", () => {
  it("is not ok on win32 without spawning", async () => {
    const r = await bwrapUsable("win32");
    expect(r.ok).toBe(false);
  });
});

describe.skipIf(!usable.ok)("bubblewrap e2e", () => {
  let tmp: Tmp;
  let fakeHome: string;
  beforeEach(async () => {
    tmp = await makeTmp("sandbox");
    fakeHome = join(tmp.dir, "home");
    await mkdir(join(fakeHome, "ws"), { recursive: true });
    await writeFile(join(fakeHome, "secret.txt"), "top secret");
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  const run = (network: boolean, command: string, args: string[]) =>
    runBounded("bwrap", sandboxArgs({ hide: [fakeHome], roBinds: [], rwBinds: [join(fakeHome, "ws")], cwd: join(fakeHome, "ws"), network }, command, args), { timeoutMs: 20000 });

  it("hides secrets and keeps the rw bind writable", async () => {
    const r = await run(false, "sh", ["-c", `if cat "${join(fakeHome, "secret.txt")}"; then exit 3; fi; echo hi > "${join(fakeHome, "ws", "out.txt")}"`]);
    expect(r.stdout).not.toContain("top secret");
    expect(r.code).toBe(0);
    expect((await readFile(join(fakeHome, "ws", "out.txt"), "utf8")).trim()).toBe("hi");
  });

  it("blocks loopback with the network off and allows it when on", async () => {
    const server = createServer((_q, s) => s.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/").then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(7))`;
    try {
      const off = await run(false, process.execPath, ["-e", script]);
      expect(off.code).toBe(7);
      const on = await run(true, process.execPath, ["-e", script]);
      expect(on.code).toBe(0);
      expect(on.stdout.trim()).toBe("ok");
    } finally {
      server.close();
    }
  });
});
