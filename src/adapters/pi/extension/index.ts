// The factory's Pi package extension (package.json "pi.extensions"). Runs inside Pi.
// On session_start it checks that the installed factory (state.json) matches this package, that the
// personal config parses and that FACTORY_HOME is writable, then emits `factory:handshake` for the
// guard (ruling 8). While the handshake has failed, its own tool_call handler blocks every tool except
// the read-only ones, which covers "loaded but handshake failed" even without the guard file.
// Once the handshake is ok it opens the factory run (ruling 9: `run_start` in the run ledger), restores the route
// of the session branch (route-state.ts), registers `task_progress` (task-state.ts) and the evidence tools `run_check`,
// `record_review` and `record_decision` (evidence.ts), and enforces the GatePolicy on every tool call (enforce.ts);
// `run_end` is written at session_shutdown.
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../../../core/config/resolve.ts";
import { CoreConfig, PersonalConfig, ProjectConfig, type SoftGateId } from "../../../core/config/schema.ts";
import { declaredCommands, type DeclaredCommand } from "../../../core/evidence/check-plan.ts";
import {
  evaluateHandshake,
  HANDSHAKE_EVENT,
  handshakeFailureMessage,
  READ_ONLY_TOOLS,
  type HandshakeResult,
} from "../../../core/handshake.ts";
import { projectIdFor, runIdFor } from "../../../core/ledger/events.ts";
import { resolveFactoryHome, resolvePiAgentDir } from "../../../core/paths/homes.ts";
import type { AutonomyLevel } from "../../../core/policy/autonomy.ts";
import type { GateContext } from "../../../core/policy/gate.ts";
import { INITIAL_ROUTE } from "../../../core/route/route.ts";
import type { RouteState } from "../../../core/route/types.ts";
import { FactoryState } from "../../../core/state/schema.ts";
import { CONFIRM_TIMEOUT_MS, currentRoute, enforce, GatedChecks, InFlightCalls, MachinePostChecks, setRoute, type GateUi } from "./enforce.ts";
import { registerEvidence, type EvidenceSession } from "./evidence.ts";
import { canonicalDir, gitDirs, repoRoot, sha256hex } from "./facts.ts";
import { ledgerDirFor, RunLedger } from "./ledger.ts";
import { registerRouteState, type RouteSession } from "./route-state.ts";
import { storeWritable } from "./store-probe.ts";
import { registerTaskState, type TaskSession } from "./task-state.ts";

const PACKAGE_JSON = fileURLToPath(new URL("../../../../package.json", import.meta.url));
const CORE_DEFAULTS = fileURLToPath(new URL("../../../../defaults/config.json", import.meta.url));
/** A git dir chosen through the environment applies to every bash `git` (R21; Task 6 concern 2). */
const GIT_DIR_VARS = ["GIT_DIR", "GIT_COMMON_DIR"];

type Read = { kind: "missing" } | { kind: "json"; value: unknown } | { kind: "error" };

async function readJson(path: string): Promise<Read> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "error" };
  }
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    return { kind: "error" };
  }
}

/** Missing or invalid state both mean "not installed" for the handshake. */
async function installedVersion(home: string): Promise<string | undefined> {
  const r = await readJson(join(home, "state.json"));
  if (r.kind !== "json") return undefined;
  const parsed = FactoryState.safeParse(r.value);
  return parsed.success ? parsed.data.version : undefined;
}

/** An unreadable package.json yields "unknown", which never matches a state version (fails closed). */
async function packageVersion(): Promise<string> {
  const r = await readJson(PACKAGE_JSON);
  if (r.kind === "json" && typeof r.value === "object" && r.value !== null) {
    const v = (r.value as { version?: unknown }).version;
    if (typeof v === "string" && v !== "") return v;
  }
  return "unknown";
}

type PersonalRead = { ok: true; config: PersonalConfig | undefined } | { ok: false };

