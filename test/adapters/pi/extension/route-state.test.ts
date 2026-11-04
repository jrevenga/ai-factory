import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { currentRoute, setRoute } from "../../../../src/adapters/pi/extension/enforce.ts";
import {
  announce,
  declareRoute,
  protectedRootError,
  registerRouteState,
  restoreRoute,
  ROUTE_ENTRY,
  ROUTING_SECTION_KEY,
  type RouteFacts,
  type RouteIo,
  type RouteSession,
} from "../../../../src/adapters/pi/extension/route-state.ts";
import { RunEvent } from "../../../../src/core/ledger/events.ts";
import { INITIAL_ROUTE, ROUTING_RULE_SECTION } from "../../../../src/core/route/route.ts";
import type { RouteState } from "../../../../src/core/route/types.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const isWin = process.platform === "win32";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRoute(INITIAL_ROUTE);
  for (const c of cleanups.splice(0)) await c();
});

// The code under test inherits the process env: keep the developer's git config out of it.
beforeAll(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", isWin ? "NUL" : "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A fake home with the project inside it, Pi and factory state beside it; every path realpathed. */
async function world(opts: { git?: boolean } = {}) {
  const t = await makeTmp("route-state");
  cleanups.push(t.cleanup);
  const dir = realpathSync.native(t.dir);
  const home = join(dir, "home");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  if (opts.git) repo(project);
  const facts: RouteFacts = {
    projectRoot: project,
    home,
    piAgentDir: join(dir, "pi agent"),
    factoryHome: join(dir, "factory home"),
    gitDirs: opts.git ? [join(project, ".git")] : [],
  };
  return { dir, home, project, facts };
}

const fakeIo = (over: Partial<RouteIo> = {}): RouteIo => ({
  canonicalDir: (p) => p,
  worktreeFacts: () => ({ exists: false, sameRepo: false }),
  head: () => HEAD,
  baseOk: () => true,
  ...over,
});

const custom = (customType: string, data: unknown) => ({ type: "custom", id: Math.random().toString(16).slice(2), parentId: null, timestamp: "", customType, data });
const small = (root: string, over: Partial<RouteState> = {}): RouteState => ({
  route: "small",
  tier: "small",
  reason: "fix a typo",
  writeRoots: [root],
  needsReclassification: false,
  base: HEAD,
  ...over,
});

describe("declareRoute (set_route with live facts)", () => {
  it("small: the project root is the write root and base is HEAD of that root", async () => {
    const w = await world({ git: true });
    const r = declareRoute({ route: "small", reason: "fix a typo" }, w.facts);
    expect(r).toEqual({ ok: true, state: { ...small(w.project), base: git(w.project, "rev-parse", "HEAD") } });
  });

  it("small outside a repository (or before the first commit) leaves base unset", async () => {
    const w = await world();
    const r = declareRoute({ route: "small", reason: "notes" }, w.facts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).not.toHaveProperty("base");
  });

  it("answer clears the write roots", async () => {
    const w = await world();
    expect(declareRoute({ route: "answer", reason: "question" }, w.facts, fakeIo())).toEqual({
      ok: true,
      state: { route: "answer", reason: "question", writeRoots: [], needsReclassification: false },
    });
  });

  it("feature: the worktree is realpathed, validated with git facts and becomes the write root", async () => {
    const w = await world({ git: true });
    const wt = join(w.dir, "wt");
    git(w.project, "worktree", "add", "-q", "-b", "factory/t1", wt);
    const link = join(w.dir, "wt-link");
    symlinkSync(wt, link, isWin ? "junction" : "dir");
    const r = declareRoute({ route: "feature", taskId: "t1", reason: "add search", worktree: link }, w.facts);
    expect(r).toEqual({
      ok: true,
      state: {
        route: "feature",
        tier: "feature",
        taskId: "t1",
        reason: "add search",
        worktree: wt,
        writeRoots: [wt],
        needsReclassification: false,
        base: git(wt, "rev-parse", "HEAD"),
      },
    });
  });

  it("feature: a worktree on another branch, of another repository or missing is refused", async () => {
    const w = await world({ git: true });
    const wt = join(w.dir, "wt");
    git(w.project, "worktree", "add", "-q", "-b", "other", wt);
    expect(declareRoute({ route: "feature", taskId: "t1", reason: "x", worktree: wt }, w.facts)).toEqual({
      ok: false,
      error: "worktree must be on branch factory/t1 (found other)",
    });
    const foreign = repo(join(w.dir, "foreign"));
    expect(declareRoute({ route: "feature", taskId: "t1", reason: "x", worktree: foreign }, w.facts)).toMatchObject({ ok: false, error: expect.stringContaining("not a worktree of this repository") });
    const missing = join(w.dir, "missing");
    expect(declareRoute({ route: "project", taskId: "t1", reason: "x", worktree: missing }, w.facts)).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
    expect(declareRoute({ route: "feature", taskId: "t1", reason: "x", worktree: "relative/wt" }, w.facts)).toEqual({ ok: false, error: "worktree must be an absolute path" });
  });

  it("an invalid request reports the validation error", async () => {
    const w = await world();
    expect(declareRoute({ route: "small", reason: "  " }, w.facts, fakeIo())).toEqual({ ok: false, error: "set_route requires a non-empty reason" });
    expect(declareRoute({ route: "small", taskId: "Bad Id", reason: "x" }, w.facts, fakeIo()).ok).toBe(false);
  });

  it("M6: refuses a write root that is home, contains home, or overlaps Pi/factory state or a git dir", async () => {
    const w = await world();
    const f = w.facts;
    const at = (projectRoot: string) => declareRoute({ route: "small", reason: "x" }, { ...f, projectRoot }, fakeIo());
    for (const root of [f.home, w.dir, join(f.factoryHome, "runs"), f.piAgentDir, join(f.piAgentDir, "sessions")]) {
      const r = at(root);
      expect(r.ok, root).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^refusing write root /);
    }
    expect(protectedRootError(join(w.project, ".git", "hooks"), { ...f, gitDirs: [join(w.project, ".git")] })).toMatch(/git dir/);
    expect(protectedRootError(w.project, f)).toBeUndefined();
    // A feature worktree gets the same check.
    const io = fakeIo({ worktreeFacts: () => ({ exists: true, sameRepo: true, branch: "factory/t1" }) });
    const r = declareRoute({ route: "feature", taskId: "t1", reason: "x", worktree: f.home }, f, io);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^refusing write root /) });
  });
});

