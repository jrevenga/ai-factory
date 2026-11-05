import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireReplayLock, holdsReplayLock, ledgerDirFor, processStart, REPLAY_LOCK, RunLedger, type InterruptedRun } from "../../../../src/adapters/pi/extension/ledger.ts";
import { loadSnapshot, replayInterrupted, takeSnapshot } from "../../../../src/adapters/pi/extension/reconcile.ts";
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
    renameSync(`${root}.gone`, root);
    // The failed claimant (pid 50) is gone: the next startup retries.
    const second = sinkOf();
    replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: dead }, second.ledger);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(loadSnapshot(join(runDir, "reconcile", "call_1")).status).toBe("done");
    const third = sinkOf();
    expect(replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: "20261104T130000Z-77", isAlive: dead }, third.ledger)).toEqual([]);
    expect(third.events).toEqual([]);
  });

  it("fix round 1 (I3): while the replay lock holder is alive no other session replays the run; once it is gone, one does", async () => {
    const h = await home();
    const root = gitRepo(h);
    const runDir = pendingRun(h, root);
    const holder = "20261104T110000Z-50";
    const alive = (pid: number) => pid === 50;
    expect(acquireReplayLock(runDir, holder, alive)).toBe(true);
    // A second contender while the holder lives: refused, and nothing is replayed; the note says why.
    expect(acquireReplayLock(runDir, SELF, alive)).toBe(false);
    const s = sinkOf();
    expect(replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: alive }, s.ledger)).toEqual([expect.stringContaining("replay in progress elsewhere")]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("runner\n");
    // The holder died: the next startup takes over and replays; the dead holder's lock directory is removed.
    replayInterruptedRuns({ factoryHome: h, projectId: PROJECT, runId: SELF, isAlive: dead }, s.ledger);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect(holdsReplayLock(runDir, SELF)).toBe(true);
    expect(readdirSync(runDir).filter((n) => n.startsWith(REPLAY_LOCK))).toEqual([REPLAY_LOCK]);
  });
});

