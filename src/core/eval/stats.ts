// Paired statistics and verdicts over eval run records (Phase 3 rulings 14, 19, 23; R73 for mixed-provider profiles).
import { z } from "zod";
import { ContenderId, PROVIDER_IDS, ProviderId } from "./contenders.ts";
import { mulberry32 } from "./matrix.ts";
import type { EvalRunManifest, EvalRunRecord, Usage } from "./records.ts";
import { TASK_TIERS } from "./task.ts";
import type { EvalThresholds } from "./thresholds.ts";

const BOOTSTRAP_RESAMPLES = 2000;
const MIN_RUNS_PER_TASK = 5;

const UsageStat = z.strictObject({ median: z.number(), iqr: z.tuple([z.number(), z.number()]), n: z.int().min(0) });

export const ContenderSummary = z.strictObject({
  contender: ContenderId,
  tier: z.enum(TASK_TIERS),
  /** Counted runs: every run except `skipped-budget`. */
  runs: z.int().min(0),
  passRate: z.number().nullable(),
  passRateSd: z.number().nullable(),
  escapedDefectsMean: z.number().nullable(),
  usage: z.partialRecord(ProviderId, UsageStat),
  usageMissing: z.int().min(0),
  wallMsMedian: z.number().nullable(),
  errors: z.int().min(0),
  timeouts: z.int().min(0),
  gatesHitMean: z.number().nullable(),
  leakSuspect: z.boolean(),
  skippedBudget: z.int().min(0),
  /** Per provider, counted runs by quota state; a run with usage but no quota entry counts as unknown (R76). */
  quota: z.partialRecord(ProviderId, z.strictObject({ known: z.int().min(0), unknown: z.int().min(0), exhausted: z.int().min(0) })),
});
export type ContenderSummary = z.infer<typeof ContenderSummary>;

export const Comparison = z.strictObject({
  candidate: ContenderId,
  reference: ContenderId,
  tasks: z.int().min(0),
  minRunsPerTask: z.int().min(0),
  usageComplete: z.boolean(),
  passRateDiffPp: z.number(),
  ci95: z.tuple([z.number(), z.number()]),
  escapedDefectsDiff: z.number(),
  /** Defined only for providers the reference used (R73). */
  usageRatio: z.partialRecord(ProviderId, z.number()),
  /** Providers only the candidate used: median per-task absolute usage (R73). */
  extraUsage: z.partialRecord(ProviderId, z.number()),
  /** Null when no task has a positive reference wall time to compare against (R75). */
  wallRatio: z.number().nullable(),
});
export type Comparison = z.infer<typeof Comparison>;

export type VerdictContext = {
  suite: string;
  complete: boolean;
  manifestTaskIds: string[];
  allPrivate: boolean;
  heldoutConfirmed: boolean;
};
export type Verdict = {
  branch: "pass-rate" | "usage" | null;
  improved: boolean;
  regressions: string[];
  eligible: boolean;
  note: string;
};

const counted = (r: EvalRunRecord): boolean => r.exit !== "skipped-budget";
const total = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);

/** Quantile with linear interpolation between order statistics (R type 7). `xs` must be non-empty. */
export function quantile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return (s[lo] as number) + (h - lo) * ((s[hi] as number) - (s[lo] as number));
}
const median = (xs: readonly number[]): number => quantile(xs, 0.5);