describe("restoreRoute (session entries)", () => {
  it("restores the last factory-route entry of the branch", async () => {
    const w = await world();
    const entries = [
      custom(ROUTE_ENTRY, { route: "answer", writeRoots: [], needsReclassification: false }),
      { type: "message", id: "m", parentId: null, timestamp: "", message: { role: "user", content: "hi", timestamp: 0 } },
      custom(ROUTE_ENTRY, small(w.project)),
      custom("other-extension", { route: "project" }),
    ];
    const r = restoreRoute(entries, w.facts, { interrupted: false }, fakeIo());
    expect(r).toEqual({ state: small(w.project), restored: true });
  });

  it("without an entry the route is the initial answer route", async () => {
    const w = await world();
    expect(restoreRoute([], w.facts, { interrupted: false }, fakeIo())).toEqual({ state: INITIAL_ROUTE, restored: false });
  });

  it("restores only when the live write roots equal the stored ones, and keeps the stored base then", async () => {
    const w = await world();
    const stored = small(w.project, { base: "feedface".repeat(5) });
    expect(restoreRoute([custom(ROUTE_ENTRY, stored)], w.facts, { interrupted: false }, fakeIo()).state).toEqual(stored);
    // A spoofed root grants nothing: the route is answer and the notice names both roots.
    const spoofed = restoreRoute([custom(ROUTE_ENTRY, small(w.project, { writeRoots: ["/"] }))], w.facts, { interrupted: false }, fakeIo());
    expect(spoofed.state).toEqual(INITIAL_ROUTE);
    expect(spoofed.restored).toBe(false);
    expect(spoofed.notice).toContain(`declared for / , not ${w.project}`.replace(" ,", ","));
  });

  it("N1: a stored base that is not a commit ancestor of HEAD is recomputed from HEAD with a notice", async () => {
    const w = await world({ git: true });
    const head = git(w.project, "rev-parse", "HEAD");
    const kept = restoreRoute([custom(ROUTE_ENTRY, small(w.project, { base: head }))], w.facts, { interrupted: false });
    expect(kept).toEqual({ state: small(w.project, { base: head }), restored: true });
    const stale = restoreRoute([custom(ROUTE_ENTRY, small(w.project, { base: "f".repeat(40) }))], w.facts, { interrupted: false });
    expect(stale.restored).toBe(true);
    expect(stale.state).toEqual(small(w.project, { base: head }));
    expect(stale.notice).toContain("f".repeat(40));
    expect(stale.notice).toContain(head);
    // An option-looking base is never passed to git as an option.
    const forged = restoreRoute([custom(ROUTE_ENTRY, small(w.project, { base: "--output=x" }))], w.facts, { interrupted: false });
    expect(forged.state.base).toBe(head);
    expect(existsSync(join(w.project, "x"))).toBe(false);
  });

  it("C1: a route declared for one project is not restored in another (fork or open across projects)", async () => {
    const w = await world({ git: true });
    const other = repo(join(w.home, "other"));
    const fromA = small(w.project);
    const r = restoreRoute([custom(ROUTE_ENTRY, fromA)], { ...w.facts, projectRoot: other, gitDirs: [join(other, ".git")] }, { interrupted: false });
    expect(r.state).toEqual(INITIAL_ROUTE);
    expect(r.restored).toBe(false);
    expect(r.notice).toContain(w.project);
    expect(r.notice).toContain(other);
  });

  it("stored roots compare after canonicalization (a symlinked spelling of the same project matches)", async () => {
    const w = await world();
    const link = join(w.dir, "project-link");
    symlinkSync(w.project, link, isWin ? "junction" : "dir");
    // Not a repository: no base (a stored one could not be verified and would be cleared, N1).
    const { base: _stored, ...stored } = small(link);
    const { base: _expected, ...expected } = small(w.project);
    const r = restoreRoute([custom(ROUTE_ENTRY, stored)], w.facts, { interrupted: false });
    expect(r.state).toEqual(expected);
    expect(r.notice).toBeUndefined();
  });

  it("an invalid stored worktree restores the answer route with a notice", async () => {
    const w = await world({ git: true });
    const gone = join(w.dir, "gone");
    const stored: RouteState = { route: "feature", tier: "feature", taskId: "t1", reason: "x", worktree: gone, writeRoots: [gone], needsReclassification: false };
    const r = restoreRoute([custom(ROUTE_ENTRY, stored)], w.facts, { interrupted: false });
    expect(r.state).toEqual(INITIAL_ROUTE);
    expect(r.restored).toBe(false);
    expect(r.notice).toContain("feature");
    expect(r.notice).toContain(`worktree does not exist: ${gone}`);
  });

  it("a malformed stored entry restores the answer route with a notice", async () => {
    const w = await world();
    const r = restoreRoute([custom(ROUTE_ENTRY, { route: "small", writeRoots: "nope" })], w.facts, { interrupted: false }, fakeIo());
    expect(r.state).toEqual(INITIAL_ROUTE);
    expect(r.notice).toMatch(/malformed/);
  });

  it("a stored flag survives the restore, and a restore after an interrupted run is always flagged (ruling 20)", async () => {
    const w = await world();
    const flagged = restoreRoute([custom(ROUTE_ENTRY, small(w.project, { needsReclassification: true }))], w.facts, { interrupted: false }, fakeIo());
    expect(flagged.state.needsReclassification).toBe(true);
    const resumed = restoreRoute([custom(ROUTE_ENTRY, small(w.project))], w.facts, { interrupted: true }, fakeIo());
    expect(resumed.state).toEqual(small(w.project, { needsReclassification: true }));
  });
});

