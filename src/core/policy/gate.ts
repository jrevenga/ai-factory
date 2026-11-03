// GatePolicy (Phase 2 Task 3): the pure decision core of the guardrails. It fails closed: anything it cannot
// classify asks, anything that violates write protection is denied, and a configuration error denies.
//
// Precedence: deny > ask > allow. Every write-protection deny (ledger, machine section, `.factory/` rule,
// missing task file) is evaluated before any hard-gate ask, so approving an ask can never bypass a deny.
// The extension resolves `ask` through the UI when present, else denies with `requires human approval`
// (ruling 4); core never assumes a UI.
import path from "node:path";
import type { HardGateId } from "../config/schema.ts";
import type { RouteState } from "../route/types.ts";
import type { AutonomyLevel } from "./autonomy.ts";
import { classifyCommandLine, isPathLikeArg, type CommandClass, type CommandClassification } from "./command.ts";
import { classifyPath, isSecretPath, type PathClassification, type PathContext, type PathFacts, type PathPlatform } from "./paths.ts";

export type ToolAction =
  | { kind: "read"; tool: string; path?: PathFacts }
  | {
      kind: "write";
      tool: "write" | "edit";
      path: PathFacts;
      touchesMachineSection: boolean;
      /** Whether the target exists; needed for "new files only" in `.factory/knowledge/decisions/`. Unknown denies there. */
      targetExists?: boolean;
    }
  | {
      kind: "command";
      tool: "bash" | "powershell";
      command: string;
      /**
       * Contract for Tasks 6/7: one fact for every `classifyCommandLine()` entry of
       * - `pathArgs` (write targets),
       * - `inputPaths` (`<` sources, `git -C` dirs),
       * - `readArgs` that is path-like (`isPathLikeArg`) OR exists relative to the command's cwd (R25).
       * `input` must equal the argument string exactly (a leading `~/` included). A fact whose `input` equals a pathArg
       * is a write target; every other fact is checked for secrets and the secret-dir guard. A missing pathArg fact
       * asks `outside-root-write`; a missing inputPath or path-like readArg fact asks `secrets`. A non-path-like readArg
       * without a fact is treated as a word, not a file — so the extension must supply facts for existing files.
       */
      pathFacts: PathFacts[];
    }
  | { kind: "factory"; tool: string }
  | { kind: "unknown"; tool: string };

export interface GateContext {
  route: RouteState;
  mode: "interactive" | "unattended";
  autonomy: AutonomyLevel;
  home: string;
  piAgentDir: string;
  projectRoot: string;
  tmpRoots: string[];
  /** `<FACTORY_HOME>/runs`: every run's ledger lives below it and is write-protected, not only the current run's. */
  ledgerDir: string;
  projectCommands: string[][];
  /** Whether `<worktree>/.factory/knowledge/tasks/<taskId>.md` exists (feature/project routes, ruling 6). */
  taskFileExists: boolean;
  /** Git dirs of the repository and of the active worktree (`git rev-parse --git-dir` / common dir); ruling R21. */
  gitDirs: string[];
}

export interface GateResult {
  decision: "allow" | "deny" | "ask";
  class?: CommandClass;
  hardGate?: HardGateId;
  reason: string;
  /** True only for an allowlisted runner allowed on the answer route (ruling 5): Task 11 reconciles it. */
  reconcile: boolean;
}

const WIN_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const PROTECTED_KNOWLEDGE_DIRS = ["tasks", "specs", "plans"];
const DECLARE = "declare a change route with set_route before modifying files";
const RECLASSIFY = "a new user message arrived: re-declare the route with set_route before modifying files";

function result(decision: GateResult["decision"], reason: string, extra: Partial<GateResult> = {}): GateResult {
  return { decision, reason, reconcile: false, ...extra };
}

/** Effective command mode (ruling 19): high autonomy is an unattended context for commands. */
export function effectiveCommandMode(ctx: GateContext): "interactive" | "unattended" {
  return ctx.mode === "unattended" || ctx.autonomy === "high" ? "unattended" : "interactive";
}

