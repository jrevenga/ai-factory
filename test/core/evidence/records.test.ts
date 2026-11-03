import { describe, expect, it } from "vitest";
import {
  type CheckRecord,
  type ReviewDisposition,
  validateDelivery,
} from "../../../src/core/evidence/records.ts";

const check = (over: Partial<CheckRecord> = {}): CheckRecord => ({
  id: "c-1",
  command: "npm test",
  exitCode: 0,
  cwd: "/w",
  fingerprint: "fp1",
  fingerprintAfter: "fp1",
  mutated: false,
  durationMs: 10,
  logPath: "/l/c-1.log",
  at: "2026-11-03T00:00:00.000Z",
  ...over,
});
const review = (over: Partial<ReviewDisposition> = {}): ReviewDisposition => ({
  taskId: "t1",
  fingerprint: "fp1",
  disposition: "approved",
  reviewer: "codex",
  findingsSummary: "none",
  at: "2026-11-03T00:00:00.000Z",
  ...over,
});
const base = { tier: "feature" as const, fingerprint: "fp1", checks: [check()], dispositions: [review()], requiredCheckIds: ["c-1"] };

describe("validateDelivery", () => {
  it("accepts a feature with passing check and approved disposition", () => {
    expect(validateDelivery(base)).toEqual({ ok: true });
  });
  it("accepts approved_with_rulings", () => {
    expect(validateDelivery({ ...base, dispositions: [review({ disposition: "approved_with_rulings" })] }).ok).toBe(true);
  });
  it("rejects a mismatched check fingerprint", () => {
    const r = validateDelivery({ ...base, checks: [check({ fingerprint: "old", fingerprintAfter: "old" })] });
    expect(r.ok).toBe(false);
  });
  it("rejects a mutated record", () => {
    const r = validateDelivery({ ...base, checks: [check({ mutated: true, fingerprintAfter: "fp2" })] });
    expect(r).toMatchObject({ ok: false });
  });
  it("rejects a non-zero exit", () => {
    expect(validateDelivery({ ...base, checks: [check({ exitCode: 1 })] }).ok).toBe(false);
  });
  it("rejects a missing required check", () => {
    expect(validateDelivery({ ...base, requiredCheckIds: ["c-1", "c-2"] }).ok).toBe(false);
  });
  it("rejects a missing disposition for feature and project", () => {
    expect(validateDelivery({ ...base, dispositions: [] }).ok).toBe(false);
    expect(validateDelivery({ ...base, tier: "project", dispositions: [] }).ok).toBe(false);
  });
  it("rejects escalated and stale-fingerprint dispositions", () => {
    expect(validateDelivery({ ...base, dispositions: [review({ disposition: "escalated" })] }).ok).toBe(false);
    expect(validateDelivery({ ...base, dispositions: [review({ fingerprint: "old" })] }).ok).toBe(false);
  });
  it("accepts small without a disposition", () => {
    expect(validateDelivery({ ...base, tier: "small", dispositions: [] })).toEqual({ ok: true });
  });
  it("reports every reason", () => {
    const r = validateDelivery({ ...base, checks: [check({ exitCode: 2 })], dispositions: [] });
    expect(r.ok === false && r.reasons.length).toBe(2);
  });
});
