// Soft-gate skipping by autonomy level (Phase 2 ruling 13, A §8.3). Hard gates never go through here.
import { SOFT_GATES, type AUTONOMY_LEVELS, type SoftGateId } from "../config/schema.ts";

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const KNOWN_SOFT_GATES: ReadonlySet<string> = new Set(SOFT_GATES);

/**
 * `low` → no soft gate may be skipped; `medium` → only gates in the effective `gates.soften`;
 * `high` → any soft gate. Unknown levels or gate ids fail closed (false).
 */
export function autonomyAllowsSkip(gate: SoftGateId, autonomy: AutonomyLevel, softened: readonly SoftGateId[]): boolean {
  if (!KNOWN_SOFT_GATES.has(gate)) return false;
  switch (autonomy) {
    case "high":
      return true;
    case "medium":
      return softened.includes(gate);
    default:
      return false;
  }
}
