import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.ts";
import type { CliIO } from "../../src/cli/io.ts";

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => void out.push(s), err: (s) => void err.push(s), confirm: async () => false, isTTY: false } };
}

describe("main router", () => {
  it("unknown command prints usage and exits 2", async () => {
    const c = capture();
    expect(await main(["nope"], c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/Unknown command: nope[\s\S]*Usage:/);
  });

  it("version prints the release version", async () => {
    const c = capture();
    expect(await main(["version"], c.io)).toBe(0);
    expect(c.out).toEqual(["0.1.0"]);
  });

  it.each(["runs", "eval", "radar"])("%s arrives in a later phase", async (cmd) => {
    const c = capture();
    expect(await main([cmd], c.io)).toBe(2);
    expect(c.err.join("")).toBe(`factory ${cmd} arrives in a later phase`);
  });

  it("commands owned by later tasks are stubs that exit 2", async () => {
    const c = capture();
    expect(await main(["install"], c.io)).toBe(2);
    expect(c.err.join("")).toMatch(/not implemented yet/);
  });

  it("doctor rejects unknown flags with exit 2", async () => {
    const c = capture();
    expect(await main(["doctor", "--bogus"], c.io)).toBe(2);
  });
});