/** No personal config yet is fine (defaults apply); one that exists must parse. */
async function personalConfig(home: string): Promise<PersonalRead> {
  const r = await readJson(join(home, "config.json"));
  if (r.kind === "missing") return { ok: true, config: undefined };
  if (r.kind !== "json") return { ok: false };
  const parsed = PersonalConfig.safeParse(r.value);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false };
}

interface HandshakeRun {
  result: HandshakeResult;
  personal: PersonalConfig | undefined;
}

async function runHandshake(env: NodeJS.ProcessEnv = process.env): Promise<HandshakeRun> {
  const home = resolveFactoryHome(env, homedir());
  const [expectedVersion, version, personal, writable] = await Promise.all([
    installedVersion(home),
    packageVersion(),
    personalConfig(home),
    storeWritable(home),
  ]);
  const result = evaluateHandshake({ expectedVersion, packageVersion: version, configOk: personal.ok, storeWritable: writable });
  return { result, personal: personal.ok ? personal.config : undefined };
}

function report(ctx: ExtensionContext, message: string): void {
  // Print and JSON modes have no UI (Pi docs/extensions.md); stderr keeps stdout clean there.
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else process.stderr.write(`${message}\n`);
}

/** Facts fixed for the run: gathered once at session start (git runs only here, never per tool call). */
interface Session {
  ledger: RunLedger;
  runId: string;
  rawHome: string;
  home: string;
  piAgentDir: string;
  factoryHome: string;
  projectRoot: string;
  ledgerDir: string;
  gitDirs: string[];
  tmpCandidates: string[];
  autonomy: AutonomyLevel;
  /** Effective `gates.soften` (core, personal and project layers; ruling 13). */
  softened: SoftGateId[];
  /** `.factory/config.json` `commands`, tokenized (Task 10); the gate and `run_check` use the same list. */
  declared: DeclaredCommand[];
  projectCommands: string[][];
  postChecks: MachinePostChecks;
  inFlight: InFlightCalls;
  gatedChecks: GatedChecks;
}

