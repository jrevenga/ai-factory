import { describe, expect, it } from "vitest";
import { evaluateHandshake } from "../../src/core/handshake.ts";

const good = { expectedVersion: "0.1.0", packageVersion: "0.1.0", configOk: true, storeWritable: true };

describe("evaluateHandshake", () => {
  it("no state -> not-installed", () => {
    expect(evaluateHandshake({ ...good, expectedVersion: undefined })).toEqual({
      ok: false,
      version: "0.1.0",
      policy: "v1",
      reasons: ["not-installed"],
    });
  });

  it("all good -> ok with policy v1", () => {
    expect(evaluateHandshake(good)).toEqual({ ok: true, version: "0.1.0", policy: "v1", reasons: [] });
  });

  it("state version differs from the package version -> version-mismatch", () => {
    const r = evaluateHandshake({ ...good, expectedVersion: "9.9.9" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(["version-mismatch"]);
  });

  it("reports every failing input in a fixed order", () => {
    expect(evaluateHandshake({ expectedVersion: "0.2.0", packageVersion: "0.1.0", configOk: false, storeWritable: false }).reasons).toEqual([
      "version-mismatch",
      "config-invalid",
      "store-unwritable",
    ]);
    expect(evaluateHandshake({ ...good, expectedVersion: undefined, configOk: false }).reasons).toEqual(["not-installed", "config-invalid"]);
  });
});
