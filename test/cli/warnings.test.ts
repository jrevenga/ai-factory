import { spawnSync } from "node:child_process";
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
