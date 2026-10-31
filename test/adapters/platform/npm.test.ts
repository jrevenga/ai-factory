import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npm, NpmNotFound, resolveNpm } from "../../../src/adapters/platform/npm.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const isWindows = process.platform === "win32";
let tmp: Tmp;

beforeEach(async () => {
  tmp = await makeTmp("npm");
});

afterEach(async () => {
  await tmp.cleanup();
});

async function fakeNpmOnPath(): Promise<{ bin: string; npmPath: string }> {
  const bin = join(tmp.dir, "bin dir");
  await mkdir(bin, { recursive: true });
  const npmPath = join(bin, isWindows ? "npm.cmd" : "npm");
  await writeFile(npmPath, isWindows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWindows) await chmod(npmPath, 0o755);
  return { bin, npmPath };
}

describe("resolveNpm", () => {
  it("uses npm_execpath when it is npm's JS entry", () => {
    expect(resolveNpm({ npm_execpath: "/x/npm-cli.js" })).toEqual({ cmd: process.execPath, args: ["/x/npm-cli.js"] });
    expect(resolveNpm({ npm_execpath: "/x/npm-cli.cjs", PATH: "" })).toEqual({ cmd: process.execPath, args: ["/x/npm-cli.cjs"] });
  });

  it("ignores an npm_execpath that belongs to another package manager", () => {
    expect(() => resolveNpm({ npm_execpath: "/x/pnpm.cjs", PATH: "" })).toThrow(NpmNotFound);
  });

  it("throws NpmNotFound with a fix when npm is not on PATH", () => {
    expect(() => resolveNpm({ PATH: "" })).toThrow(NpmNotFound);
    expect(() => resolveNpm({})).toThrow(/install Node\.js/i);
  });

  it("falls back to npm on PATH", async () => {
    const { bin, npmPath } = await fakeNpmOnPath();
    expect(resolveNpm({ PATH: bin })).toEqual({ cmd: npmPath, args: [] });
  });

  it("prefers the npm-cli.js next to the npm found on PATH", async () => {
    const { bin } = await fakeNpmOnPath();
    const cli = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(join(bin, "node_modules", "npm", "bin"), { recursive: true });
    await writeFile(cli, "");
    expect(resolveNpm({ PATH: bin })).toEqual({ cmd: process.execPath, args: [cli] });
  });
});

describe("npm", () => {
  it("runs npm non-interactively with the given args", async () => {
    const fake = join(tmp.dir, "npm-cli.js");
    await writeFile(
      fake,
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), prompt: process.env.GIT_TERMINAL_PROMPT, gcm: process.env.GCM_INTERACTIVE, cwd: process.cwd() }));\n",
    );
    const r = await npm(["install", "C:\\a b"], { env: { ...process.env, npm_execpath: fake }, cwd: tmp.dir, timeoutMs: 30_000 });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { args: string[]; prompt: string; gcm: string };
    expect(out).toMatchObject({ args: ["install", "C:\\a b"], prompt: "0", gcm: "never" });
  });

  it("runs the real npm", async () => {
    const r = await npm(["--version"], { timeoutMs: 60_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
