import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerDirFor, reconcile, RunLedger } from "../../../../src/adapters/pi/extension/ledger.ts";
import type { RunEvent } from "../../../../src/core/ledger/events.ts";
import { deadPid } from "../../../helpers/dead-pid.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function factoryHome(): Promise<string> {
  const t = await makeTmp("ledger");
  cleanups.push(t.cleanup);
  return join(t.dir, "factory home");
}

const TS = "2026-11-03T10:00:00.000Z";
const PROJECT = "proj-0123456789ab";

function start(runId: string, pid: number): RunEvent {
  return { v: 1, ts: TS, runId, type: "run_start", pid, projectId: PROJECT, projectRoot: "/repo", factoryVersion: "0.2.0" };
}

function events(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as unknown);
}

describe("RunLedger", () => {
  it("writes one JSON line per event under <dir>/<runId>/events.jsonl, redacting every string field", async () => {
    const home = await factoryHome();
    const dir = ledgerDirFor(home, PROJECT);
    expect(dir).toBe(join(home, "runs", PROJECT));
    const ledger = new RunLedger(dir, "20261103T100000Z-1");
    expect(ledger.file).toBe(join(dir, "20261103T100000Z-1", "events.jsonl"));
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    ledger.append({
      v: 1,
      ts: TS,
      runId: "20261103T100000Z-1",
      type: "gate",
      tool: "bash",
      toolCallId: "call-1",
      decision: "ask",
      reason: "remote-mutating command",
      summary: `git push https://x:${token}@github.com/o/r\nsecond line`,
    });
    ledger.append({ v: 1, ts: TS, runId: "20261103T100000Z-1", type: "route", state: { reason: `uses API_KEY=${token}`, nested: [`Bearer ${token}`] } });
    const text = readFileSync(ledger.file, "utf8");
    expect(text).not.toContain(token);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(RunLedger.read(ledger.file).map((e) => e.type)).toEqual(["gate", "route"]);
    const gate = RunLedger.read(ledger.file)[0] as Extract<RunEvent, { type: "gate" }>;
    expect(gate.summary).toBe("git push https://***@github.com/o/r\nsecond line");
  });

  it("rejects an event that is not a valid run event and a runId that is not a single path component", async () => {
    const home = await factoryHome();
    const ledger = new RunLedger(ledgerDirFor(home, PROJECT), "r1");
    expect(() => ledger.append({ v: 1, ts: TS, runId: "r1", type: "progress" } as unknown as RunEvent)).toThrow();
    expect(() => new RunLedger(home, "../escape")).toThrow(/runId/);
    expect(() => new RunLedger(home, "")).toThrow(/runId/);
  });

  it("read skips a truncated final line (half-written after SIGKILL) and unknown event types", async () => {
    const home = await factoryHome();
    const ledger = new RunLedger(ledgerDirFor(home, PROJECT), "r1");
    ledger.append(start("r1", 1));
    appendFileSync(ledger.file, `${JSON.stringify({ v: 1, ts: TS, runId: "r1", type: "from_the_future", x: 1 })}\n`);
    ledger.append({ v: 1, ts: TS, runId: "r1", type: "progress", taskId: "t1", phase: "build" });
    appendFileSync(ledger.file, '{"v":1,"ts":"2026-11-03T10:00:01.000Z","runId":"r1","type":"progr');
    expect(RunLedger.read(ledger.file).map((e) => e.type)).toEqual(["run_start", "progress"]);
  });

  it("read throws on a corrupt middle line, naming the file and line", async () => {
    const home = await factoryHome();
    const ledger = new RunLedger(ledgerDirFor(home, PROJECT), "r1");
    ledger.append(start("r1", 1));
    appendFileSync(ledger.file, "not json\n");
    ledger.append({ v: 1, ts: TS, runId: "r1", type: "run_end", reason: "shutdown" });
    expect(() => RunLedger.read(ledger.file)).toThrow(new RegExp(`${ledger.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2`));
    // A known type with a bad shape in the middle is corruption too.
    writeFileSync(ledger.file, `${JSON.stringify({ v: 1, ts: TS, runId: "r1", type: "progress" })}\n${JSON.stringify(start("r1", 1))}\n`);
    expect(() => RunLedger.read(ledger.file)).toThrow(/:1/);
  });

  it("an append after a torn final line drops the torn bytes so every line stays complete", async () => {
    const home = await factoryHome();
    const dir = ledgerDirFor(home, PROJECT);
    const first = new RunLedger(dir, "r1");
    first.append(start("r1", 1));
    appendFileSync(first.file, '{"v":1,"type":"prog');
    new RunLedger(dir, "r1").append({ v: 1, ts: TS, runId: "r1", type: "run_end", reason: "x" });
    expect(RunLedger.read(first.file).map((e) => e.type)).toEqual(["run_start", "run_end"]);
  });
});

