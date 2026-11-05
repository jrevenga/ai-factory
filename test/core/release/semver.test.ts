import { describe, expect, it } from "vitest";
import { compareSemver, satisfies } from "../../../src/core/release/semver.ts";

describe("semver", () => {
  it("compares numerically", () => {
    expect(compareSemver("0.10.0", "0.9.1")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.2.3", "1.10.0")).toBe(-1);
  });
  it("satisfies the supported range form", () => {
    const r = ">=1.4.0 <1.5.0";
    expect(satisfies("1.4.0", r)).toBe(true);
    expect(satisfies("1.4.9", r)).toBe(true);
    expect(satisfies("1.5.0", r)).toBe(false);
    expect(satisfies("1.3.9", r)).toBe(false);
  });
  it("throws on unsupported ranges and versions", () => {
    expect(() => satisfies("1.4.0", "^1.4.0")).toThrow();
    expect(() => compareSemver("1.4", "1.4.0")).toThrow();
  });
});
