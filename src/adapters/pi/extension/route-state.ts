// Route state in the extension (Phase 2 Task 8). The `set_route` tool validates a declaration against live facts
// (git toplevel, worktree, protected locations) and applies it through the core reducer; every change is
// persisted as a `factory-route` session entry and audited as a ledger `route` event. A session restores the
// last entry of its branch with re-validated write roots. A further user message consumed within one agent run
// (steering, follow-up) flags the route until `set_route` re-declares it (ruling 20). The routing rule goes into
// the system prompt sections and the current route into a reminder message on every provider call.
import path from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { summarizeCommand } from "../../../core/policy/redact.ts";
import {
  INITIAL_ROUTE,
  routeReducer,
  routeReminder,
  ROUTING_RULE_SECTION,
  validateSetRoute,
  type SetRouteRequest,
  type SetRouteResult,
} from "../../../core/route/route.ts";
import type { RouteState } from "../../../core/route/types.ts";
import { currentRoute, setRoute, type LedgerSink } from "./enforce.ts";
import { canonicalDir, headCommit, worktreeFacts, type WorktreeFacts } from "./facts.ts";
import { asRouteState } from "./ledger.ts";

/** Custom session entry type holding the route state (`pi.appendEntry`). */
export const ROUTE_ENTRY = "factory-route";
/** Key of the routing rule in `systemPromptOptions.sections` (rendered as a tag of this name). */
export const ROUTING_SECTION_KEY = "factory-routing";
export const SET_ROUTE_TOOL = "set_route";
const USER_INPUT_CONSUMED = "user input consumed";

export const SetRouteParams = Type.Object({
  route: Type.Enum(["answer", "small", "feature", "project"], {
    description: "answer: read-only questions; small: a small change in the project; feature/project: work in the task worktree",
  }),
  taskId: Type.Optional(Type.String({ description: "Task id (lowercase letters, digits, dashes); required for feature and project" })),
  reason: Type.String({ description: "One short sentence: why this route fits the request" }),
  worktree: Type.Optional(Type.String({ description: "Absolute path of the task worktree on branch factory/<taskId>; required for feature and project" })),
});

/** Realpathed session facts the declaration is checked against (index.ts Session). */
export interface RouteFacts {
  projectRoot: string;
  home: string;
  piAgentDir: string;
  factoryHome: string;
  gitDirs: string[];
}

/** Filesystem and git observations; a seam for tests. */
export interface RouteIo {
  canonicalDir(p: string): string;
  worktreeFacts(p: string, projectRoot: string): WorktreeFacts;
  /** `git rev-parse HEAD` of a write root (ruling 10, R26). */
  head(root: string): string | undefined;
}

export const ROUTE_IO: RouteIo = { canonicalDir, worktreeFacts, head: headCommit };

/** What the hooks need from the open factory run. */
export interface RouteSession {
  ledger: LedgerSink;
  runId: string;
  facts: RouteFacts;
  io?: RouteIo;
}