function pathContext(ctx: GateContext, writeRoots: string[], tmpRoots: string[] = []): PathContext {
  return { home: ctx.home, piAgentDir: ctx.piAgentDir, writeRoots, tmpRoots };
}

/** The classification of `fact` relative to the first of `roots` containing it, or undefined. */
function under(fact: PathFacts, roots: string[], ctx: GateContext): PathClassification | undefined {
  const c = classifyPath(fact, pathContext(ctx, roots));
  return c.within === "write-root" ? c : undefined;
}

/** Throws unless `dir` is a usable absolute directory for `platform` (configuration error → deny). */
function requireDir(dir: string, name: string, platform: PathPlatform, ctx: GateContext): void {
  const self: PathFacts = { input: dir, resolved: dir, platform };
  if (under(self, [dir], ctx) === undefined) throw new Error(`${name} must be an absolute path, got ${JSON.stringify(dir)}`);
}

function validateContext(ctx: GateContext): void {
  const platform: PathPlatform = WIN_ABSOLUTE.test(ctx.home) ? "win32" : "posix";
  // isSecretPath validates home and piAgentDir and throws when either is not absolute.
  isSecretPath(ctx.home, { home: ctx.home, piAgentDir: ctx.piAgentDir, platform });
  requireDir(ctx.projectRoot, "projectRoot", platform, ctx);
  requireDir(ctx.ledgerDir, "ledgerDir", platform, ctx);
}

function segments(p: string, platform: PathPlatform): string[] {
  return p.split(platform === "win32" ? /[\\/]+/ : "/").filter((s) => s !== "");
}

/** Comparison key: case-folded on win32 (case-insensitive filesystem); exact on posix. */
function key(s: string, platform: PathPlatform): string {
  return platform === "win32" ? s.toLowerCase() : s;
}

/** True when any segment names `name`. Case-insensitive everywhere (macOS filesystems fold case). */
function hasSegment(p: string, name: string, platform: PathPlatform): boolean {
  return segments(p, platform).some((s) => {
    const folded = s.toLowerCase();
    return (platform === "win32" ? folded.replace(/[. ]+$/, "") : folded) === name;
  });
}

/** Home directories that hold listed secrets (R23); with home itself and piAgentDir, their ancestors are guarded. */
const HOME_SECRET_DIRS = [".aws", ".config/gh", ".config/gcloud", ".codex", ".docker", ".kube", ".ssh", ".gnupg", ".azure"];

/**
 * R23: a read target that is home, piAgentDir, a listed home secret dir, or an ancestor of any of them. A recursive
 * reader (the grep tool) given such a directory would read the secrets inside it.
 */
function guardsSecretDir(fact: PathFacts, ctx: GateContext): boolean {
  const { platform } = fact;
  const a = platform === "win32" ? path.win32 : path.posix;
  const guarded = [ctx.home, ctx.piAgentDir, ...HOME_SECRET_DIRS.map((d) => a.join(ctx.home, ...d.split("/")))];
  const targets = [fact.resolved, fact.input];
  return guarded.some((g) => under({ input: g, resolved: g, platform }, targets, ctx) !== undefined);
}

/** Ruling 7: inside `.factory/`, only this task's knowledge files and new decision files may be written. */
function factoryWriteAllowed(rel: string[], ctx: GateContext, targetExists: boolean | undefined, platform: PathPlatform): boolean {
  const s = rel.map((x) => key(x, platform));
  if (s.length !== 4 || s[0] !== ".factory" || s[1] !== "knowledge") return false;
  const taskId = ctx.route.taskId;
  if (taskId !== undefined && PROTECTED_KNOWLEDGE_DIRS.includes(s[2]!) && s[3] === key(`${taskId}.md`, platform)) return true;
  return s[2] === "decisions" && targetExists === false;
}

function isTaskFile(rel: string[], ctx: GateContext, platform: PathPlatform): boolean {
  const taskId = ctx.route.taskId;
  if (taskId === undefined) return false;
  const expected = [".factory", "knowledge", "tasks", `${taskId}.md`];
  return rel.length === expected.length && rel.every((x, i) => key(x, platform) === key(expected[i]!, platform));
}