function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export function aggregate(records: EvalRunRecord[], manifest: EvalRunManifest): ContenderSummary[] {
  const tierOf = new Map(manifest.tasks.map((t) => [t.id, t.tier] as const));
  const out: ContenderSummary[] = [];
  for (const tier of TASK_TIERS) {
    for (const { id: contender } of manifest.contenders) {
      const all = records.filter((r) => r.contender === contender && tierOf.get(r.taskId) === tier);
      if (all.length === 0) continue;
      const runs = all.filter(counted);
      const byRep = new Map<number, EvalRunRecord[]>();
      for (const r of runs) byRep.set(r.rep, [...(byRep.get(r.rep) ?? []), r]);
      const repRates = [...byRep.values()].map((rs) => rs.filter((r) => r.pass).length / rs.length);
      const usage: ContenderSummary["usage"] = {};
      for (const p of PROVIDER_IDS) {
        const totals = runs.filter((r) => !r.usageMissing && r.usage[p]).map((r) => total(r.usage[p] as Usage));
        if (totals.length > 0) usage[p] = { median: median(totals), iqr: [quantile(totals, 0.25), quantile(totals, 0.75)], n: totals.length };
      }
      const quota: ContenderSummary["quota"] = {};
      for (const p of PROVIDER_IDS) {
        const q = { known: 0, unknown: 0, exhausted: 0 };
        let any = false;
        for (const r of runs) {
          const st = r.quota[p];
          if (st) {
            q[st.state]++;
            any = true;
          } else if (r.usage[p]) {
            q.unknown++;
            any = true;
          }
        }
        if (any) quota[p] = q;
      }
      const has = runs.length > 0;
      out.push({
        contender,
        tier,
        runs: runs.length,
        passRate: has ? runs.filter((r) => r.pass).length / runs.length : null,
        passRateSd: has ? sampleSd(repRates) : null,
        escapedDefectsMean: has ? mean(runs.map((r) => r.escapedDefects)) : null,
        usage,
        usageMissing: runs.filter((r) => r.usageMissing).length,
        wallMsMedian: has ? median(runs.map((r) => r.wallMs)) : null,
        errors: runs.filter((r) => r.exit === "error").length,
        timeouts: runs.filter((r) => r.exit === "timeout").length,
        gatesHitMean: has ? mean(runs.map((r) => r.gatesHit)) : null,
        leakSuspect: runs.some((r) => r.leakSuspect),
        skippedBudget: all.length - runs.length,
        quota,
      });
    }
  }
  return out;
}

type TaskStats = {
  runs: EvalRunRecord[];
  passRate: number;
  escaped: number;
  wall: number;
  /** Mean per-run total over non-usageMissing runs that have the provider; undefined when there are none. */
  usage: Partial<Record<ProviderId, number>>;
};

function taskStats(runs: EvalRunRecord[]): TaskStats {
  const usage: TaskStats["usage"] = {};
  for (const p of PROVIDER_IDS) {
    const totals = runs.filter((r) => !r.usageMissing && r.usage[p]).map((r) => total(r.usage[p] as Usage));
    if (totals.length > 0) usage[p] = mean(totals);
  }
  return {
    runs,
    passRate: runs.filter((r) => r.pass).length / runs.length,
    escaped: mean(runs.map((r) => r.escapedDefects)),
    wall: mean(runs.map((r) => r.wallMs)),
    usage,
  };
}

