import type { Route, RouteState } from "./types.ts";

export type { Route, RouteState } from "./types.ts";

export const INITIAL_ROUTE: RouteState = { route: "answer", writeRoots: [], needsReclassification: false };

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SetRouteRequest {
  route: Route;
  taskId?: string;
  reason: string;
  worktree?: string;
}

export interface SetRouteFacts {
  projectRoot: string;
  worktreeOk?: { exists: boolean; sameRepo: boolean; branch?: string };
}

export type SetRouteResult = { ok: true; state: RouteState } | { ok: false; error: string };

export function validateSetRoute(req: SetRouteRequest, facts: SetRouteFacts): SetRouteResult {
  const reason = req.reason.trim();
  if (reason === "") return { ok: false, error: "set_route requires a non-empty reason" };

  if (req.route === "answer") {
    return { ok: true, state: { route: "answer", reason, writeRoots: [], needsReclassification: false } };
  }

  if (req.taskId !== undefined && !TASK_ID.test(req.taskId)) {
    return { ok: false, error: `taskId must match ${TASK_ID.source}` };
  }

  if (req.route === "small") {
    return {
      ok: true,
      state: {
        route: "small",
        tier: "small",
        ...(req.taskId !== undefined ? { taskId: req.taskId } : {}),
        reason,
        writeRoots: [facts.projectRoot],
        needsReclassification: false,
      },
    };
  }

  // feature / project
  if (req.taskId === undefined) return { ok: false, error: `the ${req.route} route requires a taskId` };
  if (req.worktree === undefined || req.worktree === "") {
    return { ok: false, error: `the ${req.route} route requires a worktree` };
  }
  const wt = facts.worktreeOk;
  if (wt === undefined || !wt.exists) return { ok: false, error: `worktree does not exist: ${req.worktree}` };
  if (!wt.sameRepo) return { ok: false, error: "worktree is not a worktree of this repository" };
  const expected = `factory/${req.taskId}`;
  if (wt.branch !== expected) {
    return { ok: false, error: `worktree must be on branch ${expected} (found ${wt.branch ?? "none"})` };
  }
  return {
    ok: true,
    state: {
      route: req.route,
      tier: req.route,
      taskId: req.taskId,
      reason,
      worktree: req.worktree,
      writeRoots: [req.worktree],
      needsReclassification: false,
    },
  };
}

export type RouteEvent =
  | { type: "set_route"; state: RouteState }
  | { type: "user_message_consumed"; index: number }
  | { type: "agent_settled" }
  | { type: "restored_after_interruption"; state: RouteState };

export function routeReducer(state: RouteState, event: RouteEvent): RouteState {
  switch (event.type) {
    case "set_route":
      return { ...event.state, needsReclassification: false };
    case "user_message_consumed":
      return event.index > 0 ? { ...state, needsReclassification: true } : state;
    case "agent_settled":
      return state;
    case "restored_after_interruption":
      return { ...event.state, needsReclassification: true };
  }
}

export function routeReminder(state: RouteState): string {
  const task = state.taskId !== undefined ? ` task ${state.taskId}` : "";
  const base = `Current route: ${state.route}${task}.`;
  if (state.needsReclassification) {
    return `${base} A new request arrived: call set_route to re-declare the route before modifying anything.`;
  }
  if (state.route === "answer") return `${base} Read-only; call set_route before modifying anything.`;
  return base;
}

export const ROUTING_RULE_SECTION = [
  "## Routing",
  "Declare the route with set_route before modifying anything: answer, small, feature or project.",
  "Until a route is declared, the route is answer (read-only); write and edit are denied.",
  "Announce the route in one line when you declare it, for example: Route: small (fix a typo).",
  "If a new user message changes the nature of the work, call set_route again.",
].join("\n");