describe("RunLedger review fixes", () => {
  it("an unterminated final line that parses is kept (terminated), not dropped, before the next append", async () => {
    const home = await factoryHome();
    const dir = ledgerDirFor(home, PROJECT);
    const first = new RunLedger(dir, "r1");
    first.append(start("r1", 1));
    appendFileSync(first.file, JSON.stringify({ v: 1, ts: TS, runId: "r1", type: "checkpoint", taskId: "t1", sha: "abc", kind: "commit" }));
    expect(RunLedger.read(first.file).map((e) => e.type)).toEqual(["run_start", "checkpoint"]);
    new RunLedger(dir, "r1").append({ v: 1, ts: TS, runId: "r1", type: "run_end", reason: "x" });
    expect(RunLedger.read(first.file).map((e) => e.type)).toEqual(["run_start", "checkpoint", "run_end"]);
  });

  it("masks string values whose key names a secret, at any depth", async () => {
    const home = await factoryHome();
    const ledger = new RunLedger(ledgerDirFor(home, PROJECT), "r1");
    ledger.append({ v: 1, ts: TS, runId: "r1", type: "route", state: { token: "abc123", nested: { apiKey: "zzz9", DB_PASSWORD: "hunter2" }, reason: "ok" } });
    const text = readFileSync(ledger.file, "utf8");
    for (const v of ["abc123", "zzz9", "hunter2"]) expect(text).not.toContain(v);
    expect(text).toContain('"reason":"ok"');
  });

  it("ledgerDirFor requires projectId to be a single path component", () => {
    expect(() => ledgerDirFor("/h", "../x")).toThrow(/projectId/);
    expect(() => ledgerDirFor("/h", "")).toThrow(/projectId/);
  });
});

