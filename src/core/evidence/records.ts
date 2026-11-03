// Evidence records and the pure delivery validation (M §7.0, §11, §14 row 6). Persisted documents are
// loose objects (Phase 1 ruling 11).
import { z } from "zod";
import type { Route } from "../route/types.ts";

export const CheckRecord = z.looseObject({
  id: z.string(),
  command: z.string(),
  exitCode: z.number(),
  cwd: z.string(),
  /** Fingerprint taken before the command ran. */
  fingerprint: z.string(),
  fingerprintAfter: z.string(),
  mutated: z.boolean(),
  durationMs: z.number(),
  logPath: z.string(),
  at: z.string(),
});
export type CheckRecord = z.infer<typeof CheckRecord>;

export const REVIEW_DISPOSITIONS = ["approved", "approved_with_rulings", "escalated"] as const;
export const ReviewDisposition = z.looseObject({
  taskId: z.string(),
  fingerprint: z.string(),
  disposition: z.union([z.enum(REVIEW_DISPOSITIONS), z.string()]),
  reviewer: z.string(),
  findingsSummary: z.string(),
  at: z.string(),
});
export type ReviewDisposition = Omit<z.infer<typeof ReviewDisposition>, "disposition"> & {
  disposition: (typeof REVIEW_DISPOSITIONS)[number];
};

/** The persisted `disposition` is an open string (R13); use this guard before narrowing. */
export function isKnownDisposition(d: string): d is ReviewDisposition["disposition"] {
  return (REVIEW_DISPOSITIONS as readonly string[]).includes(d);
}

export interface DeliveryInput {
  taskId: string;
  tier: Route;
  fingerprint: string;
  checks: CheckRecord[];
  dispositions: ReviewDisposition[];
  requiredCheckIds: string[];
}

export function validateDelivery(input: DeliveryInput): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const gated = input.tier === "feature" || input.tier === "project";
  if (gated && input.requiredCheckIds.length === 0) reasons.push("no required checks were declared");
  for (const id of input.requiredCheckIds) {
    const matches = input.checks.filter((c) => c.id === id);
    const rec = matches[matches.length - 1];
    if (!rec) {
      reasons.push(`required check ${id} has no record`);
    } else if (rec.exitCode !== 0) {
      reasons.push(`check ${id} exited with ${rec.exitCode}`);
    } else if (rec.mutated) {
      reasons.push(`check ${id} mutated the working tree`);
    } else if (rec.fingerprint !== input.fingerprint || rec.fingerprintAfter !== input.fingerprint) {
      reasons.push(`check ${id} ran against a different fingerprint than the current tree`);
    }
  }
  if (gated) {
    const mine = input.dispositions.filter((d) => d.taskId === input.taskId && d.fingerprint === input.fingerprint);
    const last = mine[mine.length - 1];
    if (!last || (last.disposition !== "approved" && last.disposition !== "approved_with_rulings")) {
      reasons.push("no approved review disposition for this task at the current fingerprint");
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
