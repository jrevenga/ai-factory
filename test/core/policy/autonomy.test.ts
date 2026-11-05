import { describe, expect, it } from "vitest";
import { autonomyAllowsSkip } from "../../../src/core/policy/autonomy.ts";

describe("autonomyAllowsSkip (ruling 13)", () => {
  it("low never allows a skip, even for softened gates", () => {
    expect(autonomyAllowsSkip("design-approval", "low", [])).toBe(false);
    expect(autonomyAllowsSkip("design-approval", "low", ["design-approval"])).toBe(false);
  });

  it("medium allows only softened gates", () => {
    expect(autonomyAllowsSkip("new-dependency", "medium", [])).toBe(false);
    expect(autonomyAllowsSkip("new-dependency", "medium", ["new-dependency"])).toBe(true);
    expect(autonomyAllowsSkip("quota-low", "medium", ["new-dependency"])).toBe(false);
  });

  it("high allows any soft gate", () => {
    expect(autonomyAllowsSkip("review-disagreement", "high", [])).toBe(true);
    expect(autonomyAllowsSkip("design-deviation", "high", ["quota-low"])).toBe(true);
  });

  it("fails closed on an unknown autonomy value or gate id", () => {
    expect(autonomyAllowsSkip("quota-low", "max" as never, ["quota-low"])).toBe(false);
    expect(autonomyAllowsSkip("secrets" as never, "high", [])).toBe(false);
  });
});
