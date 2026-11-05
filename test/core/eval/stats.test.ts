import { describe, expect, it } from "vitest";
import type { ContenderId } from "../../../src/core/eval/contenders.ts";
import type { EvalRunManifest, EvalRunRecord } from "../../../src/core/eval/records.ts";
import { type Comparison, aggregate, pairedComparison, verdict } from "../../../src/core/eval/stats.ts";
import type { EvalThresholds } from "../../../src/core/eval/thresholds.ts";

const THRESHOLDS: EvalThresholds = {
  schema: 1,
  passRatePp: 5,
  usageReductionPct: 15,
  secondary: { escapedDefectsIncrease: 0, wallTimeIncreasePct: 25, usageIncreasePct: 10 },
};

type Over = Partial<EvalRunRecord>;
function rec(taskId: string, contender: ContenderId, rep: number, o: Over = {}): EvalRunRecord {
  return {
    v: 1,
    evalRunId: "run-1",
    taskId,
    contender,
    rep,
    startedAt: "2026-11-05T10:00:00Z",
    wallMs: 1000,
    exit: "ok",
    exitCode: 0,
    turns: 1,
    gatesHit: 0,
    checks: [],
    pass: true,
    escapedDefects: 0,
    usage: {},
    usageMissing: false,
    quota: {},
    diffStat: null,
    reviewFindings: null,
    corrections: null,
    authWriteBack: null,
    leakSuspect: false,
    errorSummary: null,
    ...o,
  };
}
const claude = (total: number) => ({ claude: { input: total - 40, output: 30, cacheRead: 10, cacheWrite: 0 } });

function manifest(tasks: { id: string; tier?: "small" | "feature" }[]): EvalRunManifest {
  return {
    suite: "full",
    seed: 7,
    tasks: tasks.map((t) => ({ id: t.id, tier: t.tier ?? "small", exposure: "private" })),
    contenders: [{ id: "claude-code" }, { id: "pi-bridge" }],
  } as unknown as EvalRunManifest;
}

// Reference claude-code: A passes T,F,F; B passes T,T,F. Candidate pi-bridge: A T,T,T; B T,F,F.
function fixture(): EvalRunRecord[] {
  const ref = "claude-code";
  const cand = "pi-bridge";
  const out: EvalRunRecord[] = [];
  const refA = [true, false, false];
  const refB = [true, true, false];
  const candA = [true, true, true];
  const candB = [true, false, false];
  const refEscA = [1, 2, 3];
  const refEscB = [0, 1, 2];
  const candEscB = [0, 2, 4];
  const refWallA = [1000, 2000, 3000];
  const refWallB = [4000, 5000, 6000];
  const refUseA = [150, 250, 0];
  const refUseB = [100, 200, 300];
  for (let k = 0; k < 3; k++) {
    out.push(
      rec("a", ref, k, {
        pass: refA[k],
        escapedDefects: refEscA[k],
        wallMs: refWallA[k],
        usage: k === 2 ? {} : claude(refUseA[k] as number),
        usageMissing: k === 2,
      }),
    );
    out.push(rec("b", ref, k, { pass: refB[k], escapedDefects: refEscB[k], wallMs: refWallB[k], usage: claude(refUseB[k] as number) }));
    out.push(rec("a", cand, k, { pass: candA[k], escapedDefects: 0, wallMs: 1000, usage: claude(100) }));
    out.push(rec("b", cand, k, { pass: candB[k], escapedDefects: candEscB[k], wallMs: 2000, usage: claude(100) }));
  }
  return out;
}