// --- Pi wiring (fake ExtensionAPI) ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ToolLike {
  name: string;
  executionMode?: string;
  parameters: unknown;
  execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; details: unknown }>;
}

async function wired(opts: { session?: boolean; effectiveTools?: () => Array<{ name: string; parameters: unknown }> } = {}) {
  const w = await world();
  const handlers = new Map<string, Handler[]>();
  const tools: ToolLike[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const events: RunEvent[] = [];
  const state = { appendFails: false };
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => undefined;
    },
    registerTool: (t: ToolLike) => void tools.push(t),
    appendEntry: (customType: string, data: unknown) => {
      if (state.appendFails) throw new Error("disk full");
      entries.push({ customType, data });
    },
    // Pi resolves a duplicated name to the first registration (runner.js getAllRegisteredTools).
    getAllTools: () => (opts.effectiveTools ? opts.effectiveTools() : tools.map((t) => ({ name: t.name, parameters: t.parameters }))),
  };
  const session: RouteSession = { ledger: { append: (e) => void events.push(RunEvent.parse(e)) }, runId: "20261104T100000Z-1", facts: w.facts, io: fakeIo() };
  const factoryTools = new Set<string>();
  const routes = registerRouteState(pi as never, { session: async () => (opts.session === false ? undefined : session), factoryTools });
  const fire = async (name: string, event: Record<string, unknown>, ctx: unknown = {}) => {
    let out: unknown;
    for (const h of handlers.get(name) ?? []) out = await h({ type: name, ...event }, ctx);
    return out;
  };
  const user = (content: unknown) => fire("message_start", { message: { role: "user", content, timestamp: 0 } });
  const tool = tools.find((t) => t.name === "set_route")!;
  const setRouteCall = (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, {});
  return { w, handlers, tools, tool, entries, events, factoryTools, fire, user, setRouteCall, routes, state };
}