function contains(parent: string, child: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Review M6 (Task 7): a write root must not be home or contain it, must not overlap Pi's agent dir or the
 * factory home (credentials, sessions, the run ledger), and must not lie inside a git dir (R21). The project
 * root falls back to the cwd outside a repository, so this is what keeps `set_route small` in `~` read-only.
 */
export function protectedRootError(root: string, f: RouteFacts): string | undefined {
  if (contains(root, f.home)) return `refusing write root ${root}: it is the home directory or contains it`;
  for (const [label, dir] of [
    ["the Pi agent dir", f.piAgentDir],
    ["the factory home", f.factoryHome],
  ] as const) {
    if (contains(root, dir) || contains(dir, root)) return `refusing write root ${root}: it overlaps ${label} ${dir}`;
  }
  for (const g of f.gitDirs) if (contains(g, root)) return `refusing write root ${root}: it is inside the git dir ${g}`;
  return undefined;
}

/** validateSetRoute with live facts: realpathed worktree, git worktree facts and the protected-root check. */
function validateWithFacts(req: SetRouteRequest, facts: RouteFacts, io: RouteIo): SetRouteResult {
  let request = req;
  let worktreeOk: WorktreeFacts | undefined;
  const wt = req.worktree;
  if ((req.route === "feature" || req.route === "project") && wt !== undefined && wt !== "" && path.isAbsolute(wt)) {
    let real: string;
    try {
      real = io.canonicalDir(wt);
    } catch (e) {
      return { ok: false, error: `worktree cannot be resolved: ${(e as Error).message}` };
    }
    request = { ...req, worktree: real };
    worktreeOk = io.worktreeFacts(real, facts.projectRoot);
  }
  const v = validateSetRoute(request, { projectRoot: facts.projectRoot, ...(worktreeOk !== undefined ? { worktreeOk } : {}) });
  if (!v.ok) return v;
  for (const root of v.state.writeRoots) {
    const error = protectedRootError(root, facts);
    if (error !== undefined) return { ok: false, error };
  }
  return v;
}

/** `set_route`: the validated state with `base` = HEAD of the write root when it has one (R26). */
export function declareRoute(req: SetRouteRequest, facts: RouteFacts, io: RouteIo = ROUTE_IO): SetRouteResult {
  const v = validateWithFacts(req, facts, io);
  const root = v.ok ? v.state.writeRoots[0] : undefined;
  if (!v.ok || root === undefined) return v;
  const base = io.head(root);
  return { ok: true, state: base === undefined ? v.state : { ...v.state, base } };
}

export interface RestoredRoute {
  state: RouteState;
  /** A stored route was restored (false: none stored, or it no longer validates). */
  restored: boolean;
  /** Why a stored route was not restored; shown to the user. */
  notice?: string;
}

/**
 * The last `factory-route` entry of `entries` (the session branch, oldest first). Write roots are never taken
 * from the entry: the declaration is validated again with live facts (a worktree that is gone, or a project
 * that became protected, gives the answer route and a notice). The stored `base` and flag are kept; after an
 * interrupted run the route is always flagged (ruling 20, `restored_after_interruption`).
 */
export function restoreRoute(entries: readonly unknown[], facts: RouteFacts, opts: { interrupted: boolean }, io: RouteIo = ROUTE_IO): RestoredRoute {
  let data: unknown;
  let found = false;
  for (let i = entries.length - 1; i >= 0 && !found; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (e?.type === "custom" && e.customType === ROUTE_ENTRY) {
      data = e.data;
      found = true;
    }
  }
  if (!found) return { state: INITIAL_ROUTE, restored: false };
  const stored = asRouteState(data);
  const readOnly = "the route is answer (read-only) until set_route declares another one";
  if (stored === undefined) return { state: INITIAL_ROUTE, restored: false, notice: `factory: the stored route is malformed; ${readOnly}` };

  let state: RouteState;
  if (stored.route === "answer") {
    state = { route: "answer", ...(stored.reason !== undefined ? { reason: stored.reason } : {}), writeRoots: [], needsReclassification: stored.needsReclassification };
  } else {
    const reason = stored.reason !== undefined && stored.reason.trim() !== "" ? stored.reason : "restored route";
    const req: SetRouteRequest = {
      route: stored.route,
      reason,
      ...(stored.taskId !== undefined ? { taskId: stored.taskId } : {}),
      ...(stored.worktree !== undefined ? { worktree: stored.worktree } : {}),
    };
    const v = validateWithFacts(req, facts, io);
    if (!v.ok) return { state: INITIAL_ROUTE, restored: false, notice: `factory: the stored ${stored.route} route no longer validates (${v.error}); ${readOnly}` };
    state = { ...v.state, ...(stored.base !== undefined ? { base: stored.base } : {}), needsReclassification: stored.needsReclassification };
  }
  if (opts.interrupted) state = routeReducer(state, { type: "restored_after_interruption", state });
  return { state, restored: true };
}

/** The one-line announcement (M §3.2) that `set_route` returns. */
export function announce(state: RouteState): string {
  return `Route: ${state.route} — ${state.reason ?? ""}`;
}

type AgentMessage = ContextEvent["messages"][number];

/** The user-role reminder appended to every provider call (the `context` result carries messages only). */
export function reminderMessage(state: RouteState): AgentMessage {
  return { role: "user", content: [{ type: "text", text: `[factory] ${routeReminder(state)}` }], timestamp: Date.now() };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: unknown; text?: unknown }) => (c?.type === "text" && typeof c.text === "string" ? c.text : c?.type === "image" ? "[image]" : ""))
    .filter((t) => t !== "")
    .join("\n");
}

type RoutePi = Pick<ExtensionAPI, "on" | "registerTool" | "appendEntry">;
type NoticeCtx = Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">;

export interface RouteStateDeps {
  /** The open factory run, or undefined (handshake failed or the policy is unavailable). */
  session(): Promise<RouteSession | undefined>;
  /** Review M2: names this extension registered; `set_route` is added on registration. */
  factoryTools: Set<string>;
}

export interface RouteStateHandle {
  /** Restores the route of `ctx`'s session branch (session start); `s` is passed because the run is still opening. */
  restore(s: RouteSession, ctx: NoticeCtx, opts: { interrupted: boolean }): void;
}

function warn(ctx: NoticeCtx, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else process.stderr.write(`${message}\n`);
}

function routeEvent(s: RouteSession, state: RouteState, reason: string, input?: string): void {
  s.ledger.append({
    v: 1,
    ts: new Date().toISOString(),
    runId: s.runId,
    type: "route",
    state: { ...state },
    reason,
    ...(input !== undefined ? { input } : {}),
  });
}