describe("acquireReplayLock (fix round 2, R50.3)", () => {
  const X = "20261104T100000Z-40";
  const A = "20261104T110000Z-50";
  const B = "20261104T110500Z-60";
  const C = "20261104T111000Z-70";
  // X died; A, B and C are live sessions.
  const alive = (pid: number) => pid !== 40;

  async function lockedByDeadX(): Promise<string> {
    const runDir = join(await home(), "run");
    mkdirSync(runDir, { recursive: true });
    expect(acquireReplayLock(runDir, X, () => true)).toBe(true);
    return runDir;
  }
  const lockNames = (runDir: string) => readdirSync(runDir).filter((n) => n.startsWith(REPLAY_LOCK));

  it("a paused contender with a stale view of a dead holder never takes the lock from the live holder that took over meanwhile", async () => {
    const runDir = await lockedByDeadX();
    let b: boolean | undefined;
    // A judges X dead, then pauses; B takes over completely; A resumes with its stale view.
    const a = acquireReplayLock(runDir, A, alive, (step) => {
      if (step === "inspected" && b === undefined) b = acquireReplayLock(runDir, B, alive);
    });
    expect(b).toBe(true);
    expect(a).toBe(false);
    expect(holdsReplayLock(runDir, B)).toBe(true);
    expect(lockNames(runDir)).toEqual([REPLAY_LOCK]);
    // Later contenders still see B alive.
    expect(acquireReplayLock(runDir, C, alive)).toBe(false);
    expect(holdsReplayLock(runDir, B)).toBe(true);
  });

  it("of two contenders that both judged the dead holder dead, exactly one takes over", async () => {
    const runDir = await lockedByDeadX();
    let b: boolean | undefined;
    // A and B both inspect X; B renames first (inside A's pause), then A renames.
    const a = acquireReplayLock(runDir, A, alive, (step) => {
      if (step === "inspected" && b === undefined) b = acquireReplayLock(runDir, B, alive, () => undefined);
    });
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(holdsReplayLock(runDir, A) !== holdsReplayLock(runDir, B)).toBe(true);
    expect(lockNames(runDir)).toEqual([REPLAY_LOCK]);
  });

  it("a contender that arrives between a takeover rename and the winner's mkdir: still exactly one holder", async () => {
    const runDir = await lockedByDeadX();
    let b: boolean | undefined;
    const a = acquireReplayLock(runDir, A, alive, (step) => {
      if (step === "renamed" && b === undefined) b = acquireReplayLock(runDir, B, alive);
    });
    expect(b).toBe(true);
    expect(a).toBe(false);
    expect(holdsReplayLock(runDir, B)).toBe(true);
  });

  it("fix round 3 (R51): a third contender cannot admit a replay in the window where a stale-view contender has displaced a live holder's lock", async () => {
    const runDir = await lockedByDeadX();
    let b: boolean | undefined;
    let c: boolean | undefined;
    // A judges X dead and pauses; B takes over; A renames B's live lock away; C tries in the window.
    const a = acquireReplayLock(runDir, A, alive, (step) => {
      if (step === "inspected" && b === undefined) b = acquireReplayLock(runDir, B, alive);
      if (step === "displaced") c = acquireReplayLock(runDir, C, alive);
    });
    expect(b).toBe(true);
    expect(c).toBe(false);
    expect(a).toBe(false);
    expect(holdsReplayLock(runDir, B)).toBe(true);
    expect(holdsReplayLock(runDir, C)).toBe(false);
    expect(lockNames(runDir)).toEqual([REPLAY_LOCK]);
  });

  it("fix round 3 (R51): a displaced live-owner directory that was never given back blocks admission and is never deleted", async () => {
    const runDir = await lockedByDeadX();
    expect(acquireReplayLock(runDir, B, alive)).toBe(true);
    renameSync(join(runDir, REPLAY_LOCK), join(runDir, `${REPLAY_LOCK}.stale-aaaa`));
    expect(acquireReplayLock(runDir, C, alive)).toBe(false);
    expect(lockNames(runDir)).toEqual([`${REPLAY_LOCK}.stale-aaaa`]);
    expect(JSON.parse(readFileSync(join(runDir, `${REPLAY_LOCK}.stale-aaaa`, "owner"), "utf8")).runId).toBe(B);
  });

  it("fix round 3 (R51): the lock is rechecked after acquiring; if it was displaced meanwhile the contender releases and backs off", async () => {
    const runDir = join(await home(), "run");
    mkdirSync(runDir, { recursive: true });
    const a = acquireReplayLock(runDir, A, alive, (step) => {
      if (step === "acquired") renameSync(join(runDir, REPLAY_LOCK), join(runDir, `${REPLAY_LOCK}.stale-bbbb`));
    });
    expect(a).toBe(false);
    expect(holdsReplayLock(runDir, A)).toBe(false);
    expect(lockNames(runDir)).toEqual([]);
  });

  it("fix round 3 (R51): stale directories whose owner is dead are pruned, and admission proceeds", async () => {
    const runDir = join(await home(), "run");
    mkdirSync(join(runDir, `${REPLAY_LOCK}.stale-dead1`), { recursive: true });
    writeFileSync(join(runDir, `${REPLAY_LOCK}.stale-dead1`, "owner"), JSON.stringify({ runId: X, pid: 40 }));
    expect(acquireReplayLock(runDir, A, alive)).toBe(true);
    expect(lockNames(runDir)).toEqual([REPLAY_LOCK]);
  });

  it("fix round 3 (R51): an unreadable owner file in a stale directory blocks admission (fail closed)", async () => {
    const runDir = join(await home(), "run");
    mkdirSync(join(runDir, `${REPLAY_LOCK}.stale-junk`), { recursive: true });
    writeFileSync(join(runDir, `${REPLAY_LOCK}.stale-junk`, "owner"), "{not json");
    expect(acquireReplayLock(runDir, A, alive)).toBe(false);
    expect(lockNames(runDir)).toEqual([`${REPLAY_LOCK}.stale-junk`]);
  });

  it("an ownerless lock directory counts as held while recent, and as dead after the grace period", async () => {
    const runDir = join(await home(), "run");
    mkdirSync(join(runDir, REPLAY_LOCK), { recursive: true });
    expect(acquireReplayLock(runDir, A, alive)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(runDir, REPLAY_LOCK), old, old);
    expect(acquireReplayLock(runDir, A, alive)).toBe(true);
    expect(holdsReplayLock(runDir, A)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("a holder whose pid now belongs to another process (different start identity) is dead", async () => {
    const runDir = join(await home(), "run");
    mkdirSync(join(runDir, REPLAY_LOCK), { recursive: true });
    writeFileSync(join(runDir, REPLAY_LOCK, "owner"), JSON.stringify({ runId: X, pid: process.pid, start: "1" }));
    expect(acquireReplayLock(runDir, A, () => true)).toBe(true);
    // This process's own record (pid and its real start) is alive.
    const own = `20261104T120000Z-${process.pid}`;
    const runDir2 = join(runDir, "..", "run2");
    mkdirSync(runDir2);
    expect(acquireReplayLock(runDir2, own, () => true)).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir2, REPLAY_LOCK, "owner"), "utf8"))).toMatchObject({ pid: process.pid, start: processStart(process.pid) });
    expect(acquireReplayLock(runDir2, A, () => true)).toBe(false);
  });

  it("a holder that lost its lock stops replaying before the next manifest", async () => {
    const h = await home();
    const root = gitRepo(h);
    const runDir = pendingRun(h, root);
    const s = sinkOf();
    const out = replayInterrupted(runDir, s.ledger, SELF, undefined, { owns: () => false });
    expect(out.map((o) => o.kind)).toEqual(["kept"]);
    expect(out[0]?.notes.join("\n")).toContain("no longer holds the run's replay lock");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("runner\n");
  });
});