interface WriteAnalysis {
  cls: PathClassification;
  /** Write-protection violation: always deny. */
  deny?: string;
  /** Ruling R21: the target is inside a git dir. */
  gitDir: boolean;
  /** The target is a write root or the project root itself (a command could replace or move all of it). */
  rootTarget: boolean;
}

/**
 * Write protection shared by write tools and command write targets. `by: "command"` adds the rules that only the
 * write/edit pre- and post-checks can otherwise enforce: the task file (machine section, ruling 8) and `.factory`
 * directories copied or moved in from outside the roots (ruling 7).
 */
function analyzeWrite(fact: PathFacts, ctx: GateContext, targetExists: boolean | undefined, by: "tool" | "command"): WriteAnalysis {
  const { platform } = fact;
  requireDir(ctx.ledgerDir, "ledgerDir", platform, ctx);
  requireDir(ctx.projectRoot, "projectRoot", platform, ctx);
  const cls = classifyPath(fact, pathContext(ctx, ctx.route.writeRoots, ctx.tmpRoots));
  const gitDir =
    under(fact, ctx.gitDirs, ctx) !== undefined || hasSegment(fact.resolved, ".git", platform) || hasSegment(fact.input, ".git", platform);
  const projectRel = under(fact, [ctx.projectRoot], ctx)?.relative;
  const rootTarget = (cls.within === "write-root" && cls.relative === "") || projectRel === "";
  const a: WriteAnalysis = { cls, gitDir, rootTarget };

  if (under(fact, [ctx.ledgerDir], ctx) !== undefined) {
    a.deny = "writes under the run ledger directory are denied (only extension code writes machine state)";
    return a;
  }
  // `.factory/` is protected under every write root and under the project root (ruling 7, ruling 18).
  const relString = cls.within === "write-root" ? cls.relative : projectRel;
  const rel = relString !== undefined ? segments(relString, platform) : [];
  if (rel[0]?.toLowerCase() === ".factory" && !factoryWriteAllowed(rel, ctx, targetExists, platform)) {
    a.deny = `writes inside .factory/ are limited to this task's knowledge files and new decision files (${rel.join("/")})`;
    return a;
  }
  if (by === "command") {
    if (cls.within === "write-root" && isTaskFile(rel, ctx, platform)) {
      a.deny = "the task file holds the machine-owned section: change it with write/edit, not a command";
      return a;
    }
    if (cls.within !== "write-root" && (hasSegment(fact.resolved, ".factory", platform) || hasSegment(fact.input, ".factory", platform))) {
      a.deny = `a command may not write a .factory path outside the write roots (it could be copied or moved in): ${fact.input}`;
      return a;
    }
  }
  const { route } = ctx.route;
  if ((route === "feature" || route === "project") && !ctx.taskFileExists && cls.within === "write-root" && !isTaskFile(rel, ctx, platform)) {
    a.deny = `write the task file .factory/knowledge/tasks/${ctx.route.taskId ?? "<taskId>"}.md before other files`;
  }
  return a;
}

/**
 * R24: Pi's `ls` and `find` tools return names only and their output cannot be piped into a reader, so a
 * secret-holding directory is not a content read for them. Every other read tool name keeps the guard.
 */
const NAME_ONLY_READ_TOOLS: ReadonlySet<string> = new Set(["ls", "find"]);

function evaluateRead(tool: string, fact: PathFacts | undefined, ctx: GateContext): GateResult {
  if (fact === undefined) return result("allow", "read tool without a path");
  const cls = classifyPath(fact, pathContext(ctx, ctx.route.writeRoots, ctx.tmpRoots));
  if (cls.secret) return result("ask", `reading a secret path: ${fact.input}`, { hardGate: "secrets" });
  if (!NAME_ONLY_READ_TOOLS.has(tool) && guardsSecretDir(fact, ctx)) {
    return result("ask", `the target contains secret files (home, Pi agent dir or a credentials dir): ${fact.input}`, { hardGate: "secrets" });
  }
  return result("allow", "read of a non-secret path");
}

