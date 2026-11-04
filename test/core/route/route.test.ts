import { describe, expect, it } from "vitest";
import {
  INITIAL_ROUTE,
  ROUTING_RULE_SECTION,
  routeReducer,
  routeReminder,
  validateSetRoute,
} from "../../../src/core/route/route.ts";

const ROOT = "/w/proj";
const WT_OK = { exists: true, sameRepo: true, branch: "factory/t1" };

describe("INITIAL_ROUTE", () => {
  it("is the answer route with no roots", () => {
    expect(INITIAL_ROUTE).toEqual({ route: "answer", writeRoots: [], needsReclassification: false });
  });
});

describe("validateSetRoute", () => {
  it("accepts small with the project root and optional task id", () => {
    const r = validateSetRoute({ route: "small", reason: "typo" }, { projectRoot: ROOT });
    expect(r).toEqual({
      ok: true,
      state: { route: "small", tier: "small", reason: "typo", writeRoots: [ROOT], needsReclassification: false },
    });
    const withId = validateSetRoute({ route: "small", taskId: "fix-1", reason: "x" }, { projectRoot: ROOT });
    expect(withId.ok && withId.state.taskId).toBe("fix-1");
  });

  it("accepts feature with a valid worktree", () => {
    const r = validateSetRoute(
      { route: "feature", taskId: "t1", reason: "new", worktree: "/w/wt" },
      { projectRoot: ROOT, worktreeOk: WT_OK },
    );
    expect(r).toEqual({
      ok: true,
      state: {
        route: "feature",
        tier: "feature",
        taskId: "t1",
        reason: "new",
        worktree: "/w/wt",
        writeRoots: ["/w/wt"],
        needsReclassification: false,
      },
    });
  });

  it("accepts project like feature", () => {
    const r = validateSetRoute(
      { route: "project", taskId: "t1", reason: "big", worktree: "/w/wt" },
      { projectRoot: ROOT, worktreeOk: WT_OK },
    );
    expect(r.ok && r.state.route).toBe("project");
  });

  it("answer clears roots, task and worktree", () => {
    const r = validateSetRoute(
      { route: "answer", taskId: "t1", reason: "just asking", worktree: "/w/wt" },
      { projectRoot: ROOT },
    );
    expect(r).toEqual({
      ok: true,
      state: { route: "answer", reason: "just asking", writeRoots: [], needsReclassification: false },
    });
  });

  it("rejects feature without a worktree argument or facts", () => {
    expect(validateSetRoute({ route: "feature", taskId: "t1", reason: "r" }, { projectRoot: ROOT }).ok).toBe(false);
    expect(
      validateSetRoute({ route: "feature", taskId: "t1", reason: "r", worktree: "/w/wt" }, { projectRoot: ROOT }).ok,
    ).toBe(false);
  });

  it("rejects a missing worktree, another repository and another branch", () => {
    const req = { route: "feature" as const, taskId: "t1", reason: "r", worktree: "/w/wt" };
    for (const worktreeOk of [
      { exists: false, sameRepo: false },
      { exists: true, sameRepo: false, branch: "factory/t1" },
      { exists: true, sameRepo: true, branch: "main" },
      { exists: true, sameRepo: true },
    ]) {
      const r = validateSetRoute(req, { projectRoot: ROOT, worktreeOk });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects bad task ids", () => {
    for (const taskId of [undefined, "", "-a", "A", "a_b", "a/b", "..", "x".repeat(65)]) {
      const r = validateSetRoute(
        { route: "feature", taskId, reason: "r", worktree: "/w/wt" },
        { projectRoot: ROOT, worktreeOk: WT_OK },
      );
      expect(r.ok).toBe(false);
    }
    expect(validateSetRoute({ route: "small", taskId: "Bad Id", reason: "r" }, { projectRoot: ROOT }).ok).toBe(false);
  });

  it("rejects unknown route values", () => {
    for (const route of ["admin", "", "Feature"]) {
      const r = validateSetRoute(
        { route: route as never, taskId: "t1", reason: "r", worktree: "/w/wt" },
        { projectRoot: ROOT, worktreeOk: WT_OK },
      );
      expect(r.ok).toBe(false);
    }
  });

  it("rejects a relative worktree and accepts POSIX or win32 absolute ones", () => {
    const mk = (worktree: string) =>
      validateSetRoute({ route: "feature", taskId: "t1", reason: "r", worktree }, { projectRoot: ROOT, worktreeOk: WT_OK });
    for (const w of ["wt", "../wt", "./wt", "C:wt"]) expect(mk(w).ok).toBe(false);
    for (const w of ["/w/wt", "C:\\w\\wt", "C:/w/wt", "\\\\srv\\share\\wt"]) expect(mk(w).ok).toBe(true);
  });

  it("small ignores an extra worktree and leaves base/declaredForInput unset", () => {
    const r = validateSetRoute({ route: "small", reason: "r", worktree: "/w/wt" }, { projectRoot: ROOT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.worktree).toBeUndefined();
      expect(r.state.writeRoots).toEqual([ROOT]);
      expect("base" in r.state).toBe(false);
      expect("declaredForInput" in r.state).toBe(false);
    }
  });

  it("requires a reason", () => {
    expect(validateSetRoute({ route: "small", reason: "  " }, { projectRoot: ROOT }).ok).toBe(false);
  });
});

describe("routeReducer", () => {
  const feature = {
    route: "feature" as const,
    tier: "feature" as const,
    taskId: "t1",
    worktree: "/w/wt",
    writeRoots: ["/w/wt"],
    needsReclassification: false,
  };

  it("does not flag the first user message of an agent run", () => {
    expect(routeReducer(feature, { type: "user_message_consumed", index: 0 }).needsReclassification).toBe(false);
  });

  it("flags a further user message within the run", () => {
    expect(routeReducer(feature, { type: "user_message_consumed", index: 1 }).needsReclassification).toBe(true);
  });

  it("set_route replaces the state and clears the flag", () => {
    const flagged = { ...feature, needsReclassification: true };
    const next = routeReducer(flagged, { type: "set_route", state: INITIAL_ROUTE });
    expect(next).toEqual(INITIAL_ROUTE);
  });

  it("agent_settled keeps the flag", () => {
    const flagged = { ...feature, needsReclassification: true };
    expect(routeReducer(flagged, { type: "agent_settled" }).needsReclassification).toBe(true);
    expect(routeReducer(feature, { type: "agent_settled" })).toEqual(feature);
  });

  it("restored_after_interruption restores with the flag set", () => {
    const next = routeReducer(INITIAL_ROUTE, { type: "restored_after_interruption", state: feature });
    expect(next).toEqual({ ...feature, needsReclassification: true });
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(feature);
    routeReducer(feature, { type: "user_message_consumed", index: 2 });
    expect(feature).toEqual(copy);
  });
});

describe("routeReminder and ROUTING_RULE_SECTION", () => {
  it("renders one line per state", () => {
    for (const s of [
      INITIAL_ROUTE,
      { ...INITIAL_ROUTE, route: "small" as const, writeRoots: [ROOT], taskId: "small-1" },
      { ...INITIAL_ROUTE, route: "feature" as const, taskId: "t1", writeRoots: ["/w/wt"], needsReclassification: true },
    ]) {
      const line = routeReminder(s);
      expect(line).not.toContain("\n");
      expect(line).toContain(s.route);
    }
    expect(routeReminder({ ...INITIAL_ROUTE, route: "feature", taskId: "t1", needsReclassification: true })).toContain(
      "set_route",
    );
  });

  it("states the routing rule", () => {
    expect(ROUTING_RULE_SECTION).toContain("set_route");
    expect(ROUTING_RULE_SECTION).toMatch(/answer/);
    expect(ROUTING_RULE_SECTION).toMatch(/announce/i);
    // The example matches what set_route returns (`Route: <route> — <reason>`).
    expect(ROUTING_RULE_SECTION).toContain("Route: small — fix a typo");
  });
});