describe("aggregate", () => {
  const sums = aggregate(fixture(), manifest([{ id: "a" }, { id: "b" }]));
  const get = (c: string) => {
    const s = sums.find((x) => x.contender === c && x.tier === "small");
    if (!s) throw new Error(`no summary for ${c}`);
    return s;
  };

  it("emits one summary per contender and tier", () => {
    expect(sums.map((s) => `${s.contender}/${s.tier}`)).toEqual(["claude-code/small", "pi-bridge/small"]);
  });
  it("pass rate and sample sd across reps", () => {
    const ref = get("claude-code");
    expect(ref.runs).toBe(6);
    expect(ref.passRate).toBeCloseTo(0.5, 10);
    expect(ref.passRateSd).toBeCloseTo(0.5, 10);
    const cand = get("pi-bridge");
    expect(cand.passRate).toBeCloseTo(4 / 6, 10);
    expect(cand.passRateSd).toBeCloseTo(Math.sqrt(1 / 12), 10);
  });
  it("usage excludes usageMissing runs but runs counts them", () => {
    const ref = get("claude-code");
    expect(ref.usageMissing).toBe(1);
    expect(ref.usage.claude).toEqual({ median: 200, iqr: [150, 250], n: 5 });
    expect(ref.usage.codex).toBeUndefined();
    expect(get("pi-bridge").usage.claude).toEqual({ median: 100, iqr: [100, 100], n: 6 });
  });
  it("wall median, escaped mean, gates", () => {
    const ref = get("claude-code");
    expect(ref.wallMsMedian).toBe(3500);
    expect(ref.escapedDefectsMean).toBeCloseTo(1.5, 10);
    expect(ref.gatesHitMean).toBe(0);
    expect(ref.errors).toBe(0);
    expect(ref.leakSuspect).toBe(false);
  });
  it("skipped-budget runs are excluded and counted; error and timeout are failures", () => {
    const m = manifest([{ id: "a" }]);
    const rs = [
      rec("a", "claude-code", 0),
      rec("a", "claude-code", 1, { exit: "error", pass: false }),
      rec("a", "claude-code", 2, { exit: "timeout", pass: false, leakSuspect: true }),
      rec("a", "claude-code", 3, { exit: "skipped-budget", pass: false, usageMissing: true }),
    ];
    const s = aggregate(rs, m)[0];
    expect(s?.runs).toBe(3);
    expect(s?.passRate).toBeCloseTo(1 / 3, 10);
    expect(s?.errors).toBe(1);
    expect(s?.timeouts).toBe(1);
    expect(s?.skippedBudget).toBe(1);
    expect(s?.usageMissing).toBe(0);
    expect(s?.leakSuspect).toBe(true);
  });
  it("a contender with only skipped runs has null metrics", () => {
    const s = aggregate([rec("a", "claude-code", 0, { exit: "skipped-budget", pass: false })], manifest([{ id: "a" }]))[0];
    expect(s?.runs).toBe(0);
    expect(s?.passRate).toBeNull();
    expect(s?.wallMsMedian).toBeNull();
  });
  it("splits tiers", () => {
    const m = manifest([{ id: "a", tier: "small" }, { id: "b", tier: "feature" }]);
    const s = aggregate([rec("a", "claude-code", 0), rec("b", "claude-code", 0, { pass: false })], m);
    expect(s.map((x) => [x.tier, x.passRate])).toEqual([
      ["small", 1],
      ["feature", 0],
    ]);
  });
});

describe("pairedComparison", () => {
  const c = pairedComparison(fixture(), "pi-bridge", "claude-code", 7);
  it("mean per-task pass rate difference in pp", () => {
    expect(c.tasks).toBe(2);
    expect(c.minRunsPerTask).toBe(3);
    expect(c.passRateDiffPp).toBeCloseTo(16.67, 2);
  });
  it("bootstrap CI is seeded and deterministic", () => {
    expect(c.ci95[0]).toBeCloseTo(-33.33, 2);
    expect(c.ci95[1]).toBeCloseTo(66.67, 2);
    expect(pairedComparison(fixture(), "pi-bridge", "claude-code", 7).ci95).toEqual(c.ci95);
  });
  it("escaped defects diff, wall ratio, usage ratio", () => {
    expect(c.escapedDefectsDiff).toBeCloseTo(-0.5, 10);
    expect(c.wallRatio).toBeCloseTo(0.45, 10);
    expect(c.usageRatio.claude).toBeCloseTo(0.5, 10);
    expect(c.extraUsage).toEqual({});
  });
  it("a usageMissing counted run makes usage incomplete", () => {
    expect(c.usageComplete).toBe(false);
    const ok = fixture().map((r) => (r.usageMissing ? { ...r, usageMissing: false, usage: claude(200) } : r));
    expect(pairedComparison(ok, "pi-bridge", "claude-code", 7).usageComplete).toBe(true);
  });
  it("only tasks where both have a counted run are compared", () => {
    const rs = [...fixture().filter((r) => !(r.taskId === "b" && r.contender === "pi-bridge")), rec("b", "pi-bridge", 0, { exit: "skipped-budget", pass: false })];
    const c2 = pairedComparison(rs, "pi-bridge", "claude-code", 7);
    expect(c2.tasks).toBe(1);
    expect(c2.passRateDiffPp).toBeCloseTo(66.67, 2);
  });
  it("minRunsPerTask is the minimum counted runs over tasks and contenders", () => {
    const rs = fixture().filter((r) => !(r.taskId === "a" && r.contender === "pi-bridge" && r.rep === 2));
    expect(pairedComparison(rs, "pi-bridge", "claude-code", 7).minRunsPerTask).toBe(2);
  });
  it("R73: provider only the candidate used goes to extraUsage; ratios only for reference providers", () => {
    const rs = fixture()
      .map((r) => (r.usageMissing ? { ...r, usageMissing: false, usage: claude(200) } : r))
      .map((r) =>
        r.contender === "pi-bridge" ? { ...r, usage: { ...r.usage, codex: { input: r.taskId === "a" ? 30 : 50, output: 0, cacheRead: 0, cacheWrite: 0 } } } : r,
      );
    const c2 = pairedComparison(rs, "pi-bridge", "claude-code", 7);
    expect(Object.keys(c2.usageRatio)).toEqual(["claude"]);
    expect(c2.extraUsage).toEqual({ codex: 40 });
    expect(c2.usageComplete).toBe(true);
  });
  it("R73: a candidate without the reference provider on a task has ratio 0", () => {
    const rs = fixture()
      .map((r) => (r.usageMissing ? { ...r, usageMissing: false, usage: claude(200) } : r))
      .map((r) => (r.contender === "pi-bridge" && r.taskId === "a" ? { ...r, usage: {} } : r));
    const c2 = pairedComparison(rs, "pi-bridge", "claude-code", 7);
    expect(c2.usageRatio.claude).toBeCloseTo(0.25, 10); // median of 0 and 0.5
  });
  it("reference provider with no usage on a task is undefined there and makes usage incomplete", () => {
    const rs = fixture()
      .map((r) => (r.usageMissing ? { ...r, usageMissing: false, usage: claude(200) } : r))
      .map((r) => (r.contender === "claude-code" && r.taskId === "a" ? { ...r, usage: {} } : r));
    const c2 = pairedComparison(rs, "pi-bridge", "claude-code", 7);
    expect(c2.usageComplete).toBe(false);
    expect(c2.usageRatio.claude).toBeCloseTo(0.5, 10);
  });
});

