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
      confirming: [{ manifest: cm, records: recs(cm.evalRunId, ["h1"], true), incomplete: null }],
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
      confirming: [{ manifest: cm, records: recs("conf", ["h1"], false), incomplete: null }],
    });
    expect(r.comparisons[0]?.confirmedBy).toBeNull();
    expect(r.comparisons[0]?.verdict.eligible).toBe(false);
  });

  it("public exposure in the run or the confirming run blocks eligibility", () => {
    const m = manifest({ exposure: "public" });
    const cm = manifest({ id: "conf", taskIds: ["h1"] });
    const r = buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, { incomplete: null, now: NOW, confirming: [{ manifest: cm, records: recs("conf", ["h1"], true), incomplete: null }] });
    expect(r.comparisons[0]?.verdict.eligible).toBe(false);
    const m2 = manifest();
    const cm2 = manifest({ id: "conf", taskIds: ["h1"], exposure: "public" });
    const r2 = buildReport(m2, recs(m2.evalRunId, ["a", "b"], true), THRESHOLDS, { incomplete: null, now: NOW, confirming: [{ manifest: cm2, records: recs("conf", ["h1"], true), incomplete: null }] });
    expect(r2.comparisons[0]?.verdict.eligible).toBe(false);
  });

  it("an incomplete run is never eligible", () => {
    const m = manifest();
    const cm = manifest({ id: "conf", taskIds: ["h1"] });
    const r = buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, {
      incomplete: { reason: "token budget reached" },
      now: NOW,
      confirming: [{ manifest: cm, records: recs("conf", ["h1"], true), incomplete: null }],
    });
    expect(r.incomplete).toEqual({ reason: "token budget reached" });
    expect(r.comparisons[0]?.verdict.eligible).toBe(false);
  });
});

describe("confirmation eligibility (R74)", () => {
  const build = (cm: EvalRunManifest, cr: EvalRunRecord[], m = manifest()) =>
    buildReport(m, recs(m.evalRunId, ["a", "b"], true), THRESHOLDS, { incomplete: null, now: NOW, confirming: [{ manifest: cm, records: cr, incomplete: null }] }).comparisons[0];
  const m0 = manifest();

  it("a 1-rep confirmation does not confirm", () => {
    const cm = manifest({ id: "conf", taskIds: ["h1"], confirms: m0.evalRunId });
    const one = recs("conf", ["h1"], true, 1).map((r) => (r.contender === "claude-code" ? { ...r, pass: false } : r));
    const c = build(cm, one);
    expect(c?.confirmedBy).toBeNull();
    expect(c?.verdict.eligible).toBe(false);
  });
  it("a confirmation with a usageMissing run does not confirm", () => {
    const cm = manifest({ id: "conf", taskIds: ["h1"], confirms: m0.evalRunId });
    const cr = recs("conf", ["h1"], true);
    cr[0] = { ...(cr[0] as EvalRunRecord), usage: {}, usageMissing: true };
    expect(build(cm, cr)?.confirmedBy).toBeNull();
  });
  it("a confirmation whose confirms names another run does not confirm", () => {
    const cm = manifest({ id: "conf", taskIds: ["h1"], confirms: "other-run" });
    const c = build(cm, recs("conf", ["h1"], true));
    expect(c?.confirmedBy).toBeNull();
    expect(c?.verdict.eligible).toBe(false);
  });
  it("an incomplete confirmation does not confirm", () => {
    const cm = manifest({ id: "conf", taskIds: ["h1"], confirms: m0.evalRunId });
    const r = buildReport(m0, recs(m0.evalRunId, ["a", "b"], true), THRESHOLDS, {
      incomplete: null,
      now: NOW,
      confirming: [{ manifest: cm, records: recs("conf", ["h1"], true), incomplete: { reason: "token budget reached" } }],
    });
    expect(r.comparisons[0]?.confirmedBy).toBeNull();
  });
  it("a confirmation with a different profile does not confirm", () => {
    const cm = { ...manifest({ id: "conf", taskIds: ["h1"], confirms: m0.evalRunId }), profile: "claude-only" } as unknown as EvalRunManifest;
    expect(build(cm, recs("conf", ["h1"], true))?.confirmedBy).toBeNull();
  });
  it("a valid confirmation confirms", () => {
    const cm = manifest({ id: "conf", taskIds: ["h1"], confirms: m0.evalRunId });
    const c = build(cm, recs("conf", ["h1"], true));
    expect(c?.confirmedBy).toBe("conf");
    expect(c?.verdict.eligible).toBe(true);
  });
});

describe("quota summary (R76)", () => {
  it("counts known, unknown and exhausted runs per provider", () => {
    const m = manifest();
    const rs = recs(m.evalRunId, ["a"], true, 3).filter((r) => r.contender === "claude-code");
    rs[0] = { ...(rs[0] as EvalRunRecord), quota: { claude: { state: "known", utilization: 0.4 } } };
    rs[1] = { ...(rs[1] as EvalRunRecord), quota: { claude: { state: "exhausted" } } };
    // rs[2] has claude usage but no quota entry: unknown.
    const r = buildReport(m, rs, THRESHOLDS, { incomplete: null, now: NOW });
    expect(r.summaries.find((s) => s.contender === "claude-code")?.quota).toEqual({ claude: { known: 1, unknown: 1, exhausted: 1 } });
  });
  it("Markdown states unknown quota in words", () => {
    const m = manifest();
    const rs = recs(m.evalRunId, ["a"], true, 3);
    const md = renderMarkdown(buildReport(m, rs, THRESHOLDS, { incomplete: null, now: NOW }));
    expect(md).toContain("claude quota: unknown in 3 of 3 runs");
  });
  it("Markdown states known and exhausted counts", () => {
    const m = manifest();
    const rs = recs(m.evalRunId, ["a"], true, 3).filter((r) => r.contender === "claude-code");
    rs[0] = { ...(rs[0] as EvalRunRecord), quota: { claude: { state: "known", utilization: 0.4 } } };
    rs[1] = { ...(rs[1] as EvalRunRecord), quota: { claude: { state: "known", utilization: 0.5 } } };
    rs[2] = { ...(rs[2] as EvalRunRecord), quota: { claude: { state: "exhausted" } } };
    const md = renderMarkdown(buildReport(m, rs, THRESHOLDS, { incomplete: null, now: NOW }));
    expect(md).toContain("claude quota: known in 2, exhausted in 1");
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

      ## Quota

      - claude-code (small) claude quota: unknown in 5 of 5 runs
      - pi-bridge (small) claude quota: unknown in 6 of 6 runs

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
    const line = md.split("\n").find((l) => l.startsWith("| claude-code |")) ?? "";
    const cells = line.slice(2, -2).split(" | ");
    const col = (name: string): string | undefined => cells[["Contender", "Runs", "Pass rate", "SD", "Escaped defects", "Usage claude", "Usage codex", "Wall median", "Errors", "Gates hit", "Notes"].indexOf(name)];
    expect(col("Runs")).toBe("0");
    for (const name of ["Pass rate", "SD", "Escaped defects", "Usage claude", "Usage codex", "Wall median", "Gates hit"]) expect(col(name), name).toBe("n/a");
    expect(col("Errors")).toBe("0 / 0");
  });
});
