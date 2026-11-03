import { describe, expect, it } from "vitest";
import { projectIdFor, RunEvent, runIdFor } from "../../../src/core/ledger/events.ts";

const hdr = { v: 1, ts: "2026-11-03T00:00:00.000Z", runId: "r" };
const check = {
  id: "c-1", command: "npm test", exitCode: 0, cwd: "/w", fingerprint: "a", fingerprintAfter: "a",
  mutated: false, durationMs: 1, logPath: "/l", at: "t",
};
const review = { taskId: "t1", fingerprint: "a", disposition: "approved", reviewer: "x", findingsSummary: "", at: "t" };

const samples: Record<string, object> = {
  run_start: { pid: 1, projectId: "p", projectRoot: "/p", factoryVersion: "0.2.0" },
  run_end: { reason: "shutdown" },
  run_interrupted: { detectedBy: "r2" },
  gate: { tool: "bash", toolCallId: "x", decision: "deny", reason: "r", summary: "s" },
  route: { state: { route: "small" } },
  decision: { kind: "ruling", justification: "j" },
  progress: { taskId: "t1" },
  checkpoint: { taskId: "t1", sha: "abc", kind: "commit" },
  check: { record: check },
  reconciled: { toolCallId: "x", reverted: ["a"], moved: [], backupDir: "/b" },
  review: { disposition: review },
  error: { where: "w", message: "m" },
};

describe("RunEvent", () => {
  for (const [type, extra] of Object.entries(samples)) {
    it(`parses ${type} and keeps unknown fields`, () => {
      const parsed = RunEvent.parse({ ...hdr, type, ...extra, future: 42 }) as Record<string, unknown>;
      expect(parsed.type).toBe(type);
      expect(parsed.future).toBe(42);
    });
  }
  it("rejects unknown types, wrong version and missing fields", () => {
    expect(RunEvent.safeParse({ ...hdr, type: "nope" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...hdr, v: 2, type: "run_end", reason: "x" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...hdr, type: "checkpoint", taskId: "t", sha: "s", kind: "other" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...hdr, type: "run_end" }).success).toBe(false);
  });
});

describe("ids", () => {
  it("runIdFor formats UTC timestamp and pid", () => {
    expect(runIdFor(new Date("2026-11-03T04:05:06.789Z"), 4242)).toBe("20261103T040506Z-4242");
  });
  it("projectIdFor sanitizes basename and appends 12 hex of the hash", () => {
    const hash = (s: string) => `${"ab".repeat(2)}${Buffer.from(s).toString("hex")}`.padEnd(64, "0");
    const id = projectIdFor("/home/u/My Proj$", hash);
    expect(id).toBe(`My_Proj_-${hash("/home/u/My Proj$").slice(0, 12)}`);
    expect(projectIdFor(`/x/${"a".repeat(80)}`, () => "f".repeat(64))).toBe(`${"a".repeat(40)}-ffffffffffff`);
    expect(projectIdFor("C:\\Users\\me\\repo", () => "1".repeat(64))).toBe("repo-111111111111");
  });
});
