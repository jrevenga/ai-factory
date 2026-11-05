// Eval report: aggregation, paired comparisons with verdicts, and deterministic Markdown (Phase 3 rulings 14, 19, 21, 23).
import { z } from "zod";
import { ContenderId, PROVIDER_IDS, type ProviderId, referenceContender } from "./contenders.ts";
import { EvalRunManifest, type EvalRunRecord } from "./records.ts";
import { Comparison, ContenderSummary, aggregate, pairedComparison, verdict } from "./stats.ts";
import type { EvalThresholds } from "./thresholds.ts";

const VerdictSchema = z.strictObject({
  branch: z.enum(["pass-rate", "usage"]).nullable(),
  improved: z.boolean(),
  regressions: z.array(z.string()),
  eligible: z.boolean(),
  note: z.string(),
});

export const ReportComparison = Comparison.extend({
  verdict: VerdictSchema,
  /** The confirming held-out run whose verdict for the same pair is `improved` (ruling 23). */
  confirmedBy: z.string().nullable(),
});
export type ReportComparison = z.infer<typeof ReportComparison>;

export const EvalReport = z.strictObject({
  v: z.literal(1),
  manifest: EvalRunManifest,
  incomplete: z.strictObject({ reason: z.string() }).nullable(),
  summaries: z.array(ContenderSummary),
  comparisons: z.array(ReportComparison),
  perTask: z.array(
    z.strictObject({
      taskId: z.string(),
      contender: ContenderId,
      runs: z.int().min(0),
      passes: z.int().min(0),
      gatesHit: z.int().min(0),
    }),
  ),
  generatedAt: z.string(),
});
export type EvalReport = z.infer<typeof EvalReport>;

export type ReportOptions = {
  incomplete: { reason: string } | null;
  now: Date;
  confirming?: { manifest: EvalRunManifest; records: EvalRunRecord[] }[];
};

const allPrivate = (m: EvalRunManifest): boolean => m.tasks.every((t) => t.exposure === "private");

export function buildReport(
  manifest: EvalRunManifest,
  records: EvalRunRecord[],
  thresholds: EvalThresholds,
  opts: ReportOptions,
): EvalReport {
  const summaries = aggregate(records, manifest);
  const confirming = opts.confirming ?? [];
  const comparisons: ReportComparison[] = [];
  if (manifest.profile !== null) {
    const reference = referenceContender(manifest.profile);
    if (manifest.contenders.some((c) => c.id === reference)) {
      for (const { id: candidate } of manifest.contenders) {
        if (candidate === reference) continue;
        const c = pairedComparison(records, candidate, reference, manifest.seed);
        // Held-out clause ignored: only the confirming run's own `improved` matters (ruling 23).
        const confirmations = confirming.map((conf) => {
          const cc = pairedComparison(conf.records, candidate, reference, conf.manifest.seed);
          const v = verdict(cc, thresholds, {
            suite: conf.manifest.suite,
            complete: true,
            manifestTaskIds: conf.manifest.tasks.map((t) => t.id),
            allPrivate: true,
            heldoutConfirmed: true,
          });
          return { conf, improved: v.improved };
        });
        const confirmed = confirmations.find((x) => x.improved);
        const privateOnly = allPrivate(manifest) && (confirmed ? allPrivate(confirmed.conf.manifest) : confirming.every((x) => allPrivate(x.manifest)));
        const v = verdict(c, thresholds, {
          suite: manifest.suite,
          complete: opts.incomplete === null,
          manifestTaskIds: manifest.tasks.map((t) => t.id),
          allPrivate: privateOnly,
          heldoutConfirmed: confirmed !== undefined,
        });
        comparisons.push({ ...c, verdict: v, confirmedBy: confirmed?.conf.manifest.evalRunId ?? null });
      }
    }
  }
  const perTask: EvalReport["perTask"] = [];
  for (const t of manifest.tasks) {
    for (const { id: contender } of manifest.contenders) {
      const rs = records.filter((r) => r.taskId === t.id && r.contender === contender && r.exit !== "skipped-budget");
      if (rs.length === 0) continue;
      perTask.push({
        taskId: t.id,
        contender,
        runs: rs.length,
        passes: rs.filter((r) => r.pass).length,
        gatesHit: rs.reduce((a, r) => a + r.gatesHit, 0),
      });
    }
  }
  return { v: 1, manifest, incomplete: opts.incomplete, summaries, comparisons, perTask, generatedAt: opts.now.toISOString() };
}

const NA = "n/a";
const num = (x: number | null, dp = 2): string => (x === null ? NA : x.toFixed(dp));
const pct = (x: number | null): string => (x === null ? NA : `${(x * 100).toFixed(1)}%`);
const row = (cells: string[]): string => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: string[][]): string[] => [row(head), row(head.map(() => "---")), ...rows.map(row)];
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