describe("reconcile", () => {
  it("finds a run with a dead pid and no run_end, returns its last progress/checkpoint/route, and reports it once", async () => {
    const home = await factoryHome();
    const dir = ledgerDirFor(home, PROJECT);
    const dead = await deadPid();
    const isAlive = (pid: number) => pid !== dead;

    const crashed = new RunLedger(dir, "20261103T090000Z-11");
    crashed.append(start("20261103T090000Z-11", dead));
    const route = { route: "small", tier: "small", taskId: "t1", writeRoots: ["/repo"], needsReclassification: false, base: "abc" };
    crashed.append({ v: 1, ts: TS, runId: "20261103T090000Z-11", type: "route", state: { route: "answer", writeRoots: [], needsReclassification: false } });
    crashed.append({ v: 1, ts: TS, runId: "20261103T090000Z-11", type: "route", state: route });
    crashed.append({ v: 1, ts: TS, runId: "20261103T090000Z-11", type: "progress", taskId: "t1", phase: "plan" });
    crashed.append({ v: 1, ts: TS, runId: "20261103T090000Z-11", type: "checkpoint", taskId: "t1", sha: "1111111", kind: "undo-ref" });
    crashed.append({ v: 1, ts: TS, runId: "20261103T090000Z-11", type: "progress", taskId: "t1", phase: "build", item: "step 2" });
    // SIGKILL mid-write.
    appendFileSync(crashed.file, '{"v":1,"ts":"x","runId":"20261103T090000Z-11","type":"checkp');

    const ended = new RunLedger(dir, "20261103T080000Z-12");
    ended.append(start("20261103T080000Z-12", dead));
    ended.append({ v: 1, ts: TS, runId: "20261103T080000Z-12", type: "run_end", reason: "shutdown" });

    const live = new RunLedger(dir, "20261103T095000Z-13");
    live.append(start("20261103T095000Z-13", process.pid));

    const self = new RunLedger(dir, "20261103T100000Z-14");
    self.append(start("20261103T100000Z-14", process.pid));

    const found = reconcile(home, PROJECT, "20261103T100000Z-14", isAlive);
    expect(found).toEqual([
      {
        runId: "20261103T090000Z-11",
        lastProgress: { taskId: "t1", phase: "build", item: "step 2" },
        lastCheckpoint: { taskId: "t1", sha: "1111111" },
        route,
      },
    ]);
    const marked = RunLedger.read(crashed.file);
    expect(marked.at(-1)).toMatchObject({ type: "run_interrupted", runId: "20261103T090000Z-11", detectedBy: "20261103T100000Z-14" });
    expect(events(crashed.file).at(-1)).toMatchObject({ type: "run_interrupted" });

    expect(reconcile(home, PROJECT, "20261103T100001Z-15", isAlive)).toEqual([]);
  });

  it("a run whose start line was torn uses the pid in its runId; no ledger directory means nothing to reconcile", async () => {
    const home = await factoryHome();
    expect(reconcile(home, PROJECT, "self-1", () => false)).toEqual([]);
    const dead = await deadPid();
    const dir = ledgerDirFor(home, PROJECT);
    mkdirSync(join(dir, `20261103T090000Z-${dead}`), { recursive: true });
    writeFileSync(join(dir, `20261103T090000Z-${dead}`, "events.jsonl"), '{"v":1,"type":"run_st');
    const seen: number[] = [];
    const found = reconcile(home, PROJECT, "self-1", (pid) => {
      seen.push(pid);
      return false;
    });
    expect(found).toEqual([{ runId: `20261103T090000Z-${dead}` }]);
    expect(seen).toEqual([dead]);
  });

  it("a run already claimed by another reconciler (interrupted.claim) is skipped and not marked twice", async () => {
    const home = await factoryHome();
    const dir = ledgerDirFor(home, PROJECT);
    const r = new RunLedger(dir, "r-1");
    r.append(start("r-1", 1));
    writeFileSync(join(dir, "r-1", "interrupted.claim"), "other\n");
    expect(reconcile(home, PROJECT, "self-9", () => false)).toEqual([]);
    expect(readFileSync(r.file, "utf8")).not.toContain("run_interrupted");
    // An unclaimed run gets the claim written by the reconciler that marks it.
    const q = new RunLedger(dir, "r-2");
    q.append(start("r-2", 1));
    expect(reconcile(home, PROJECT, "self-9", () => false)).toEqual([{ runId: "r-2" }]);
    expect(readFileSync(join(dir, "r-2", "interrupted.claim"), "utf8")).toContain("self-9");
  });

  it("an invalid route state in the ledger is not restored", async () => {
    const home = await factoryHome();
    const dir = ledgerDirFor(home, PROJECT);
    const r = new RunLedger(dir, "r-1");
    r.append(start("r-1", 1));
    r.append({ v: 1, ts: TS, runId: "r-1", type: "route", state: { route: "everything", writeRoots: "/" } });
    expect(reconcile(home, PROJECT, "self-2", () => false)).toEqual([{ runId: "r-1" }]);
  });

  it("a run whose ledger is corrupt in the middle is reported with the error and not marked", async () => {
    const home = await factoryHome();
    const dir = ledgerDirFor(home, PROJECT);
    const r = new RunLedger(dir, "r-1");
    r.append(start("r-1", 1));
    appendFileSync(r.file, "garbage\n");
    r.append({ v: 1, ts: TS, runId: "r-1", type: "progress", taskId: "t1" });
    const found = reconcile(home, PROJECT, "self-3", () => false);
    expect(found).toHaveLength(1);
    expect(found[0]!.runId).toBe("r-1");
    expect(found[0]!.error).toMatch(/events\.jsonl:2/);
    expect(readFileSync(r.file, "utf8")).not.toContain("run_interrupted");
  });
});