describe("registerRouteState (set_route tool, reclassification, prompt)", () => {
  it("registers set_route as a sequential factory tool", async () => {
    const x = await wired();
    expect(x.tools.map((t) => t.name)).toEqual(["set_route"]);
    expect(x.factoryTools.has("set_route")).toBe(true);
    expect(x.tool.executionMode).toBe("sequential");
    expect(JSON.stringify(x.tool.parameters)).toContain('"enum":["answer","small","feature","project"]');
  });

  it("set_route updates the state, persists a factory-route entry, audits a route event and announces the route", async () => {
    const x = await wired();
    const r = await x.setRouteCall({ route: "small", reason: "fix a typo" });
    expect(r.isError).not.toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "Route: small — fix a typo" }]);
    expect(currentRoute()).toEqual(small(x.w.project));
    expect(x.entries).toEqual([{ customType: ROUTE_ENTRY, data: small(x.w.project) }]);
    expect(x.events).toHaveLength(1);
    expect(x.events[0]).toMatchObject({ type: "route", reason: "set_route", state: small(x.w.project) });
  });

  it("a refused set_route is an error result and changes nothing", async () => {
    const x = await wired();
    const r = await x.setRouteCall({ route: "feature", reason: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("the feature route requires a taskId");
    expect(currentRoute()).toEqual(INITIAL_ROUTE);
    expect(x.entries).toEqual([]);
    expect(x.events).toEqual([]);
  });

  it("set_route without an open factory session is an error result", async () => {
    const x = await wired({ session: false });
    const r = await x.setRouteCall({ route: "small", reason: "x" });
    expect(r.isError).toBe(true);
    expect(currentRoute()).toEqual(INITIAL_ROUTE);
  });

  it("a second user message within one agent run flags the route, persists it and audits the redacted input", async () => {
    const x = await wired();
    await x.setRouteCall({ route: "small", reason: "fix a typo" });
    await x.user("fix the typo");
    expect(currentRoute().needsReclassification).toBe(false);
    await x.fire("message_start", { message: { role: "assistant", content: [], timestamp: 0 } });
    await x.fire("message_start", { message: { role: "toolResult", content: [], timestamp: 0 } });
    expect(currentRoute().needsReclassification).toBe(false);
    const long = `actually delete the database ${TOKEN} ${"y".repeat(800)}`;
    await x.user([{ type: "text", text: long }]);
    expect(currentRoute()).toEqual(small(x.w.project, { needsReclassification: true }));
    expect(x.entries.at(-1)).toEqual({ customType: ROUTE_ENTRY, data: small(x.w.project, { needsReclassification: true }) });
    const ev = x.events.at(-1) as { type: string; reason?: string; input?: string; state: Record<string, unknown> };
    expect(ev).toMatchObject({ type: "route", reason: "user input consumed", state: { needsReclassification: true } });
    expect(ev.input).not.toContain(TOKEN);
    expect(ev.input?.startsWith("actually delete the database")).toBe(true);
    expect(ev.input?.length).toBe(500);
    // set_route clears the flag.
    await x.setRouteCall({ route: "small", reason: "delete it" });
    expect(currentRoute().needsReclassification).toBe(false);
  });

  it("agent_start repeats do not reset the counter; agent_settled does (ruling 20)", async () => {
    const x = await wired();
    await x.setRouteCall({ route: "small", reason: "fix a typo" });
    await x.fire("agent_start", {});
    await x.user("first");
    // A retry or compaction restarts the low-level loop within the same agent run.
    await x.fire("agent_start", {});
    await x.fire("agent_start", {});
    await x.user("steered");
    expect(currentRoute().needsReclassification).toBe(true);

    await x.setRouteCall({ route: "small", reason: "again" });
    await x.fire("agent_settled", { aborted: false });
    // A new prompt after the run settled keeps the route (M §3.4).
    await x.fire("agent_start", {});
    await x.user("next prompt");
    expect(currentRoute().needsReclassification).toBe(false);
  });

  it("before_agent_start adds the routing section without replacing the system prompt", async () => {
    const x = await wired();
    const sections: Record<string, string> = { other: "kept" };
    const out = await x.fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections }, messageType: "user", prompt: "go" });
    expect(out).toBeUndefined();
    expect(sections).toEqual({ other: "kept", [ROUTING_SECTION_KEY]: ROUTING_RULE_SECTION });
  });

  it("context appends one user-role reminder with the current route", async () => {
    const x = await wired();
    const history = [{ role: "user", content: "go", timestamp: 1 }];
    const out = (await x.fire("context", { messages: history })) as { messages: Array<{ role: string; content: Array<{ text: string }> }> };
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toBe(history[0]);
    expect(out.messages[1]?.role).toBe("user");
    expect(out.messages[1]?.content[0]?.text).toContain("Current route: answer.");
    await x.setRouteCall({ route: "small", reason: "x" });
    await x.user("a");
    await x.user("b");
    const flagged = (await x.fire("context", { messages: history })) as { messages: Array<{ content: Array<{ text: string }> }> };
    expect(flagged.messages[1]?.content[0]?.text).toContain("call set_route to re-declare the route");
  });

  it("without an open factory session no prompt section or reminder is added", async () => {
    const x = await wired({ session: false });
    const sections: Record<string, string> = {};
    await x.fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections }, messageType: "user", prompt: "go" });
    expect(sections).toEqual({});
    expect(await x.fire("context", { messages: [] })).toBeUndefined();
  });

  it("M2: set_route stays a factory tool only while the effective definition is the one this extension registered", async () => {
    const ours = await wired();
    ours.routes.verifyTools();
    expect(ours.factoryTools.has("set_route")).toBe(true);
    // An earlier-loaded extension registered its own set_route: Pi runs that one, so the gate must not trust it.
    const shadowed = await wired({ effectiveTools: () => [{ name: "set_route", parameters: { type: "object", properties: {} } }] });
    shadowed.routes.verifyTools();
    expect(shadowed.factoryTools.has("set_route")).toBe(false);
    const missing = await wired({ effectiveTools: () => [] });
    missing.routes.verifyTools();
    expect(missing.factoryTools.has("set_route")).toBe(false);
    const broken = await wired({
      effectiveTools: () => {
        throw new Error("boom");
      },
    });
    broken.routes.verifyTools();
    expect(broken.factoryTools.has("set_route")).toBe(false);
  });

  it("M3: a flag that cannot be persisted as a session entry is audited as a ledger error", async () => {
    const x = await wired();
    await x.setRouteCall({ route: "small", reason: "fix a typo" });
    await x.user("first");
    x.state.appendFails = true;
    await x.user("second");
    expect(currentRoute().needsReclassification).toBe(true);
    expect(x.events.at(-1)).toMatchObject({ type: "error", where: "route-persist", message: expect.stringContaining("disk full") });
  });

  it("M4: session_tree restores the route of the new branch", async () => {
    const x = await wired();
    await x.setRouteCall({ route: "small", reason: "fix a typo" });
    const branch = (entries: unknown[]) => ({ hasUI: false, sessionManager: { getBranch: () => entries } });
    // Navigating to a point before any route entry: answer.
    await x.fire("session_tree", { newLeafId: "a", oldLeafId: "b" }, branch([]));
    expect(currentRoute()).toEqual(INITIAL_ROUTE);
    // Navigating to a branch whose last entry is a flagged small route of this project.
    const flagged = small(x.w.project, { needsReclassification: true });
    await x.fire("session_tree", { newLeafId: "c", oldLeafId: "a" }, branch([custom(ROUTE_ENTRY, small(x.w.project)), custom(ROUTE_ENTRY, flagged)]));
    expect(currentRoute()).toEqual(flagged);
    expect(x.events.at(-1)).toMatchObject({ type: "route", reason: "restored from session" });
  });

  it("announce names the route and the reason", () => {
    expect(announce(small("/p", { reason: "fix a typo" }))).toBe("Route: small — fix a typo");
  });
});