function usageCell(s: ContenderSummary, p: ProviderId): string {
  const u = s.usage[p];
  return u ? `${Math.round(u.median)} (IQR ${Math.round(u.iqr[0])}-${Math.round(u.iqr[1])}, n=${u.n})` : NA;
}
function ratioCell(rec: Partial<Record<ProviderId, number>>): string {
  const parts = PROVIDER_IDS.filter((p) => rec[p] !== undefined).map((p) => `${p} ${(rec[p] as number).toFixed(2)}`);
  return parts.length === 0 ? NA : parts.join(", ");
}

export function renderMarkdown(r: EvalReport): string {
  const m = r.manifest;
  const L: string[] = [`# Eval report ${m.evalRunId}`, ""];
  const publicTasks = m.tasks.filter((t) => t.exposure === "public").length;
  if (publicTasks > 0) {
    L.push(
      `> **Exposure:** ${publicTasks} of ${m.tasks.length} tasks are public, so their checks are published in the repository and a contender with network access could have read them. Claims rely on private tasks only.`,
      "",
    );
  }
  if (m.suite === "smoke") L.push("> **Smoke suite:** regression alarm only — no superiority claim.", "");
  if (r.incomplete) L.push(`> **Incomplete run:** ${r.incomplete.reason}. Resume with \`factory eval run --resume ${m.evalRunId}\`.`, "");
  const pins = Object.entries(m.pins).map(([k, v]) => `${k} ${v}`);
  L.push(
    `- Suite: ${m.suite}; profile: ${m.profile ?? NA}; reps: ${m.reps}; seed: ${m.seed}`,
    `- Factory: ${m.factory.version}${m.factory.commit ? ` (${m.factory.commit})` : ""}`,
    `- Host: ${m.host.platform}; bubblewrap ${m.host.bwrap ?? "not available"}`,
    `- Pins: ${pins.length > 0 ? pins.join(", ") : NA}`,
    `- Drift: ${m.drift.length > 0 ? m.drift.join("; ") : "none"}`,
    `- Generated: ${r.generatedAt}`,
    "",
  );

  const tiers = [...new Set(r.summaries.map((s) => s.tier))];
  for (const tier of tiers) {
    L.push(`## Tier: ${tier}`, "");
    const rows = r.summaries
      .filter((s) => s.tier === tier)
      .map((s) => [
        s.contender,
        String(s.runs),
        pct(s.passRate),
        s.passRateSd === null ? NA : `${(s.passRateSd * 100).toFixed(1)} pp`,
        num(s.escapedDefectsMean),
        ...PROVIDER_IDS.map((p) => usageCell(s, p)),
        s.wallMsMedian === null ? NA : `${(s.wallMsMedian / 1000).toFixed(1)} s`,
        `${s.errors} / ${s.timeouts}`,
        num(s.gatesHitMean),
        [
          s.usageMissing > 0 ? `usage missing in ${plural(s.usageMissing, "run")}` : "",
          s.skippedBudget > 0 ? `${s.skippedBudget} skipped (budget)` : "",
          s.leakSuspect ? "leak suspected" : "",
        ]
          .filter(Boolean)
          .join("; ") || "none",
      ]);
    L.push(
      ...table(
        ["Contender", "Runs", "Pass rate", "SD", "Escaped defects", ...PROVIDER_IDS.map((p) => `Usage ${p} (tokens)`), "Wall median", "Errors / timeouts", "Gates hit", "Notes"],
        rows,
      ),
      "",
    );
  }

  if (r.comparisons.length > 0) {
    L.push("## Comparisons against the reference", "");
    for (const c of r.comparisons) {
      L.push(
        `### ${c.candidate} vs ${c.reference}`,
        "",
        `- Tasks compared: ${c.tasks}; minimum runs per task: ${c.minRunsPerTask}`,
        `- Pass-rate difference: ${c.passRateDiffPp.toFixed(2)} pp (95% CI ${c.ci95[0].toFixed(2)} to ${c.ci95[1].toFixed(2)})`,
        `- Escaped-defects difference: ${c.escapedDefectsDiff.toFixed(2)}`,
        `- Usage ratio per provider: ${c.usageComplete ? ratioCell(c.usageRatio) : `${ratioCell(c.usageRatio)} (usage coverage incomplete)`}`,
        `- Extra usage (providers only the candidate used, median tokens per task): ${ratioCell(c.extraUsage)}`,
        `- Wall-time ratio: ${c.wallRatio.toFixed(2)}`,
        `- Verdict: ${c.verdict.improved ? `improved (${c.verdict.branch} branch)` : "not improved"}${c.verdict.regressions.length > 0 ? `; regressions: ${c.verdict.regressions.join(", ")}` : ""}`,
        `- Eligible for a claim: ${c.verdict.eligible ? "yes" : "no"} — ${c.verdict.note}`,
        `- Held-out confirmation: ${c.confirmedBy ?? "none"}`,
        "",
      );
    }
  }

  L.push("## Per task", "");
  L.push(...table(["Task", "Contender", "Runs", "Passes", "Gates hit"], r.perTask.map((t) => [t.taskId, t.contender, String(t.runs), String(t.passes), String(t.gatesHit)])), "");
  return L.join("\n");
}
