import { describe, expect, it } from "vitest";
import { buildReport, renderMarkdown } from "../../../src/core/eval/report.ts";
import type { EvalRunManifest, EvalRunRecord } from "../../../src/core/eval/records.ts";
import type { EvalThresholds } from "../../../src/core/eval/thresholds.ts";

const THRESHOLDS: EvalThresholds = {
  schema: 1,
  passRatePp: 5,
  usageReductionPct: 15,
  secondary: { escapedDefectsIncrease: 0, wallTimeIncreasePct: 25, usageIncreasePct: 10 },
};
const NOW = new Date("2026-11-05T12:00:00.000Z");

function manifest(o: { id?: string; suite?: string; exposure?: "public" | "private"; taskIds?: string[]; confirms?: string | null } = {}): EvalRunManifest {
  return {
    v: 1,
    evalRunId: o.id ?? "20261105T100000Z-abcd",
    createdAt: "2026-11-05T10:00:00Z",
    suite: o.suite ?? "full",
    profile: "claude-codex",
    contenders: [
      { id: "claude-code", model: "claude-opus-5-5", provider: "claude", argvTemplate: [], envKeys: [] },
      { id: "pi-bridge", model: "claude-opus-5-5", provider: "claude", argvTemplate: [], envKeys: [] },
    ],
    reps: 5,
    seed: 7,
    tasks: (o.taskIds ?? ["a", "b"]).map((id) => ({ id, tier: "small", split: "dev", source: "private", exposure: o.exposure ?? "private" })),
    pins: { claude: "2.1.318", pi: "1.4.0", bridge: "0.3.0" },
    drift: [],
    factory: { version: "0.2.0", commit: "abc1234" },
    host: { platform: "linux", bwrap: "0.9.0" },
    thresholds: THRESHOLDS,
    confirms: o.confirms ?? null,
  } as unknown as EvalRunManifest;
}