function within(child: string, parent: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A tmp root is usable only when no protected location lies inside it and it is not inside the project, a
 * write root or factory/Pi state: otherwise a command write "to tmp" could land in protected files (tests
 * keep the project under the OS temp dir, as can a user).
 */
function usableTmpRoots(s: Session, route: RouteState): string[] {
  const containers = [s.projectRoot, ...route.writeRoots, s.piAgentDir, s.factoryHome, ...s.gitDirs];
  const guarded = [...containers, s.home];
  return s.tmpCandidates.filter((t) => !guarded.some((g) => within(g, t)) && !containers.some((c) => within(t, c)));
}

function taskFileExists(route: RouteState): boolean {
  if ((route.route !== "feature" && route.route !== "project") || route.worktree === undefined || route.taskId === undefined) return false;
  return existsSync(join(route.worktree, ".factory", "knowledge", "tasks", `${route.taskId}.md`));
}

function policyContext(s: Session, ctx: ExtensionContext): GateContext {
  const route = currentRoute();
  return {
    route,
    mode: ctx.hasUI ? "interactive" : "unattended",
    autonomy: s.autonomy,
    home: s.home,
    piAgentDir: s.piAgentDir,
    projectRoot: s.projectRoot,
    tmpRoots: usableTmpRoots(s, route),
    ledgerDir: s.ledgerDir,
    projectCommands: s.projectCommands,
    taskFileExists: taskFileExists(route),
    gitDirs: s.gitDirs,
  };
}

type ProjectRead = { ok: true; config: ProjectConfig | undefined } | { ok: false; error: string };

/** `<projectRoot>/.factory/config.json`, read once per run (the gate write-protects it, ruling 7). */
function projectConfig(projectRoot: string): ProjectRead {
  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, ".factory", "config.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, config: undefined };
    return { ok: false, error: (e as Error).message };
  }
  try {
    const parsed = ProjectConfig.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, config: parsed.data } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Opens the factory run: realpathed facts, effective autonomy, run ledger with `run_start`. Throws on failure. */
function openSession(ctx: ExtensionContext, personal: PersonalConfig | undefined, version: string, env: NodeJS.ProcessEnv = process.env): Session {
  const rawHome = homedir();
  const factoryHome = resolveFactoryHome(env, rawHome);
  const projectRoot = repoRoot(ctx.cwd) ?? canonicalDir(path.resolve(ctx.cwd));
  const dirs = gitDirs(projectRoot);
  for (const k of GIT_DIR_VARS) {
    const v = env[k];
    if (v) {
      const d = canonicalDir(path.resolve(ctx.cwd, v));
      if (!dirs.includes(d)) dirs.push(d);
    }
  }
  const core = CoreConfig.parse(JSON.parse(readFileSync(CORE_DEFAULTS, "utf8")));
  // An unreadable or invalid project config fails closed for what it would grant: no declared runners, no softened gates.
  const project = projectConfig(projectRoot);
  if (!project.ok) report(ctx, `factory: .factory/config.json is invalid (${project.error}); declared commands and softened gates are ignored`);
  const effective = resolveConfig({ core, ...(personal ? { personal } : {}), ...(project.ok && project.config ? { project: project.config } : {}) }).value;
  const autonomy = effective.autonomy;
  const softened = project.ok ? [...effective.gates.soften] : [];
  const commands = project.ok ? declaredCommands(project.config?.commands) : { declared: [], ignored: [] };
  if (commands.ignored.length > 0) report(ctx, `factory: ignored declared commands in .factory/config.json: ${commands.ignored.join("; ")}`);
  const projectId = projectIdFor(projectRoot, sha256hex);
  const runId = runIdFor(new Date(), process.pid);
  const ledger = new RunLedger(ledgerDirFor(factoryHome, projectId), runId);
  ledger.append({
    v: 1,
    ts: new Date().toISOString(),
    runId,
    type: "run_start",
    pid: process.pid,
    projectId,
    projectRoot,
    factoryVersion: version,
    piSession: ctx.sessionManager.getSessionId(),
  });
  return {
    ledger,
    runId,
    rawHome,
    home: canonicalDir(rawHome),
    piAgentDir: canonicalDir(resolvePiAgentDir(env, rawHome)),
    factoryHome: canonicalDir(factoryHome),
    projectRoot,
    ledgerDir: canonicalDir(join(factoryHome, "runs")),
    gitDirs: dirs,
    tmpCandidates: [canonicalDir(tmpdir())],
    autonomy,
    softened,
    declared: commands.declared,
    projectCommands: commands.declared.map((d) => [...d.argv]),
    postChecks: new MachinePostChecks(),
    inFlight: new InFlightCalls(),
    gatedChecks: new GatedChecks(),
  };
}

function routeSession(s: Session): RouteSession {
  return {
    ledger: s.ledger,
    runId: s.runId,
    facts: { projectRoot: s.projectRoot, home: s.home, piAgentDir: s.piAgentDir, factoryHome: s.factoryHome, gitDirs: s.gitDirs },
  };
}

function taskSession(s: Session): TaskSession {
  return { ledger: s.ledger, runId: s.runId, projectRoot: s.projectRoot, home: s.home, piAgentDir: s.piAgentDir, postChecks: s.postChecks };
}

function evidenceSession(s: Session): EvidenceSession {
  return {
    ledger: s.ledger,
    runId: s.runId,
    runDir: dirname(s.ledger.file),
    projectRoot: s.projectRoot,
    home: s.home,
    piAgentDir: s.piAgentDir,
    autonomy: s.autonomy,
    softened: s.softened,
    projectCommands: s.projectCommands,
    declared: s.declared,
    gatedChecks: s.gatedChecks,
  };
}

interface Started {
  handshake: HandshakeResult;
  session?: Session;
  sessionError?: string;
}

export default function factoryExtension(pi: ExtensionAPI): void {
  let current: Promise<Started> | undefined;
  /**
   * Review M2: names of the tools this extension registered with `pi.registerTool`. Only these are gated as
   * factory tools; each registration adds its name here.
   */
  const factoryTools = new Set<string>();
  const sessionNow = async (): Promise<Session | undefined> => (current === undefined ? undefined : (await current).session);
  const routes = registerRouteState(pi, {
    session: async () => {
      const s = await sessionNow();
      return s === undefined ? undefined : routeSession(s);
    },
    factoryTools,
  });
  const tasks = registerTaskState(pi, {
    session: async () => {
      const s = await sessionNow();
      return s === undefined ? undefined : taskSession(s);
    },
    factoryTools,
  });
  const evidence = registerEvidence(pi, {
    session: async () => {
      const s = await sessionNow();
      return s === undefined ? undefined : evidenceSession(s);
    },
    factoryTools,
  });
  const verifyTools = (): void => {
    routes.verifyTools();
    tasks.verifyTools();
    evidence.verifyTools();
  };

  const start = (ctx: ExtensionContext): Promise<Started> => {
    current = runHandshake().then(({ result, personal }) => {
      pi.events.emit(HANDSHAKE_EVENT, result);
      if (!result.ok) {
        report(ctx, handshakeFailureMessage(result));
        return { handshake: result };
      }
      // Read-only until the route of the session branch is restored (or when opening the run fails).
      setRoute(INITIAL_ROUTE);
      try {
        const session = openSession(ctx, personal, result.version);
        verifyTools();
        // Task 13 passes `interrupted: true` when reconciliation finds this session's previous run interrupted.
        routes.restore(routeSession(session), ctx, { interrupted: false });
        return { handshake: result, session };
      } catch (e) {
        const sessionError = (e as Error).message;
        report(ctx, `factory policy unavailable (every tool is blocked): ${sessionError}`);
        return { handshake: result, sessionError };
      }
    });
    return current;
  };

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const s = await (current ?? start(ctx));
    if (!s.handshake.ok) {
      if (READ_ONLY_TOOLS.includes(event.toolName)) return undefined;
      return { block: true, reason: handshakeFailureMessage(s.handshake) };
    }
    const session = s.session;
    if (session === undefined) return { block: true, reason: `factory policy unavailable (fail closed): ${s.sessionError ?? "unknown error"}` };
    // Review M2: a tool registered later under a factory name must not ride on the factory classification.
    if (factoryTools.has(event.toolName)) verifyTools();
    const ui: GateUi | undefined = ctx.hasUI ? { confirm: (title, message) => ctx.ui.confirm(title, message, { timeout: CONFIRM_TIMEOUT_MS }) } : undefined;
    return enforce(event, { cwd: ctx.cwd }, {
      policyContext: () => policyContext(session, ctx),
      ledger: session.ledger,
      runId: session.runId,
      home: session.rawHome,
      postChecks: session.postChecks,
      inFlight: session.inFlight,
      factoryTools,
      gatedChecks: session.gatedChecks,
      ...(ui ? { ui } : {}),
    });
  });

  pi.on("tool_result", async (event) => {
    const session = await sessionNow();
    if (session === undefined) return undefined;
    try {
      return session.postChecks.afterToolResult(event, session.ledger, session.runId);
    } finally {
      session.inFlight.done(event.toolCallId);
    }
  });

  // Fires for every call, also for one a later extension's hook blocked (which gets no tool_result).
  pi.on("tool_execution_end", async (event) => {
    (await sessionNow())?.inFlight.done(event.toolCallId);
  });

  // Backstop (review M4): nothing is in flight once the agent has settled.
  pi.on("agent_settled", async () => {
    const session = await sessionNow();
    session?.inFlight.clear();
    session?.postChecks.clear();
    session?.gatedChecks.clear();
  });

  pi.on("session_shutdown", async (event) => {
    const session = await sessionNow();
    if (session === undefined) return;
    session.inFlight.clear();
    session.postChecks.clear();
    session.gatedChecks.clear();
    try {
      session.ledger.append({ v: 1, ts: new Date().toISOString(), runId: session.runId, type: "run_end", reason: event.reason });
    } catch (e) {
      process.stderr.write(`factory: could not write run_end: ${(e as Error).message}\n`);
    }
  });
}