function toolResult(text: string, details: RouteState | undefined, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

export function registerRouteState(pi: RoutePi, deps: RouteStateDeps): RouteStateHandle {
  pi.registerTool({
    name: SET_ROUTE_TOOL,
    label: "Set route",
    description: [
      "Declare the route of the current request before modifying anything, and again when a new user message changes the work.",
      "answer: questions and investigation, read-only. small: a small change; the project root becomes writable.",
      "feature/project: work in the task worktree (absolute path, branch factory/<taskId>); pass taskId and worktree.",
      "Returns the one-line announcement to show the user.",
    ].join(" "),
    promptSnippet: "set_route: declare the route (answer, small, feature, project) before modifying anything",
    parameters: SetRouteParams,
    // Shares the in-memory route with every other call's gate decision.
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const s = await deps.session();
      if (s === undefined) return toolResult("set_route is unavailable: the factory policy is not active in this session", undefined, true);
      const r = declareRoute(params, s.facts, s.io ?? ROUTE_IO);
      if (!r.ok) return toolResult(`set_route refused: ${r.error}`, currentRoute(), true);
      const next = routeReducer(currentRoute(), { type: "set_route", state: r.state });
      // Audited and persisted before it takes effect: a route change that cannot be recorded is not made.
      try {
        routeEvent(s, next, "set_route");
        pi.appendEntry(ROUTE_ENTRY, next);
      } catch (e) {
        return toolResult(`set_route failed: the route change could not be recorded (${(e as Error).message})`, currentRoute(), true);
      }
      setRoute(next);
      return toolResult(announce(next), next);
    },
  });
  deps.factoryTools.add(SET_ROUTE_TOOL);

  // Ruling 20: user messages consumed per agent run; reset only when the run has settled.
  let consumed = 0;
  pi.on("message_start", async (event) => {
    if (event.message.role !== "user") return;
    const index = consumed++;
    if (index === 0) return;
    // The flag takes effect first: a failed audit or persistence never leaves the route writable.
    const next = routeReducer(currentRoute(), { type: "user_message_consumed", index });
    setRoute(next);
    const s = await deps.session();
    if (s === undefined) return;
    try {
      routeEvent(s, next, USER_INPUT_CONSUMED, summarizeCommand(textOf(event.message.content)));
    } catch (e) {
      process.stderr.write(`factory: could not audit the consumed user message: ${(e as Error).message}\n`);
    }
    try {
      pi.appendEntry(ROUTE_ENTRY, next);
    } catch (e) {
      process.stderr.write(`factory: could not persist the route: ${(e as Error).message}\n`);
    }
  });
  pi.on("agent_settled", async () => {
    consumed = 0;
  });

  pi.on("before_agent_start", async (event) => {
    if ((await deps.session()) === undefined) return undefined;
    // Mutate the sections (A §7.2): the result type has no sections field and the system prompt is never replaced.
    event.systemPromptOptions.sections[ROUTING_SECTION_KEY] = ROUTING_RULE_SECTION;
    return undefined;
  });

  pi.on("context", async (event) => {
    if ((await deps.session()) === undefined) return undefined;
    return { messages: [...event.messages, reminderMessage(currentRoute())] };
  });

  const restore = (s: RouteSession, ctx: NoticeCtx, opts: { interrupted: boolean }): void => {
    let r: RestoredRoute;
    try {
      r = restoreRoute(ctx.sessionManager.getBranch(), s.facts, opts, s.io ?? ROUTE_IO);
    } catch (e) {
      r = { state: INITIAL_ROUTE, restored: false, notice: `factory: the stored route could not be restored (${(e as Error).message}); the route is answer (read-only)` };
    }
    setRoute(r.state);
    if (r.notice !== undefined) {
      warn(ctx, r.notice);
      try {
        s.ledger.append({ v: 1, ts: new Date().toISOString(), runId: s.runId, type: "error", where: "route-restore", message: r.notice });
        pi.appendEntry(ROUTE_ENTRY, r.state);
      } catch (e) {
        process.stderr.write(`factory: could not record the route restore: ${(e as Error).message}\n`);
      }
      return;
    }
    if (!r.restored) return;
    try {
      routeEvent(s, r.state, "restored from session");
      if (opts.interrupted) pi.appendEntry(ROUTE_ENTRY, r.state);
    } catch (e) {
      process.stderr.write(`factory: could not record the restored route: ${(e as Error).message}\n`);
    }
  };

  // Branch navigation (/tree) changes which entries are current: the route follows the branch (Pi docs).
  pi.on("session_tree", async (_event, ctx) => {
    const s = await deps.session();
    if (s !== undefined) restore(s, ctx, { interrupted: false });
  });

  return { restore };
}