function cmp(o: Partial<Comparison> = {}): Comparison {
  return {
    candidate: "pi-bridge",
    reference: "claude-code",
    tasks: 3,
    minRunsPerTask: 5,
    usageComplete: true,
    passRateDiffPp: 0,
    ci95: [0, 0],
    escapedDefectsDiff: 0,
    usageRatio: { claude: 1 },
    extraUsage: {},
    wallRatio: 1,
    ...o,
  };
}
const CTX = { suite: "full", complete: true, manifestTaskIds: ["a", "b", "c"], allPrivate: true, heldoutConfirmed: true };

describe("wall ratio fail-safe (R75)", () => {
  it("is null when a compared task has a non-positive reference wall time", () => {
    const rs: EvalRunRecord[] = [];
    for (let k = 0; k < 5; k++) {
      rs.push(rec("a", "claude-code", k, { wallMs: 0, pass: false, usage: claude(100) }));
      rs.push(rec("a", "pi-bridge", k, { wallMs: 1000, pass: true, usage: claude(100) }));
    }
    const c = pairedComparison(rs, "pi-bridge", "claude-code", 7);
    expect(c.wallRatio).toBeNull();
    const v = verdict(c, THRESHOLDS, { ...CTX, manifestTaskIds: ["a"] });
    expect(v.improved).toBe(false);
    expect(v.eligible).toBe(false);
    expect(v.regressions).toContain("wallTimeIncreasePct");
  });
  it("is null with no compared tasks", () => {
    expect(pairedComparison([], "pi-bridge", "claude-code", 7).wallRatio).toBeNull();
  });
});

