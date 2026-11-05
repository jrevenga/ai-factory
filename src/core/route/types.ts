// Route state types (Phase 2 Task 4 shape). Task 4 implements validation and the reducer against them;
// the gate (Task 3) only reads them.

export type Route = "answer" | "small" | "feature" | "project";

export interface RouteState {
  route: Route;
  tier?: Route;
  taskId?: string;
  reason?: string;
  worktree?: string;
  /** Absolute, realpathed roots the route may write into; empty on the answer route. */
  writeRoots: string[];
  /** Set by a further user message within an agent run or a restore after an interruption (ruling 20). */
  needsReclassification: boolean;
  /** `git rev-parse HEAD` of the write root when the task was declared (ruling 10). */
  base?: string;
  declaredForInput?: number;
}
