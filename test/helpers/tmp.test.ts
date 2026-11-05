import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
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

describe("makeTmp safety", () => {
  it("rejects prefixes that are not a single path component", async () => {
    for (const bad of ["", "..", "a/b", "a\\b", "../x", "link/factory"]) {
      await expect(makeTmp(bad)).rejects.toThrow(/single path component/);
    }
  });

  it("cleanup of a missing directory is a no-op", async () => {
    const t = await makeTmp("factory-test");
    await t.cleanup();
    await expect(t.cleanup()).resolves.toBeUndefined();
  });

  it("refuses to remove through a symlink that escapes tmpdir", async () => {
    const outside = await mkdtemp(join(process.cwd(), "node_modules", ".outside-"));
    const t = await makeTmp("factory-test");
    try {
      writeFileSync(join(outside, "keep.txt"), "x");
      await rm(t.dir, { recursive: true });
      try {
        symlinkSync(outside, t.dir, "junction");
      } catch {
        return; // symlink creation not permitted on this platform
      }
      await expect(t.cleanup()).rejects.toThrow(/refusing/);
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
      unlinkSync(t.dir);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
