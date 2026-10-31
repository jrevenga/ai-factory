import { mkdirSync, readdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeWritable, type ProbeFs } from "../../../../src/adapters/pi/extension/store-probe.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function home(): Promise<string> {
  const t = await makeTmp("store-probe");
  cleanups.push(t.cleanup);
  const dir = join(t.dir, "factory home");
  mkdirSync(dir);
  return dir;
}

function failing(op: "writeFile" | "unlink", calls: string[]): ProbeFs {
  const err = Object.assign(new Error(`${op} denied`), { code: "EACCES" });
  return {
    async writeFile(p, d, o) {
      calls.push(`writeFile ${p}`);
      if (op === "writeFile") throw err;
      await writeFile(p, d, o);
    },
    async unlink(p) {
      calls.push(`unlink ${p}`);
      if (op === "unlink") throw err;
      await unlink(p);
    },
  };
}

describe("storeWritable", () => {
  it("true when the probe can be created and deleted; leaves nothing behind", async () => {
    const dir = await home();
    expect(await storeWritable(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("false when the store directory does not exist", async () => {
    const dir = await home();
    expect(await storeWritable(join(dir, "missing"))).toBe(false);
  });

  it("false when the probe cannot be created, and still attempts cleanup", async () => {
    const dir = await home();
    const calls: string[] = [];
    expect(await storeWritable(dir, failing("writeFile", calls))).toBe(false);
    expect(calls.map((c) => c.split(" ")[0])).toEqual(["writeFile", "unlink"]);
  });

  it("false when the probe was created but cannot be deleted", async () => {
    const dir = await home();
    const calls: string[] = [];
    expect(await storeWritable(dir, failing("unlink", calls))).toBe(false);
    expect(calls.map((c) => c.split(" ")[0])).toEqual(["writeFile", "unlink"]);
  });
});
