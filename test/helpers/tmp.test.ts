import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { makeTmp } from "./tmp.ts";

describe("makeTmp", () => {
  it("creates an existing directory under tmpdir whose path contains a space", async () => {
    const t = await makeTmp("factory-test");
    try {
      expect(t.dir).toContain(" ");
      expect(t.dir.startsWith(tmpdir())).toBe(true);
      expect(existsSync(t.dir)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("cleanup removes the directory", async () => {
    const t = await makeTmp("factory-test");
    await t.cleanup();
    expect(existsSync(t.dir)).toBe(false);
  });
});
