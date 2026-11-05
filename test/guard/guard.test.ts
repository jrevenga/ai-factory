import { describe, expect, it } from "vitest";
import { GUARD_FILE_NAME, READ_ONLY_TOOLS, guardDecision } from "../../guard/factory-guard.ts";

const REASON = 'factory guard: factory extension not loaded or handshake failed — run "factory doctor"';

describe("guardDecision", () => {
  it("blocks write without a handshake", () => {
    expect(guardDecision("write", undefined)).toEqual({ block: true, reason: REASON });
  });
  it("allows read-only tools without a handshake", () => {
    for (const t of READ_ONLY_TOOLS) expect(guardDecision(t, undefined)).toBeUndefined();
    expect(guardDecision("read", undefined)).toBeUndefined();
  });
  it("allows any tool after a successful handshake", () => {
    expect(guardDecision("bash", { ok: true })).toBeUndefined();
  });
  it("blocks edit after a failed handshake", () => {
    expect(guardDecision("edit", { ok: false })).toEqual({ block: true, reason: REASON });
  });
  it("blocks unknown tools such as codemode without a handshake", () => {
    expect(guardDecision("codemode", undefined)).toEqual({ block: true, reason: REASON });
  });
  it("exports the read-only list and file name", () => {
    expect([...READ_ONLY_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
    expect(GUARD_FILE_NAME).toBe("factory-guard.ts");
  });
});
