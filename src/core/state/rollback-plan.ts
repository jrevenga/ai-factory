// Which state documents a rollback keeps, restores from the transaction snapshot, or cannot handle
// (ruling 11): only a document whose schema is newer than the target release supports needs restoring.
import { STATE_DOCS } from "../release/manifest.ts";
import type { StateDoc } from "./schema.ts";

export interface RollbackPlanInput {
  current: Partial<Record<StateDoc, number>>;
  target: Record<StateDoc, number>;
  snapshotHas: Partial<Record<StateDoc, boolean>>;
}

export interface RollbackPlan {
  keep: StateDoc[];
  restore: StateDoc[];
  /** Newer than the target and not in the snapshot: the caller must abort before any mutation. */
  refuse: StateDoc[];
}

export function planRollback(input: RollbackPlanInput): RollbackPlan {
  const plan: RollbackPlan = { keep: [], restore: [], refuse: [] };
  for (const doc of STATE_DOCS) {
    const current = input.current[doc];
    if (current === undefined || current <= input.target[doc]) plan.keep.push(doc);
    else if (input.snapshotHas[doc] === true) plan.restore.push(doc);
    else plan.refuse.push(doc);
  }
  return plan;
}