function recs(evalRunId: string, taskIds: string[], candPass: boolean, reps = 5): EvalRunRecord[] {
  const out: EvalRunRecord[] = [];
  for (const taskId of taskIds) {
    for (let rep = 0; rep < reps; rep++) {
      for (const contender of ["claude-code", "pi-bridge"] as const) {
        out.push({
          v: 1,
          evalRunId,
          taskId,
          contender,
          rep,
          startedAt: "2026-11-05T10:00:00Z",
          wallMs: 1000,
          exit: "ok",
          exitCode: 0,
          turns: 1,
          gatesHit: contender === "pi-bridge" ? 1 : 0,
          checks: [],
          pass: contender === "pi-bridge" ? candPass : rep === 0,
          escapedDefects: 0,
          usage: { claude: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
          usageMissing: false,
          quota: {},
          diffStat: null,
          reviewFindings: null,
          corrections: null,
          authWriteBack: null,
          leakSuspect: false,
          errorSummary: null,
        });
      }
    }
  }
  return out;
}

describe("buildReport", () => {
  it("compares every non-reference contender to the profile reference with the manifest seed", () => {
    const m = manifest();
    const r = buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, { incomplete: null, now: NOW });
    expect(r.v).toBe(1);
    expect(r.generatedAt).toBe("2026-11-05T12:00:00.000Z");
    expect(r.comparisons.map((c) => `${c.candidate}>${c.reference}`)).toEqual(["pi-bridge>claude-code"]);
    expect(r.comparisons[0]?.passRateDiffPp).toBeCloseTo(80, 8);
    expect(r.comparisons[0]?.verdict.improved).toBe(true);
    expect(r.comparisons[0]?.confirmedBy).toBeNull();
    expect(r.comparisons[0]?.verdict.eligible).toBe(false);
    expect(r.perTask).toContainEqual({ taskId: "a", contender: "pi-bridge", runs: 5, passes: 5, gatesHit: 5 });
    expect(r.perTask).toContainEqual({ taskId: "a", contender: "claude-code", runs: 5, passes: 1, gatesHit: 0 });
    expect(r.summaries).toHaveLength(2);
  });

  it("has no comparisons without a profile or without the reference", () => {
    const m = { ...manifest(), profile: null } as EvalRunManifest;
    expect(buildReport(m, recs(m.evalRunId, ["a"], true), THRESHOLDS, { incomplete: null, now: NOW }).comparisons).toEqual([]);
    const m2 = { ...manifest(), contenders: manifest().contenders.slice(1) } as EvalRunManifest;
    expect(buildReport(m2, recs(m2.evalRunId, ["a"], true), THRESHOLDS, { incomplete: null, now: NOW }).comparisons).toEqual([]);
  });

  it("a confirming improved private run makes the comparison eligible and is named", () => {
    const m = manifest();
    const cm = manifest({ id: "20261105T110000Z-ef01", taskIds: ["h1"], confirms: m.evalRunId });
    const r = buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, {
      incomplete: null,
      now: NOW,
      confirming: [{ manifest: cm, records: recs(cm.evalRunId, ["h1"], true) }],
    });
    const c = r.comparisons[0];
    expect(c?.confirmedBy).toBe(cm.evalRunId);
    expect(c?.verdict).toMatchObject({ improved: true, eligible: true, note: "eligible" });
  });

  it("a confirming run that is not improved leaves the comparison ineligible", () => {
    const m = manifest();
    const cm = manifest({ id: "conf", taskIds: ["h1"], confirms: m.evalRunId });
    const r = buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, {
      incomplete: null,
      now: NOW,
      confirming: [{ manifest: cm, records: recs("conf", ["h1"], false) }],
    });
    expect(r.comparisons[0]?.confirmedBy).toBeNull();
    expect(r.comparisons[0]?.verdict.eligible).toBe(false);
  });

  it("public exposure in the run or the confirming run blocks eligibility", () => {
    const m = manifest({ exposure: "public" });
    const cm = manifest({ id: "conf", taskIds: ["h1"] });
    const r = buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, { incomplete: null, now: NOW, confirming: [{ manifest: cm, records: recs("conf", ["h1"], true) }] });
    expect(r.comparisons[0]?.verdict.eligible).toBe(false);
    const m2 = manifest();
    const cm2 = manifest({ id: "conf", taskIds: ["h1"], exposure: "public" });
    const r2 = buildReport(m2, recs(m2.evalRunId, ["a", "b"], true), THRESHOLDS, { incomplete: null, now: NOW, confirming: [{ manifest: cm2, records: recs("conf", ["h1"], true) }] });
    expect(r2.comparisons[0]?.verdict.eligible).toBe(false);
  });

  it("an incomplete run is never eligible", () => {
    const m = manifest();
    const cm = manifest({ id: "conf", taskIds: ["h1"] });
    const r = buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, {
      incomplete: { reason: "token budget reached" },
      now: NOW,
      confirming: [{ manifest: cm, records: recs("conf", ["h1"], true) }],
    });
    expect(r.incomplete).toEqual({ reason: "token budget reached" });
    expect(r.comparisons[0]?.verdict.eligible).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("renders a small smoke report deterministically", () => {
    const m = manifest({ suite: "smoke", exposure: "public" });
    const rs = recs(m.evalRunId, ["a", "b"], true, 3);
    rs[0] = { ...(rs[0] as EvalRunRecord), usage: {}, usageMissing: true };
    const r = buildReport(m, rs, THRESHOLDS, { incomplete: { reason: "token budget reached" }, now: NOW });
    const md = renderMarkdown(r);
    expect(renderMarkdown(r)).toBe(md);
    expect(md).toMatchInlineSnapshot(`
      "# Eval report 20261105T100000Z-abcd

      > **Exposure:** 2 of 2 tasks are public, so their checks are published in the repository and a contender with network access could have read them. Claims rely on private tasks only.

      > **Smoke suite:** regression alarm only — no superiority claim.

      > **Incomplete run:** token budget reached. Resume with \`factory eval run --resume 20261105T100000Z-abcd\`.

      - Suite: smoke; profile: claude-codex; reps: 5; seed: 7
      - Factory: 0.2.0 (abc1234)
      - Host: linux; bubblewrap 0.9.0
      - Pins: claude 2.1.318, pi 1.4.0, bridge 0.3.0
      - Drift: none
      - Generated: 2026-11-05T12:00:00.000Z

      ## Tier: small

      | Contender | Runs | Pass rate | SD | Escaped defects | Usage claude (tokens) | Usage codex (tokens) | Wall median | Errors / timeouts | Gates hit | Notes |
      | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
      | claude-code | 6 | 33.3% | 57.7 pp | 0.00 | 100 (IQR 100-100, n=5) | n/a | 1.0 s | 0 / 0 | 0.00 | usage missing in 1 run |
      | pi-bridge | 6 | 100.0% | 0.0 pp | 0.00 | 100 (IQR 100-100, n=6) | n/a | 1.0 s | 0 / 0 | 1.00 | none |

      ## Comparisons against the reference

      ### pi-bridge vs claude-code

      - Tasks compared: 2; minimum runs per task: 3
      - Pass-rate difference: 66.67 pp (95% CI 66.67 to 66.67)
      - Escaped-defects difference: 0.00
      - Usage ratio per provider: claude 1.00 (usage coverage incomplete)
      - Extra usage (providers only the candidate used, median tokens per task): n/a
      - Wall-time ratio: 1.00
      - Verdict: improved (pass-rate branch)
      - Eligible for a claim: no — regression alarm only — no superiority claim
      - Held-out confirmation: none

      ## Per task

      | Task | Contender | Runs | Passes | Gates hit |
      | --- | --- | --- | --- | --- |
      | a | claude-code | 3 | 1 | 0 |
      | a | pi-bridge | 3 | 3 | 3 |
      | b | claude-code | 3 | 1 | 0 |
      | b | pi-bridge | 3 | 3 | 3 |
      "
    `);
  });

  it("renders null metrics as n/a, never 0", () => {
    const m = manifest();
    const rs = recs(m.evalRunId, ["a"], true, 1).map((x) => ({ ...x, exit: "skipped-budget" as const }));
    const md = renderMarkdown(buildReport(m, rs, THRESHOLDS, { incomplete: null, now: NOW }));
    expect(md).toContain("n/a");
  });
});
