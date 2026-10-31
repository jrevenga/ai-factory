import { describe, expect, it } from "vitest";
import { FactoryState, SnapshotInfo, TxnRecord, schemaOf } from "../../../src/core/state/schema.ts";

const STATE = {
  schema: 1,
  version: "0.1.0",
  installedAt: "2026-10-31T10:00:00.000Z",
  source: "https://github.com/jrevenga/ai-factory.git",
  piVersion: "1.4.0",
  piCli: "/home/u/.factory/pi/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  history: [{ version: "0.1.0", at: "2026-10-31T10:00:00.000Z", reason: "install" }],
};

describe("FactoryState", () => {
  it("accepts a valid state and preserves unknown fields (additive changes)", () => {
    const parsed = FactoryState.parse({ ...STATE, futureField: { a: 1 }, history: [{ ...STATE.history[0], note: "x" }] });
    expect(parsed).toMatchObject({ futureField: { a: 1 }, history: [{ note: "x" }] });
  });

  it("rejects an unknown history reason and a different schema", () => {
    expect(FactoryState.safeParse({ ...STATE, history: [{ version: "0.1.0", at: "x", reason: "reinstall" }] }).success).toBe(false);
    expect(FactoryState.safeParse({ ...STATE, schema: 2 }).success).toBe(false);
  });
});

describe("SnapshotInfo and TxnRecord", () => {
  it("parse their documents", () => {
    expect(
      SnapshotInfo.parse({ id: "a", from: "0.1.0", to: "0.2.0", kind: "update", at: "t", files: ["state.json"] }).files,
    ).toEqual(["state.json"]);
    expect(TxnRecord.safeParse({ id: "a", kind: "rollback", from: "0.2.0", to: "0.1.0", snapshot: "a", startedAt: "t" }).success).toBe(true);
    expect(TxnRecord.safeParse({ id: "a", kind: "install", from: "", to: "", snapshot: "a", startedAt: "t" }).success).toBe(false);
  });
});

describe("schemaOf", () => {
  it("returns the integer schema of a document or undefined", () => {
    expect(schemaOf({ schema: 3 })).toBe(3);
    expect(schemaOf({ schema: "1" })).toBeUndefined();
    expect(schemaOf({ schema: 1.5 })).toBeUndefined();
    expect(schemaOf([])).toBeUndefined();
    expect(schemaOf(null)).toBeUndefined();
  });
});
