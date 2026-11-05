import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ledgerDirFor, RunLedger, type InterruptedRun } from "../../../../src/adapters/pi/extension/ledger.ts";
import { claimReplay, REPLAY_OWNERS } from "../../../../src/adapters/pi/extension/replay-owners.ts";
import { loadSnapshot, Reconciler, replayInterrupted, takeSnapshot } from "../../../../src/adapters/pi/extension/reconcile.ts";
import { lastRouteEntryRunId, recoverRuns, replayInterruptedRuns, resumeLine, resumeSection } from "../../../../src/adapters/pi/extension/resume.ts";
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

  it("M5: when another session already claimed the run, this session still restores flagged and resumes from it", async () => {
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

/** A committed repo next to the factory home, and a run R1 interrupted with a pending answer-route snapshot. */
function gitRepo(h: string): string {
  const root = join(h, "..", "project");
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(root, "a.txt"), "original\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

function pendingRun(h: string, root: string): string {
  interruptedRun(h, R1, "session-a", []);
  const runDir = join(ledgerDirFor(h, PROJECT), R1);
  takeSnapshot(root, join(runDir, "reconcile", "call_1"), undefined, { toolCallId: "call-1", seq: 1 });
  // The runner ran and Pi was killed before its tool_result.
  writeFileSync(join(root, "a.txt"), "runner\n");
  return runDir;
}

const sinkOf = () => {
  const events: RunEvent[] = [];
  return { events, ledger: { append: (e: RunEvent) => void events.push(RunEvent.parse(e)) } };
};

describe("replayInterruptedRuns", () => {
  it("finishes a pending answer-route reconcile of an interrupted run, audited in the new run, and removes a snapshot dir without manifest", async () => {
    const h = await home();
    const root = gitRepo(h);
    const runDir = pendingRun(h, root);
    mkdirSync(join(runDir, "reconcile", "call_2", "before"), { recursive: true });

    recoverRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, piSession: "session-b", entries: [], isAlive: dead });
    const s = sinkOf();
    const notes = replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: dead }, s.ledger);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(notes).toEqual([expect.stringMatching(new RegExp(`^Interrupted factory run ${R1}: Reverted on the answer route .*reverted a\\.txt`))]);
    expect(s.events).toEqual([expect.objectContaining({ type: "reconciled", runId: SELF, toolCallId: "call-1", reverted: ["a.txt"] })]);
    expect(existsSync(join(runDir, "reconcile", "call_2"))).toBe(false);
    expect(existsSync(join(runDir, "reconcile", "call_1", "after", "a.txt"))).toBe(true);
  });

  it("fix round 1 (I3): a run marked interrupted by a recovering session that died before replaying is replayed at the next startup", async () => {
    const h = await home();
    const root = gitRepo(h);
    pendingRun(h, root);
    // The recovering session claims and marks R1, then dies before its replay.
    const claimer = "20261104T110000Z-50";
    expect(recoverRuns({ factoryHome: h, projectId: PROJECT, runId: claimer, entries: [], isAlive: dead }).claimed.map((c) => c.runId)).toEqual([R1]);
    // The next startup no longer claims R1 (already marked), but still replays its pending manifest.
    expect(recoverRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, entries: [], isAlive: dead }).claimed).toEqual([]);
    const s = sinkOf();
    replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: dead }, s.ledger);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(s.events).toEqual([expect.objectContaining({ type: "reconciled", toolCallId: "call-1" })]);
  });

  it("fix round 1 (I3): a replay that failed stays retryable until its manifest is done, and a done run is not replayed again", async () => {
    const h = await home();
    const root = gitRepo(h);
    const runDir = pendingRun(h, root);
    renameSync(root, `${root}.gone`);
    const first = sinkOf();
    const notes = replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: "20261104T110000Z-50", isAlive: dead }, first.ledger);
    expect(notes.join("\n")).toContain("failed");
    expect(loadSnapshot(join(runDir, "reconcile", "call_1")).status).not.toBe("done");
    // R52: the claimant removed its owner entry when its replay ended, failed or not.
    expect(readdirSync(join(runDir, REPLAY_OWNERS))).toEqual([]);
    renameSync(`${root}.gone`, root);
    // The next startup retries.
    const second = sinkOf();
    replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: dead }, second.ledger);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(loadSnapshot(join(runDir, "reconcile", "call_1")).status).toBe("done");
    const third = sinkOf();
    expect(replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: "20261104T130000Z-77", isAlive: dead }, third.ledger)).toEqual([]);
    expect(third.events).toEqual([]);
  });

  it("R52: while another live session owns the replay no other session replays the run; once it is gone, one does and releases", async () => {
    const h = await home();
    const root = gitRepo(h);
    const runDir = pendingRun(h, root);
    const holder = "20261104T110000Z-50";
    const alive = (pid: number) => pid === 50;
    expect(claimReplay(runDir, holder, alive)).toBeDefined();
    // A second contender while the holder lives: refused, its own entry removed, and nothing is replayed.
    expect(claimReplay(runDir, SELF, alive)).toBeUndefined();
    expect(readdirSync(join(runDir, REPLAY_OWNERS))).toHaveLength(1);
    const s = sinkOf();
    expect(replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: alive }, s.ledger)).toEqual([expect.stringContaining("replay in progress elsewhere")]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("runner\n");
    // The holder died: the next startup prunes its entry, replays, and removes its own entry when done.
    replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: dead }, s.ledger);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(readdirSync(join(runDir, REPLAY_OWNERS))).toEqual([]);
  });
});