describe("verdict boundaries", () => {
  it("pass-rate branch: 5 is not improved, 5.01 is", () => {
    expect(verdict(cmp({ passRateDiffPp: 5 }), THRESHOLDS, CTX).improved).toBe(false);
    const v = verdict(cmp({ passRateDiffPp: 5.01 }), THRESHOLDS, CTX);
    expect(v.improved).toBe(true);
    expect(v.branch).toBe("pass-rate");
    expect(v.regressions).toEqual([]);
  });
  it("usage branch: 0.85 improved, 0.8501 not", () => {
    const v = verdict(cmp({ usageRatio: { claude: 0.85 } }), THRESHOLDS, CTX);
    expect(v.improved).toBe(true);
    expect(v.branch).toBe("usage");
    expect(verdict(cmp({ usageRatio: { claude: 0.8501 } }), THRESHOLDS, CTX).improved).toBe(false);
  });
  it("usage branch needs non-negative pass-rate difference", () => {
    expect(verdict(cmp({ usageRatio: { claude: 0.5 }, passRateDiffPp: -0.1 }), THRESHOLDS, CTX).improved).toBe(false);
    expect(verdict(cmp({ usageRatio: { claude: 0.5 }, passRateDiffPp: 0 }), THRESHOLDS, CTX).improved).toBe(true);
  });
  it("usage branch needs every reference provider under the cut", () => {
    expect(verdict(cmp({ usageRatio: { claude: 0.5, codex: 0.9 } }), THRESHOLDS, CTX).improved).toBe(false);
  });
  it("wall ratio 1.25 is no regression, 1.2501 is", () => {
    expect(verdict(cmp({ passRateDiffPp: 10, wallRatio: 1.25 }), THRESHOLDS, CTX)).toMatchObject({ improved: true, regressions: [] });
    const v = verdict(cmp({ passRateDiffPp: 10, wallRatio: 1.2501 }), THRESHOLDS, CTX);
    expect(v.improved).toBe(false);
    expect(v.regressions).toEqual(["wallTimeIncreasePct"]);
  });
  it("escaped-defects diff 0.01 is a regression, 0 is not", () => {
    const v = verdict(cmp({ passRateDiffPp: 10, escapedDefectsDiff: 0.01 }), THRESHOLDS, CTX);
    expect(v.improved).toBe(false);
    expect(v.regressions).toEqual(["escapedDefectsIncrease"]);
    expect(verdict(cmp({ passRateDiffPp: 10, escapedDefectsDiff: 0 }), THRESHOLDS, CTX).improved).toBe(true);
  });
  it("pass-rate branch: usage ratio 1.1 is fine, 1.1001 is a regression", () => {
    expect(verdict(cmp({ passRateDiffPp: 10, usageRatio: { claude: 1.1 } }), THRESHOLDS, CTX).improved).toBe(true);
    const v = verdict(cmp({ passRateDiffPp: 10, usageRatio: { claude: 1.1001 } }), THRESHOLDS, CTX);
    expect(v.improved).toBe(false);
    expect(v.regressions).toEqual(["usageIncreasePct"]);
  });
  it("incomplete usage blocks the usage branch even at ratio 0.5", () => {
    const v = verdict(cmp({ usageRatio: { claude: 0.5 }, usageComplete: false }), THRESHOLDS, CTX);
    expect(v.improved).toBe(false);
    expect(v.branch).toBeNull();
    expect(v.eligible).toBe(false);
  });
  it("R73: extraUsage blocks the usage branch but not the pass-rate branch", () => {
    expect(verdict(cmp({ usageRatio: { claude: 0.5 }, extraUsage: { codex: 100 } }), THRESHOLDS, CTX).improved).toBe(false);
    expect(verdict(cmp({ passRateDiffPp: 10, extraUsage: { codex: 100 } }), THRESHOLDS, CTX)).toMatchObject({ improved: true, branch: "pass-rate" });
  });
  it("pass-rate branch is evaluated first", () => {
    expect(verdict(cmp({ passRateDiffPp: 10, usageRatio: { claude: 0.5 } }), THRESHOLDS, CTX).branch).toBe("pass-rate");
  });
});

describe("verdict eligibility", () => {
  const good = cmp({ passRateDiffPp: 10 });
  it("smoke is never eligible and says so", () => {
    const v = verdict(good, THRESHOLDS, { ...CTX, suite: "smoke" });
    expect(v.eligible).toBe(false);
    expect(v.note).toBe("regression alarm only — no superiority claim");
  });
  it("full, complete, 5 runs, private, confirmed is eligible", () => {
    const v = verdict(good, THRESHOLDS, CTX);
    expect(v.eligible).toBe(true);
    expect(v.note).toBe("eligible");
  });
  it("an interrupted run with a task at 4 runs is not eligible", () => {
    expect(verdict(cmp({ minRunsPerTask: 4 }), THRESHOLDS, CTX).eligible).toBe(false);
  });
  it("an incomplete run, a missing task, no confirmation, or public exposure is not eligible", () => {
    expect(verdict(good, THRESHOLDS, { ...CTX, complete: false }).eligible).toBe(false);
    expect(verdict(cmp({ tasks: 2 }), THRESHOLDS, CTX).eligible).toBe(false);
    expect(verdict(good, THRESHOLDS, { ...CTX, heldoutConfirmed: false }).eligible).toBe(false);
    expect(verdict(good, THRESHOLDS, { ...CTX, allPrivate: false }).eligible).toBe(false);
  });
  it("notes name the first failing condition", () => {
    expect(verdict(good, THRESHOLDS, { ...CTX, heldoutConfirmed: false }).note).toContain("held-out");
    expect(verdict(good, THRESHOLDS, { ...CTX, allPrivate: false }).note).toContain("private");
  });
});
