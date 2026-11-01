import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installWarningFilter } from "../../bin/warning-filter.mjs";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp } from "../helpers/tmp.ts";

function fakeProcess() {
  const seen: string[] = [];
  const proc = { emitWarning: (w: unknown, ..._rest: unknown[]) => void seen.push(typeof w === "string" ? w : (w as Error).message) };
  return { proc, seen };
}

describe("warning filter", () => {
  it("drops only the SQLite ExperimentalWarning", () => {
    const { proc, seen } = fakeProcess();
    installWarningFilter(proc);
    proc.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    const e = new Error("SQLite is an experimental feature");
    e.name = "ExperimentalWarning";
    proc.emitWarning(e);
    proc.emitWarning("Something else is experimental", "ExperimentalWarning");
    proc.emitWarning("SQLite mentioned in a deprecation", "DeprecationWarning");
    expect(seen).toEqual(["Something else is experimental", "SQLite mentioned in a deprecation"]);
  });
});

describe("bin doctor", () => {
  it("prints no SQLite ExperimentalWarning on stderr", async () => {
    const tmp = await makeTmp("bin-doctor");
    try {
      const env = { ...isolatedEnv(tmp.dir), PI_OFFLINE: "1" };
      const r = spawnSync(process.execPath, ["bin/factory.mjs", "doctor", "--offline", "--json"], { encoding: "utf8", env });
      expect(JSON.parse(r.stdout).some((c: { id: string; status: string }) => c.id === "node-sqlite-fts5" && c.status === "ok")).toBe(true);
      expect(r.stderr).not.toMatch(/ExperimentalWarning|SQLite/);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("bin entry", () => {
  /** A copy of bin/ next to a src/cli/main.ts that throws while loading; node_modules is linked in. */
  async function brokenInstall() {
    const tmp = await makeTmp("bin-broken");
    mkdirSync(join(tmp.dir, "bin"));
    for (const f of ["factory.mjs", "warning-filter.mjs"]) copyFileSync(join("bin", f), join(tmp.dir, "bin", f));
    mkdirSync(join(tmp.dir, "src", "cli"), { recursive: true });
    writeFileSync(join(tmp.dir, "src", "cli", "main.ts"), 'throw new Error("cannot load the CLI");\nexport const main = () => 0;\n');
    symlinkSync(resolve("node_modules"), join(tmp.dir, "node_modules"), "junction");
    return tmp;
  }

  it.each([
    [{}, false],
    [{ FACTORY_DEBUG: "1" }, true],
  ])("a CLI that fails to load prints one line and exits 1 (env %j, stack %s)", async (extra, stack) => {
    const tmp = await brokenInstall();
    try {
      const r = spawnSync(process.execPath, [join(tmp.dir, "bin", "factory.mjs"), "version"], { encoding: "utf8", env: { ...isolatedEnv(tmp.dir), ...extra } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("factory: cannot load the CLI");
      if (stack) expect(r.stderr).toMatch(/\n\s+at /);
      else expect(r.stderr.trim().split("\n")).toHaveLength(1);
    } finally {
      await tmp.cleanup();
    }
  });
});