describe("replayInterrupted ownership re-check (R52)", () => {
  it("a holder that lost its lock stops replaying before the next manifest", async () => {
    const h = await home();
    const root = gitRepo(h);
    const runDir = pendingRun(h, root);
    const s = sinkOf();
    const out = replayInterrupted(runDir, s.ledger, SELF, undefined, { owns: () => false });
    expect(out.map((o) => o.kind)).toEqual(["kept"]);
    expect(out[0]?.notes.join("\n")).toContain("no longer owns the run's replay");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("runner\n");
  });
});

describe("R62: unfinished reconciles of a run that ended cleanly", () => {
  it("a reconciliation that failed in-process is replayed at the next startup once its owner is gone, run_end or not", async () => {
    const h = await home();
    const root = gitRepo(h);
    interruptedRun(h, R1, "session-a", []);
    const runDir = join(ledgerDirFor(h, PROJECT), R1);
    const rec = new Reconciler(runDir);
    rec.begin("call-1", undefined, root);
    writeFileSync(join(root, "a.txt"), "runner\n");
    // A transient failure: the work tree is briefly unavailable when the call's result arrives.
    renameSync(root, `${root}.gone`);
    const live = sinkOf();
    const diag: string[] = [];
    rec.finishId("call-1", live.ledger, R1, (m) => diag.push(m));
    expect(diag.join("\n")).toContain("failed");
    renameSync(`${root}.gone`, root);
    expect(rec.size).toBe(0);
    // The session then shuts down cleanly.
    new RunLedger(ledgerDirFor(h, PROJECT), R1).append({ v: 1, ts: TS, runId: R1, type: "run_end", reason: "quit" });
    expect(loadSnapshot(join(runDir, "reconcile", "call-1")).status).not.toBe("done");
    // While its process lives the manifest is left alone.
    const alive = sinkOf();
    expect(replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: (pid) => pid === 4242 }, alive.ledger)).toEqual([]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("runner\n");
    // Once it is gone, the next startup replays it.
    const s = sinkOf();
    replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: dead }, s.ledger);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(s.events).toEqual([expect.objectContaining({ type: "reconciled", runId: SELF, toolCallId: "call-1", reverted: ["a.txt"] })]);
    expect(loadSnapshot(join(runDir, "reconcile", "call-1")).status).toBe("done");
  });
});
