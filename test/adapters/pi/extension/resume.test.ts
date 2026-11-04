import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ledgerDirFor, RunLedger, type InterruptedRun } from "../../../../src/adapters/pi/extension/ledger.ts";
import { takeSnapshot } from "../../../../src/adapters/pi/extension/reconcile.ts";
import { lastRouteEntryRunId, recoverRuns, replayClaimed, resumeLine, resumeSection } from "../../../../src/adapters/pi/extension/resume.ts";
import { ROUTE_ENTRY } from "../../../../src/adapters/pi/extension/route-state.ts";
import { RunEvent } from "../../../../src/core/ledger/events.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const isWin = process.platform === "win32";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
beforeAll(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", isWin ? "NUL" : "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const TS = "2026-11-04T10:00:00.000Z";
const PROJECT = "proj-0123456789ab";
const SELF = "20261104T120000Z-99";
const R1 = "20261104T100000Z-11";
const SHA = "a".repeat(40);
const dead = () => false;

async function home(): Promise<string> {
  const t = await makeTmp("resume");
  cleanups.push(t.cleanup);
  return join(realpathSync.native(t.dir), "factory home");
}

function interruptedRun(h: string, runId: string, piSession: string, extra: RunEvent[]): void {
  const l = new RunLedger(ledgerDirFor(h, PROJECT), runId);
  l.append({ v: 1, ts: TS, runId, type: "run_start", pid: 4242, projectId: PROJECT, projectRoot: "/repo", factoryVersion: "0.1.0", piSession });
  for (const e of extra) l.append(e);
}

describe("resumeLine / resumeSection", () => {
  it("names the run, the task, the phase and the last checkpoint, verbatim", () => {
    const run: InterruptedRun = { runId: R1, lastProgress: { taskId: "t1", phase: "implement" }, lastCheckpoint: { taskId: "t1", sha: SHA } };
    expect(resumeLine(run)).toBe(`Interrupted factory run ${R1}: task t1, phase implement, last checkpoint ${SHA}. Resume from the checkpoint; re-declare the route with set_route.`);
  });

  it("a run without a task has no line; missing phase or checkpoint (or ones of another task) are named as such", () => {
    expect(resumeLine({ runId: R1 })).toBeUndefined();
    expect(resumeLine({ runId: R1, route: { route: "feature", taskId: "t2", writeRoots: ["/wt"], needsReclassification: false } })).toContain("task t2, phase unknown, last checkpoint none.");
    expect(resumeLine({ runId: R1, lastProgress: { taskId: "t3" }, lastCheckpoint: { taskId: "t1", sha: SHA } })).toContain("task t3, phase unknown, last checkpoint none.");
    expect(resumeSection([])).toBeUndefined();
    expect(resumeSection(["a", "b"])).toBe("a\nb");
  });

  it("lastRouteEntryRunId reads the runId of the branch's last factory-route entry only", () => {
    const entry = (data: unknown) => ({ type: "custom", customType: ROUTE_ENTRY, data });
    expect(lastRouteEntryRunId([])).toBeUndefined();
    expect(lastRouteEntryRunId([entry({ runId: R1 }), { type: "message" }])).toBe(R1);
    expect(lastRouteEntryRunId([entry({ runId: R1 }), entry({ route: "answer" })])).toBeUndefined();
    expect(lastRouteEntryRunId([entry({ runId: 7 })])).toBeUndefined();
  });
});

describe("recoverRuns", () => {
  it("marks the project's interrupted run, flags this session and records the run it resumes from", async () => {
    const h = await home();
    interruptedRun(h, R1, "session-a", [
      { v: 1, ts: TS, runId: R1, type: "progress", taskId: "t1", phase: "implement" },
      { v: 1, ts: TS, runId: R1, type: "checkpoint", taskId: "t1", sha: SHA, kind: "commit" },
    ]);
    const r = recoverRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, piSession: "session-a", entries: [], isAlive: dead });
    expect(r).toMatchObject({ resumedFrom: [R1], sessionInterrupted: true, errors: [] });
    expect(r.claimed.map((c) => c.runId)).toEqual([R1]);
    expect(r.lines).toEqual([resumeLine({ runId: R1, lastProgress: { taskId: "t1", phase: "implement" }, lastCheckpoint: { taskId: "t1", sha: SHA } })]);
    expect(RunLedger.read(new RunLedger(ledgerDirFor(h, PROJECT), R1).file).at(-1)).toMatchObject({ type: "run_interrupted", detectedBy: SELF });
  });

  it("M5: when another session already claimed the run, this session still restores flagged and resumes from it, but does not replay it", async () => {
    const h = await home();
    interruptedRun(h, R1, "session-a", [{ v: 1, ts: TS, runId: R1, type: "progress", taskId: "t1", phase: "verify" }]);
    const other = recoverRuns({ factoryHome: h, projectId: PROJECT, runId: "20261104T110000Z-50", piSession: "session-b", entries: [], isAlive: dead });
    expect(other).toMatchObject({ resumedFrom: [R1], sessionInterrupted: false });
    const r = recoverRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, piSession: "session-a", entries: [], isAlive: dead });
    expect(r).toMatchObject({ resumedFrom: [R1], sessionInterrupted: true, claimed: [] });
    expect(r.lines[0]).toContain("task t1, phase verify");
  });

  it("a session whose last run ended cleanly restores unflagged; nothing is resumed", async () => {
    const h = await home();
    interruptedRun(h, R1, "session-a", [{ v: 1, ts: TS, runId: R1, type: "run_end", reason: "quit" }]);
    const entries = [{ type: "custom", customType: ROUTE_ENTRY, data: { route: "answer", writeRoots: [], needsReclassification: false, runId: R1 } }];
    expect(recoverRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, piSession: "session-a", entries, isAlive: dead })).toMatchObject({
      resumedFrom: [],
      sessionInterrupted: false,
      lines: [],
    });
  });
});

describe("replayClaimed", () => {
  it("finishes a pending answer-route reconcile of a claimed run, audited in the new run, and removes a snapshot dir without manifest", async () => {
    const h = await home();
    const root = join(h, "..", "project");
    mkdirSync(root, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(root, "a.txt"), "original\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    interruptedRun(h, R1, "session-a", []);
    const runDir = join(ledgerDirFor(h, PROJECT), R1);
    takeSnapshot(root, join(runDir, "reconcile", "call_1"));
    // The runner ran and Pi was killed before its tool_result.
    writeFileSync(join(root, "a.txt"), "runner\n");
    mkdirSync(join(runDir, "reconcile", "call_2", "before"), { recursive: true });

    const r = recoverRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, piSession: "session-b", entries: [], isAlive: dead });
    const events: RunEvent[] = [];
    const notes = replayClaimed(r, h, PROJECT, { append: (e) => void events.push(RunEvent.parse(e)) }, SELF);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(notes).toEqual([expect.stringMatching(new RegExp(`^Interrupted factory run ${R1}: Reverted on the answer route .*reverted a\\.txt`))]);
    expect(events).toEqual([expect.objectContaining({ type: "reconciled", runId: SELF, toolCallId: "call_1", reverted: ["a.txt"] })]);
    expect(existsSync(join(runDir, "reconcile", "call_2"))).toBe(false);
    expect(existsSync(join(runDir, "reconcile", "call_1", "after", "a.txt"))).toBe(true);
  });
});