function evaluateWrite(action: Extract<ToolAction, { kind: "write" }>, ctx: GateContext): GateResult {
  if (ctx.route.needsReclassification) return result("deny", RECLASSIFY);
  if (ctx.route.route === "answer") return result("deny", `the answer route cannot write: ${DECLARE}`);
  const w = analyzeWrite(action.path, ctx, action.targetExists, "tool");
  if (w.deny !== undefined) return result("deny", w.deny);
  if (action.touchesMachineSection) return result("deny", "the machine-owned section is written only by extension code");
  const outside = w.cls.within !== "write-root";
  if (outside && ctx.mode === "unattended") {
    return result("deny", `write outside the route's write roots in unattended mode: ${action.path.input}`, { hardGate: "outside-root-write" });
  }
  if (w.cls.secret) return result("ask", `writing a secret path: ${action.path.input}`, { hardGate: "secrets" });
  if (outside) return result("ask", `write outside the route's write roots: ${action.path.input}`, { hardGate: "outside-root-write" });
  if (w.gitDir) return result("ask", `write inside a git dir can run code through hooks or config: ${action.path.input}`, { hardGate: "destructive" });
  return result("allow", "write inside the route's write roots");
}

function summary(c: CommandClassification): string {
  return c.reasons.length > 0 ? c.reasons.join("; ") : c.class;
}

/**
 * Route rule for the answer route and for a route needing reclassification: the deny reason, or undefined when the
 * command may run (read-only, or an allowlisted runner on the answer route that Task 11 reconciles).
 */
function answerRouteDeny(c: CommandClassification, ctx: GateContext): string | undefined {
  const reason = ctx.route.needsReclassification ? RECLASSIFY : DECLARE;
  if (c.class === "read-only") return undefined;
  if (ctx.route.needsReclassification) return `${summary(c)}: ${reason}`;
  // Ruling 5: only what Task 11 can reconcile (tracked files, index, new untracked files) runs on the answer
  // route. Local-write git moves HEAD, refs, branches or the stash, which reconciliation does not restore.
  // Unknown git is not allowlisted and gets the generic reason (N-1).
  const git = c.segments.find((seg) => seg.class === "local-write" && seg.argv[0] === "git");
  if (git) return `\`${git.argv.join(" ")}\` changes git state that cannot be reconciled on the answer route: ${DECLARE}`;
  if (c.allowlisted) return undefined;
  return `${summary(c)}: ${reason}`;
}