export function pairedComparison(
  records: EvalRunRecord[],
  candidate: ContenderId,
  reference: ContenderId,
  seed: number,
): Comparison {
  const group = (c: ContenderId): Map<string, EvalRunRecord[]> => {
    const m = new Map<string, EvalRunRecord[]>();
    for (const r of records) if (r.contender === c && counted(r)) m.set(r.taskId, [...(m.get(r.taskId) ?? []), r]);
    return m;
  };
  const cg = group(candidate);
  const rg = group(reference);
  const taskIds = [...cg.keys()].filter((id) => rg.has(id)).sort();
  const pairs = taskIds.map((id) => ({
    c: taskStats(cg.get(id) as EvalRunRecord[]),
    r: taskStats(rg.get(id) as EvalRunRecord[]),
  }));
  const n = pairs.length;

  const diffs = pairs.map((p) => p.c.passRate - p.r.passRate);
  const rng = mulberry32(seed);
  const boots: number[] = [];
  if (n > 0) {
    for (let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += diffs[Math.floor(rng() * n)] as number;
      boots.push((s / n) * 100);
    }
  }

  const refProviders = PROVIDER_IDS.filter((p) => pairs.some((x) => x.r.runs.some((r) => !r.usageMissing && r.usage[p])));
  const candProviders = PROVIDER_IDS.filter(
    (p) => !refProviders.includes(p) && pairs.some((x) => x.c.runs.some((r) => !r.usageMissing && r.usage[p])),
  );
  const anyMissing = pairs.some((x) => x.c.runs.some((r) => r.usageMissing) || x.r.runs.some((r) => r.usageMissing));
  let ratiosDefined = true;
  const usageRatio: Comparison["usageRatio"] = {};
  for (const p of refProviders) {
    const ratios: number[] = [];
    for (const x of pairs) {
      const ref = x.r.usage[p];
      if (ref === undefined || ref <= 0) {
        ratiosDefined = false;
        continue;
      }
      ratios.push((x.c.usage[p] ?? 0) / ref);
    }
    if (ratios.length > 0) usageRatio[p] = median(ratios);
  }
  const extraUsage: Comparison["extraUsage"] = {};
  for (const p of candProviders) extraUsage[p] = median(pairs.map((x) => x.c.usage[p] ?? 0));

  const wallMeasurable = n > 0 && pairs.every((x) => x.r.wall > 0);
  return {
    candidate,
    reference,
    tasks: n,
    minRunsPerTask: n === 0 ? 0 : Math.min(...pairs.map((x) => Math.min(x.c.runs.length, x.r.runs.length))),
    usageComplete: n > 0 && !anyMissing && ratiosDefined,
    passRateDiffPp: n === 0 ? 0 : mean(diffs) * 100,
    ci95: n === 0 ? [0, 0] : [quantile(boots, 0.025), quantile(boots, 0.975)],
    escapedDefectsDiff: n === 0 ? 0 : mean(pairs.map((x) => x.c.escaped - x.r.escaped)),
    usageRatio,
    extraUsage,
    wallRatio: wallMeasurable ? median(pairs.map((x) => x.c.wall / x.r.wall)) : null,
  };
}

const SMOKE_NOTE = "regression alarm only — no superiority claim";

export function verdict(c: Comparison, t: EvalThresholds, ctx: VerdictContext): Verdict {
  const wallCut = (100 + t.secondary.wallTimeIncreasePct) / 100;
  const usageUpCut = (100 + t.secondary.usageIncreasePct) / 100;
  const usageDownCut = (100 - t.usageReductionPct) / 100;
  const ratios = Object.values(c.usageRatio);

  const common: string[] = [];
  if (c.escapedDefectsDiff > t.secondary.escapedDefectsIncrease) common.push("escapedDefectsIncrease");
  if (c.wallRatio === null || c.wallRatio > wallCut) common.push("wallTimeIncreasePct");

  const prRegressions = ratios.some((r) => r > usageUpCut) ? [...common, "usageIncreasePct"] : common;
  const prImproved = c.passRateDiffPp > t.passRatePp && prRegressions.length === 0;
  const usageImproved =
    !prImproved &&
    c.passRateDiffPp >= 0 &&
    c.usageComplete &&
    Object.keys(c.extraUsage).length === 0 &&
    ratios.length > 0 &&
    ratios.every((r) => r <= usageDownCut) &&
    common.length === 0;

  const branch = prImproved ? "pass-rate" : usageImproved ? "usage" : null;
  const improved = branch !== null;
  const regressions = improved ? [] : prRegressions;

  let note: string;
  if (ctx.suite === "smoke") note = SMOKE_NOTE;
  else if (ctx.suite !== "full") note = `not eligible: suite is ${ctx.suite}, only full runs support a claim`;
  else if (!ctx.complete) note = "not eligible: the run is incomplete";
  else if (c.tasks !== ctx.manifestTaskIds.length) note = `not eligible: ${c.tasks} of ${ctx.manifestTaskIds.length} tasks have counted runs for both contenders`;
  else if (c.minRunsPerTask < MIN_RUNS_PER_TASK) note = `not eligible: a task has only ${c.minRunsPerTask} counted runs (need ${MIN_RUNS_PER_TASK})`;
  else if (!c.usageComplete) note = "not eligible: usage coverage is incomplete";
  else if (!ctx.allPrivate) note = "not eligible: claims rely on private tasks only";
  else if (!ctx.heldoutConfirmed) note = "not eligible: no held-out confirmation";
  else if (!improved) note = "not eligible: no improvement over the reference";
  else note = "eligible";

  return { branch, improved, regressions, eligible: note === "eligible", note };
}