function evaluateCommand(action: Extract<ToolAction, { kind: "command" }>, ctx: GateContext): GateResult {
  if (action.tool === "powershell") {
    return result("ask", "PowerShell commands are not classified in Phase 2 (ruling 3)", { class: "unknown" });
  }
  const c = classifyCommandLine(action.command, { projectCommands: ctx.projectCommands });
  const base = { class: c.class };
  const noRoots = ctx.route.route === "answer" || ctx.route.needsReclassification;
  const noRootsReason = ctx.route.needsReclassification ? RECLASSIFY : DECLARE;

  const writeInputs = new Set(c.pathArgs);
  const writes = action.pathFacts
    .filter((f) => writeInputs.has(f.input))
    .map((f) => ({ fact: f, ...analyzeWrite(f, ctx, undefined, "command") }));
  const missing = c.pathArgs.filter((p) => !action.pathFacts.some((f) => f.input === p));
  const hasFact = (p: string) => action.pathFacts.some((f) => f.input === p);
  const missingInputs = [
    ...c.inputPaths.filter((p) => !hasFact(p)),
    ...c.readArgs.filter((a) => isPathLikeArg(a) && !writeInputs.has(a) && !hasFact(a) && !c.inputPaths.includes(a)),
  ];

  // Denies first.
  const denied = writes.find((w) => w.deny !== undefined);
  if (denied) return result("deny", denied.deny!, base);
  if (noRoots && (missing.length > 0 || writes.some((w) => w.cls.within !== "tmp"))) {
    const targets = [...missing, ...writes.filter((w) => w.cls.within !== "tmp").map((w) => w.fact.input)];
    return result("deny", `the command writes ${targets.join(", ")}: ${noRootsReason}`, base);
  }

  // A route deny that no fact can change is decided before any ask (deny > ask). Hard classes still ask (ruling 5).
  const routeDeny = noRoots && c.hardClass === undefined ? answerRouteDeny(c, ctx) : undefined;
  if (routeDeny !== undefined) return result("deny", routeDeny, base);

  // Hard gates ask (every fact, read or write, is checked for secrets).
  const secret = action.pathFacts.find((f) => classifyPath(f, pathContext(ctx, ctx.route.writeRoots, ctx.tmpRoots)).secret);
  if (secret) return result("ask", `the command touches a secret path: ${secret.input}`, { ...base, hardGate: "secrets" });
  // R24: in bash a pipeline turns names into contents, so every read fact (not write targets) gets the guard.
  const secretDir = action.pathFacts.find((f) => !writeInputs.has(f.input) && guardsSecretDir(f, ctx));
  if (secretDir) {
    return result("ask", `the command reads a directory that contains secret files: ${secretDir.input}`, { ...base, hardGate: "secrets" });
  }
  if (missingInputs.length > 0) {
    return result("ask", `read paths could not be checked for secrets: ${missingInputs.join(", ")}`, { ...base, hardGate: "secrets" });
  }
  if (c.hardClass === "remote-mutating") return result("ask", `remote-mutating command: ${summary(c)}`, { ...base, hardGate: "remote-mutation" });
  if (missing.length > 0) {
    return result("ask", `path arguments could not be resolved: ${missing.join(", ")}`, { ...base, hardGate: "outside-root-write" });
  }
  const outside = writes.find((w) => w.cls.within === "outside");
  if (outside) {
    return result("ask", `the command writes outside the write roots: ${outside.fact.input}`, { ...base, hardGate: "outside-root-write" });
  }
  if (c.hardClass === "destructive") return result("ask", `destructive command: ${summary(c)}`, { ...base, hardGate: "destructive" });
  const git = writes.find((w) => w.gitDir);
  if (git) {
    return result("ask", `the command writes inside a git dir (hooks/config run code): ${git.fact.input}`, { ...base, hardGate: "destructive" });
  }
  const root = writes.find((w) => w.rootTarget);
  if (root) {
    return result("ask", `the command targets a root directory itself and could replace or move all of it: ${root.fact.input}`, {
      ...base,
      hardGate: "destructive",
    });
  }

  // Route rules.
  if (noRoots) {
    if (c.class === "read-only") return result("allow", "read-only command", base);
    const deny = answerRouteDeny(c, ctx);
    if (deny !== undefined) return result("deny", deny, base);
    return result("allow", "allowlisted runner on the answer route: tracked files are reconciled afterwards", { ...base, reconcile: true });
  }
  if (c.allowlisted) return result("allow", "every segment is read-only or allowlisted", base);
  if (effectiveCommandMode(ctx) === "unattended") {
    return result("ask", `not allowlisted for unattended execution: ${summary(c)}`, base);
  }
  if (c.class === "local-write") return result("allow", "local write inside the write roots", base);
  return result("ask", `command not recognized: ${summary(c)}`, base);
}

export function evaluateGate(action: ToolAction, ctx: GateContext): GateResult {
  try {
    validateContext(ctx);
    switch (action.kind) {
      case "factory":
        return result("allow", `factory tool ${action.tool} validates its own input`);
      case "read":
        return evaluateRead(action.tool, action.path, ctx);
      case "write":
        return evaluateWrite(action, ctx);
      case "command":
        return evaluateCommand(action, ctx);
      default:
        return result("ask", `tool ${(action as { tool?: unknown }).tool ?? "?"} is not classified by the factory`);
    }
  } catch (e) {
    return result("deny", `policy error (fail closed): ${(e as Error).message}`);
  }
}
