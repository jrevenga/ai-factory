// Evidence tools (Phase 2 Task 10): `run_check`, `record_review`, `record_decision`, the working-tree fingerprint
// (ruling 11) and `loadEvidence` for Phase 4's delivery.
//
// `run_check` is gated in the `tool_call` hook exactly like `bash` for the same command line (enforce.ts
// `runCheckAction`): hard gates, the ask path, R29 and R31 apply unchanged, and the call is cleared for execution
// there (`GatedChecks`). The tool runs only a cleared call, and only commands whose every segment is read-only,
// allowlisted or project-declared (`planCheck`), from the same lexer segments the gate classified, each segment's
// argv spawned directly (no shell), `&&` segments in order until the first failure. Output is redacted line by
// line into `<runDir>/checks/<id>.log` (exclusive create); the result carries the exit code and the last 50 lines.
// The `CheckRecord` holds the fingerprints before and after (`mutated` when they differ).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import path, { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HARD_GATES, SOFT_GATES, type SoftGateId } from "../../../core/config/schema.ts";
import { declaredNameOf, planCheck, type CheckStep, type DeclaredCommand } from "../../../core/evidence/check-plan.ts";
import { isKnownDisposition, REVIEW_DISPOSITIONS, type CheckRecord, type ReviewDisposition } from "../../../core/evidence/records.ts";
import { resolvePiAgentDir } from "../../../core/paths/homes.ts";
import { autonomyAllowsSkip, type AutonomyLevel } from "../../../core/policy/autonomy.ts";
import { isSecretPath } from "../../../core/policy/paths.ts";
import { LineRedactor, redact, summarizeCommand } from "../../../core/policy/redact.ts";
import { currentRoute, RUN_CHECK_TOOL, type GatedChecks, type LedgerSink } from "./enforce.ts";
import { killProcessTree, type ProcessDeps } from "../../platform/process.ts";
import { canonicalDir, gitFailureText, hostPlatform, hostProgramSearch, resolveProgram, withSafePath } from "./facts.ts";
import { RunLedger } from "./ledger.ts";
import { verifyRegisteredTool } from "./route-state.ts";
import { withSafeGit, type Git, type SecretTest } from "./task-state.ts";

export { RUN_CHECK_TOOL };
export const RECORD_REVIEW_TOOL = "record_review";
export const RECORD_DECISION_TOOL = "record_decision";

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 3600;
const TAIL_LINES = 50;
const TAIL_LINE_CHARS = 1000;
/** In-memory output kept for the result tail; everything else goes only to the log. */
const TAIL_BUFFER_CHARS = 256 * 1024;
/** The log is the full output up to this size; beyond it the log says how much was dropped. */
const LOG_MAX_BYTES = 64 * 1024 * 1024;
/** After a failed teardown, pipes still held by a surviving process are released this late. */
const KILL_GRACE_MS = 2000;
const MAX_TEXT = 4000;
const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Ruling 11: task files change with progress, not with the work; they never count. */
const TASKS_DIR = ".factory/knowledge/tasks";
const PATHSPECS = ["--pathspec-from-file=-", "--pathspec-file-nul"];
const nulList = (items: readonly string[]) => `${items.join("\0")}\0`;

// --- Fingerprint (ruling 11) -----------------------------------------------------------------------------------

function gitFailure(what: string, r: { status: number | null; stderr: string }): Error {
  return new Error(`fingerprint: ${gitFailureText(`git ${what}`, r)}`);
}

/** Absolute path of the work tree's own index (`--git-path index`: a linked worktree has its own). */
function indexPath(git: Git, top: string): string {
  let r = git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  let out = r.stdout.trim();
  if (r.status !== 0 || out.includes("\n") || out.startsWith("-")) {
    r = git(top, ["rev-parse", "--git-path", "index"]);
    out = r.stdout.trim();
    if (r.status !== 0 || out === "") throw gitFailure("rev-parse --git-path index", r);
  }
  return path.resolve(top, out);
}

/** The secret-path test of the gate (R34) for paths relative to `top`. */
export function secretTestFor(top: string, ctx: { home: string; piAgentDir: string }): SecretTest {
  const secretCtx = { home: ctx.home, piAgentDir: ctx.piAgentDir, platform: hostPlatform() };
  return (rel) => isSecretPath(join(top, rel), secretCtx);
}

/**
 * Ruling 11: the tree id of the work tree containing `dir` as it is on disk — committed, tracked-modified and
 * untracked non-ignored files — without the task files (`.factory/knowledge/tasks/**`). Computed in a copy of the
 * work tree's index under `os.tmpdir()` (removed in `finally`), with the safe git wrapper (no hooks, no fsmonitor,
 * inherited `GIT_*` location and pathspec variables stripped). The user's index is never written.
 *
 * Decision 6 (R34 spirit): `git add` would write the blob of every changed file into `.git/objects`. Changed secret
 * paths (`isSecretPath`) are therefore left out of `add` and entered with `update-index --info-only`, which records
 * their hash without writing the blob; the tree is then written with `--missing-ok`. A change to a non-ignored
 * secret file still changes the fingerprint, but its content never reaches the object database.
 */
export function fingerprint(dir: string, isSecret?: SecretTest): string {
  return withSafeGit((git) => {
    const topRun = git(dir, ["rev-parse", "--show-toplevel"]);
    const topOut = topRun.stdout.trim();
    if (topRun.status === null) throw gitFailure("rev-parse --show-toplevel", topRun);
    if (topRun.status !== 0 || topOut === "") throw new Error(`fingerprint: ${dir} is not inside a git work tree`);
    const top = path.resolve(dir, topOut);
    const secret = isSecret ?? secretTestFor(top, { home: canonicalDir(homedir()), piAgentDir: canonicalDir(resolvePiAgentDir(process.env, homedir())) });
    const index = indexPath(git, top);
    const tmp = mkdtempSync(join(tmpdir(), "factory-fingerprint-"));
    try {
      const tmpIndex = join(tmp, "index");
      if (existsSync(index)) copyFileSync(index, tmpIndex);
      const env = { GIT_INDEX_FILE: tmpIndex };
      const run = (what: string, args: string[], input?: string) => {
        const r = git(top, args, input, env);
        if (r.status !== 0) throw gitFailure(what, r);
        return r;
      };
      run("rm --cached", ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", `:(literal)${TASKS_DIR}`]);
      const status = run("status", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ".", `:(exclude,literal)${TASKS_DIR}`]);
      const secrets: string[] = [];
      for (const entry of status.stdout.split("\0")) {
        if (entry.length < 4) continue;
        const p = entry.slice(3);
        if (secret(p) && !secrets.includes(p)) secrets.push(p);
      }
      const specs = [".", `:(exclude,literal)${TASKS_DIR}`, ...secrets.map((p) => `:(exclude,literal)${p}`)];
      run("add", ["add", "-A", ...PATHSPECS], nulList(specs));
      if (secrets.length > 0) run("update-index --info-only", ["update-index", "--add", "--remove", "--replace", "--info-only", "-z", "--stdin"], nulList(secrets));
      const tree = run("write-tree", ["write-tree", ...(secrets.length > 0 ? ["--missing-ok"] : [])]).stdout.trim();
      if (!TREE_ID.test(tree)) throw new Error(`fingerprint: git write-tree returned an unexpected value: ${tree.slice(0, 80)}`);
      return tree;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// --- Evidence for delivery -------------------------------------------------------------------------------------

/**
 * The check records and review dispositions of the project's runs (`ledgerDir` = `<FACTORY_HOME>/runs/<projectId>`),
 * in run order (runIds sort by start time) and event order. `runIds` limits the runs read. Dispositions this release
 * does not know (R13) are skipped: they never satisfy delivery. A corrupt ledger throws (delivery fails loudly).
 */
export function loadEvidence(ledgerDir: string, runIds?: readonly string[]): { checks: CheckRecord[]; dispositions: ReviewDisposition[] } {
  const ids =
    runIds !== undefined
      ? [...runIds]
      : existsSync(ledgerDir)
        ? readdirSync(ledgerDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
        : [];
  const checks: CheckRecord[] = [];
  const dispositions: ReviewDisposition[] = [];
  for (const id of ids) {
    const ledger = new RunLedger(ledgerDir, id);
    if (!existsSync(ledger.file)) continue;
    for (const e of RunLedger.read(ledger.file)) {
      if (e.type === "check") checks.push(e.record);
      else if (e.type === "review") {
        const known = e.disposition.disposition;
        if (isKnownDisposition(known)) dispositions.push({ ...e.disposition, disposition: known });
      }
    }
  }
  return { checks, dispositions };
}

// --- Process tree teardown (decision 5) ------------------------------------------------------------------------
// Phase 1's `killProcessTree` (src/adapters/platform/process.ts, importable here by ruling R36): POSIX SIGTERM to the
// process group, SIGKILL after a grace period, poll until gone; Windows an awaited, bounded `taskkill /PID <pid> /T /F`
// whose non-zero exit is a teardown failure. `ProcessDeps` is its test seam.

// --- Output: redacted log + bounded tail -----------------------------------------------------------------------

class CheckOutput {
  private readonly redactors = { stdout: new LineRedactor(), stderr: new LineRedactor() };
  private readonly decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  private tail = "";
  private written = 0;
  private dropped = 0;
  private readonly fd: number;

  constructor(fd: number) {
    this.fd = fd;
  }

  data(stream: "stdout" | "stderr", chunk: Buffer): void {
    this.emit(this.redactors[stream].push(this.decoders[stream].write(chunk)));
  }

  /** End of a process: flushes both streams (a final unterminated line gets its own line). */
  flush(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = this.redactors[stream].push(this.decoders[stream].end()) + this.redactors[stream].end();
      if (rest !== "") this.emit(rest.endsWith("\n") ? rest : `${rest}\n`);
    }
  }

  note(message: string): void {
    this.emit(`[run_check] ${redact(message)}\n`);
  }

  /** Writes to the log only (headers), never to the tail. */
  log(text: string): void {
    this.write(redact(text));
  }

  lastLines(): string[] {
    const lines = this.tail.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-TAIL_LINES).map((l) => (l.length > TAIL_LINE_CHARS ? `${l.slice(0, TAIL_LINE_CHARS)}…` : l));
  }

  close(): void {
    if (this.dropped > 0) this.writeRaw(`[run_check] log truncated: ${this.dropped} further bytes of output were not written\n`);
    closeSync(this.fd);
  }

  private emit(text: string): void {
    if (text === "") return;
    this.write(text);
    this.tail += text;
    if (this.tail.length > TAIL_BUFFER_CHARS) this.tail = this.tail.slice(-TAIL_BUFFER_CHARS / 2);
  }

  private write(text: string): void {
    const buf = Buffer.from(text, "utf8");
    if (this.written + buf.length > LOG_MAX_BYTES) {
      this.dropped += buf.length;
      return;
    }
    this.writeRaw(text);
  }

  private writeRaw(text: string): void {
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
    this.written += buf.length;
  }
}

// --- Running the steps -----------------------------------------------------------------------------------------

interface ResolvedStep {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  display: string;
}

interface RunOutcome {
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}

function signalCode(sig: NodeJS.Signals | null): number {
  if (sig === null) return 1;
  const n = (osConstants.signals as Record<string, number | undefined>)[sig];
  return n === undefined ? 1 : 128 + n;
}

function runOne(step: ResolvedStep, cwd: string, deadline: number, signal: AbortSignal | undefined, out: CheckOutput, teardownDeps: Partial<ProcessDeps>): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killing: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    const finish = (o: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(o);
    };
    try {
      child = spawn(step.file, step.args, {
        cwd,
        env: step.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      out.note(`could not start ${step.display}: ${(e as Error).message}`);
      resolve({ exitCode: 127, timedOut: false, aborted: false });
      return;
    }
    // killProcessTree releases the pipes itself after a successful teardown. After a failed one the tree may still
    // run: the failure is noted, the pipes are released and the check ends now instead of waiting for `close`.
    const teardown = () =>
      (killing ??= killProcessTree(child, teardownDeps).then(
        () => undefined,
        (e: unknown) => {
          out.note(`process tree teardown failed: ${(e as Error).message}`);
          child.stdout?.destroy();
          child.stderr?.destroy();
          out.flush();
          finish({ exitCode: timedOut ? 124 : aborted ? 130 : (child.exitCode ?? 1), timedOut, aborted });
        },
      ));
    const onAbort = () => {
      aborted = true;
      void teardown();
    };
    child.stdout?.on("data", (b: Buffer) => out.data("stdout", b));
    child.stderr?.on("data", (b: Buffer) => out.data("stderr", b));
    timer = setTimeout(
      () => {
        timedOut = true;
        void teardown();
      },
      Math.max(0, deadline - Date.now()),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    child.on("error", (e) => {
      if (child.pid !== undefined) return;
      out.flush();
      out.note(`could not start ${step.display}: ${e.message}`);
      finish({ exitCode: 127, timedOut: false, aborted: false });
    });
    // POSIX: descendants left in the group when the leader exits would hold the pipes; a check leaves nothing behind
    // in its process group (a no-op when the group is already gone).
    child.on("exit", () => {
      if (process.platform !== "win32" && child.pid !== undefined) void teardown();
    });
    child.on("close", (code, sig) => {
      void (async () => {
        if (killing !== undefined) await killing;
        if (settled) return;
        out.flush();
        const exitCode = timedOut ? 124 : aborted ? 130 : code ?? signalCode(sig);
        finish({ exitCode, timedOut, aborted });
      })();
    });
  });
}

async function runSteps(steps: ResolvedStep[], cwd: string, timeoutMs: number, signal: AbortSignal | undefined, out: CheckOutput, teardownDeps: Partial<ProcessDeps> = {}): Promise<RunOutcome> {
  const deadline = Date.now() + timeoutMs;
  let last: RunOutcome = { exitCode: 0, timedOut: false, aborted: false };
  for (const step of steps) {
    out.log(`$ ${step.display}\n`);
    last = await runOne(step, cwd, deadline, signal, out, teardownDeps);
    if (last.exitCode !== 0 || last.timedOut || last.aborted) {
      if (last.timedOut) out.note(`timed out after ${Math.round(timeoutMs / 1000)} s; the process tree was torn down`);
      if (last.aborted) out.note("cancelled; the process tree was torn down");
      return last;
    }
  }
  return last;
}

// --- Tools -----------------------------------------------------------------------------------------------------

/** What the evidence tools need from the open factory run (index.ts Session). */
export interface EvidenceSession {
  ledger: LedgerSink;
  runId: string;
  /** `<ledgerDir>/<runId>`: check logs go to `<runDir>/checks/<id>.log`. */
  runDir: string;
  projectRoot: string;
  home: string;
  piAgentDir: string;
  autonomy: AutonomyLevel;
  /** Effective `gates.soften` (ruling 13). */
  softened: readonly SoftGateId[];
  /** Project-declared runners, tokenized; the same list the gate gets. */
  projectCommands: string[][];
  declared: readonly DeclaredCommand[];
  gatedChecks: GatedChecks;
  /** Test seam for `killProcessTree` (platform, taskkill); production uses its defaults. */
  teardown?: Partial<ProcessDeps>;
}

export interface EvidenceDeps {
  session(): Promise<EvidenceSession | undefined>;
  /** Review M2: names this extension registered; each evidence tool is added on registration. */
  factoryTools: Set<string>;
}

export interface EvidenceHandle {
  verifyTools(): void;
}

type EvidencePi = Pick<ExtensionAPI, "registerTool" | "getAllTools">;

export function runCheckParams() {
  return Type.Object({
    command: Type.String({
      description: "The check to run: one simple command or `&&`-joined commands, read-only, allowlisted or declared in .factory/config.json commands (no pipes, redirections or other operators)",
    }),
    timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SEC, description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC})` })),
  });
}

export function recordReviewParams() {
  return Type.Object({
    taskId: Type.String({ description: "The task id of the current route" }),
    disposition: Type.Enum([...REVIEW_DISPOSITIONS], { description: "approved, approved_with_rulings or escalated" }),
    reviewer: Type.String({ description: "Who reviewed (for example the reviewing model or person), one line" }),
    findingsSummary: Type.String({ description: "Short summary of the findings and how they were resolved" }),
  });
}

export function recordDecisionParams() {
  return Type.Object({
    kind: Type.Enum(["soft-gate-skipped", "soft-gate-resolved", "ruling"], { description: "soft-gate-skipped, soft-gate-resolved or ruling" }),
    gate: Type.Optional(Type.String({ description: `Soft gate id (${SOFT_GATES.join(", ")}); required for soft-gate kinds` })),
    justification: Type.String({ description: "Why: the reasoning behind the decision" }),
  });
}

class Refusal extends Error {}

function text(t: string, details: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: t }], details, ...(isError ? { isError: true } : {}) };
}

function required(name: string, v: unknown, max = MAX_TEXT): string {
  if (typeof v !== "string" || v.trim() === "") throw new Refusal(`${name} must be a non-empty string`);
  const t = v.trim();
  if (t.length > max) throw new Refusal(`${name} is too long (${t.length} > ${max} characters)`);
  return t;
}

function now(): string {
  return new Date().toISOString();
}

/** `chk-<UTC yyyymmddThhmmssZ>-<8 hex>`: generated, never model input, safe as a file name. */
function newCheckId(d = new Date()): string {
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `chk-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** `<runDir>/checks/<id>.log`, created exclusively inside the run dir (the checks dir must not be a link). */
function openCheckLog(runDir: string, id: string): { fd: number; file: string } {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const checks = join(runDir, "checks");
  mkdirSync(checks, { recursive: true, mode: 0o700 });
  if (!lstatSync(checks).isDirectory() || realpathSync(checks) !== join(realpathSync(runDir), "checks")) {
    throw new Refusal(`the check log directory ${checks} is not a plain directory inside the run directory`);
  }
  const file = join(checks, `${id}.log`);
  return { fd: openSync(file, "wx", 0o600), file };
}

export function registerEvidence(pi: EvidencePi, deps: EvidenceDeps): EvidenceHandle {
  const checkParams = runCheckParams();
  const reviewParams = recordReviewParams();
  const decisionParams = recordDecisionParams();

  pi.registerTool({
    name: RUN_CHECK_TOOL,
    label: "Run check",
    description: [
      "Run a verification command (tests, build, lint, typecheck) and record it as delivery evidence.",
      "Allowed: read-only commands, allowlisted runners (npm test, npm run build|lint|typecheck, vitest, tsc, ...) and the commands declared in .factory/config.json commands.test|build|lint|typecheck (exact match).",
      "No shell: one command or `&&`-joined commands, no pipes, redirections or other operators.",
      "Runs in the route's write root. The record holds the working-tree fingerprint before and after; a check that changes files is marked mutated and never counts for delivery.",
    ].join(" "),
    promptSnippet: "run_check: run tests/build/lint/typecheck as recorded evidence (exact declared or allowlisted commands, no pipes)",
    parameters: checkParams,
    // Writes a log, takes fingerprints and runs project code: never concurrently with another call.
    executionMode: "sequential",
    async execute(toolCallId, params: { command: string; timeoutSec?: number }, signal) {
      const s = await deps.session();
      if (s === undefined) return text("run_check is unavailable: the factory policy is not active in this session", undefined, true);
      try {
        return await runCheck(s, toolCallId, params, signal);
      } catch (e) {
        const prefix = e instanceof Refusal ? "run_check refused" : "run_check failed";
        return text(`${prefix}: ${redact((e as Error).message)}`, undefined, true);
      }
    },
  });
  deps.factoryTools.add(RUN_CHECK_TOOL);

  pi.registerTool({
    name: RECORD_REVIEW_TOOL,
    label: "Record review",
    description:
      "Record the review disposition of the current task (approved, approved_with_rulings or escalated), bound to the current working-tree fingerprint of the task's write root. Any later change to the tree invalidates it for delivery.",
    promptSnippet: "record_review: record the task's review disposition at the current fingerprint",
    parameters: reviewParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: { taskId: string; disposition: string; reviewer: string; findingsSummary: string }) {
      const s = await deps.session();
      if (s === undefined) return text("record_review is unavailable: the factory policy is not active in this session", undefined, true);
      try {
        return recordReview(s, params);
      } catch (e) {
        const prefix = e instanceof Refusal ? "record_review refused" : "record_review failed";
        return text(`${prefix}: ${redact((e as Error).message)}`, undefined, true);
      }
    },
  });
  deps.factoryTools.add(RECORD_REVIEW_TOOL);

  pi.registerTool({
    name: RECORD_DECISION_TOOL,
    label: "Record decision",
    description: [
      "Record a decision in the run's decision log: a soft gate skipped or resolved, or a ruling.",
      `Soft gates: ${SOFT_GATES.join(", ")}. A skip is accepted only when the autonomy level allows it (low: none; medium: gates listed in gates.soften; high: any).`,
      "Hard gates are never skipped.",
    ].join(" "),
    promptSnippet: "record_decision: log a soft-gate skip/resolution or a ruling with its justification",
    parameters: decisionParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: { kind: string; gate?: string; justification: string }) {
      const s = await deps.session();
      if (s === undefined) return text("record_decision is unavailable: the factory policy is not active in this session", undefined, true);
      try {
        return recordDecision(s, params);
      } catch (e) {
        const prefix = e instanceof Refusal ? "record_decision refused" : "record_decision failed";
        return text(`${prefix}: ${redact((e as Error).message)}`, undefined, true);
      }
    },
  });
  deps.factoryTools.add(RECORD_DECISION_TOOL);

  return {
    verifyTools: () => {
      verifyRegisteredTool(pi, RUN_CHECK_TOOL, checkParams, deps.factoryTools);
      verifyRegisteredTool(pi, RECORD_REVIEW_TOOL, reviewParams, deps.factoryTools);
      verifyRegisteredTool(pi, RECORD_DECISION_TOOL, decisionParams, deps.factoryTools);
    },
  };
}

async function runCheck(s: EvidenceSession, toolCallId: string, params: { command: string; timeoutSec?: number }, signal: AbortSignal | undefined) {
  const cleared = s.gatedChecks.take(toolCallId);
  if (cleared === undefined || cleared.command !== params.command) {
    throw new Refusal("this call was not cleared by the factory gate (the command must pass the tool_call gate unchanged)");
  }
  const timeoutSec = params.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) throw new Refusal(`timeoutSec must be an integer from 1 to ${MAX_TIMEOUT_SEC}`);
  const plan = planCheck(cleared.command, s.projectCommands);
  if (!plan.ok) throw new Refusal(plan.error);
  const cwd = cleared.cwd;
  // M2: programs come only from absolute PATH entries outside the project and the write root, in the search and in
  // the child's own PATH.
  const excluded = [s.projectRoot, cwd];
  const env = withSafePath(process.env, process.platform, excluded);
  const steps: ResolvedStep[] = plan.steps.map((step: CheckStep) => {
    const exe = resolveProgram(step.argv[0]!, cwd, hostProgramSearch(excluded, env));
    if (!exe.ok) throw new Refusal(exe.error);
    return { file: exe.file, args: step.argv.slice(1), env: { ...env, ...step.env }, display: step.argv.join(" ") };
  });
  const secret = secretTestFor(cwd, s);
  const before = fingerprint(cwd, secret);
  const id = newCheckId();
  const log = openCheckLog(s.runDir, id);
  const out = new CheckOutput(log.fd);
  const started = Date.now();
  let outcome: RunOutcome;
  try {
    out.log(`# run_check ${id}\n# cwd: ${cwd}\n# command: ${summarizeCommand(cleared.command)}\n# fingerprint before: ${before}\n`);
    outcome = await runSteps(steps, cwd, timeoutSec * 1000, signal, out, s.teardown);
  } catch (e) {
    out.note(`run failed: ${(e as Error).message}`);
    out.close();
    throw e;
  }
  const durationMs = Date.now() - started;
  let after: string;
  try {
    after = fingerprint(cwd, secret);
  } catch (e) {
    out.close();
    throw e;
  }
  out.log(`# exit ${outcome.exitCode} after ${durationMs} ms\n# fingerprint after: ${after}\n`);
  const tail = out.lastLines();
  out.close();

  const declaredAs = declaredNameOf(plan.steps, s.declared);
  const record: CheckRecord = {
    id,
    command: summarizeCommand(cleared.command),
    exitCode: outcome.exitCode,
    cwd,
    fingerprint: before,
    fingerprintAfter: after,
    mutated: before !== after,
    durationMs,
    logPath: log.file,
    at: now(),
    ...(declaredAs !== undefined ? { declaredAs } : {}),
    ...(outcome.timedOut ? { timedOut: true } : {}),
    ...(outcome.aborted ? { aborted: true } : {}),
  };
  let auditError: string | undefined;
  try {
    s.ledger.append({ v: 1, ts: now(), runId: s.runId, type: "check", record });
  } catch (e) {
    auditError = `the check ran but could not be recorded in the run ledger (${(e as Error).message}); it is not evidence`;
  }
  const status = outcome.timedOut ? `timed out after ${timeoutSec} s (exit ${outcome.exitCode})` : outcome.aborted ? `cancelled (exit ${outcome.exitCode})` : `exit ${outcome.exitCode}`;
  const lines = [
    `Check ${id}: ${status} in ${(durationMs / 1000).toFixed(1)} s (cwd ${cwd}).`,
    record.mutated
      ? `The command changed the working tree (fingerprint ${before} -> ${after}): this record is marked mutated and never counts for delivery; re-run the check on the changed tree.`
      : `Fingerprint ${before}.`,
    `Log: ${log.file}`,
    ...(auditError !== undefined ? [`Error: ${auditError}.`] : []),
    tail.length > 0 ? `--- last ${tail.length} line(s) ---` : "--- no output ---",
    ...tail,
  ];
  return text(lines.join("\n"), record, auditError !== undefined);
}

function recordReview(s: EvidenceSession, params: { taskId: string; disposition: string; reviewer: string; findingsSummary: string }) {
  const route = currentRoute();
  if (route.route === "answer" || route.taskId === undefined) {
    throw new Refusal(`record_review needs the task's small, feature or project route (current route: ${route.route}); declare it with set_route`);
  }
  const taskId = required("taskId", params.taskId, 64);
  if (taskId !== route.taskId) throw new Refusal(`taskId ${taskId} is not the current route's task (${route.taskId})`);
  if (typeof params.disposition !== "string" || !isKnownDisposition(params.disposition)) {
    throw new Refusal(`disposition must be one of ${REVIEW_DISPOSITIONS.join(", ")}`);
  }
  const reviewer = required("reviewer", params.reviewer, 200);
  if (/[\r\n]/.test(reviewer)) throw new Refusal("reviewer must be one line");
  const findingsSummary = required("findingsSummary", params.findingsSummary);
  const root = route.writeRoots[0];
  if (root === undefined) throw new Refusal(`the ${route.route} route has no write root`);
  const fp = fingerprint(root, secretTestFor(root, s));
  const disposition: ReviewDisposition = { taskId, fingerprint: fp, disposition: params.disposition, reviewer, findingsSummary, at: now() };
  try {
    s.ledger.append({ v: 1, ts: now(), runId: s.runId, type: "review", disposition });
  } catch (e) {
    throw new Error(`the review could not be recorded in the run ledger (${(e as Error).message})`);
  }
  return text(`Review of task ${taskId} recorded: ${params.disposition} by ${reviewer} at fingerprint ${fp}. Any later change to the tree invalidates it for delivery.`, disposition);
}

const SOFT: readonly string[] = SOFT_GATES;
const HARD: readonly string[] = HARD_GATES;

function skipRule(autonomy: AutonomyLevel, softened: readonly SoftGateId[]): string {
  if (autonomy === "low") return "autonomy low skips no soft gate";
  if (autonomy === "medium") return `autonomy medium skips only the gates listed in gates.soften (${softened.length > 0 ? softened.join(", ") : "none"})`;
  return "autonomy high skips any soft gate";
}

function recordDecision(s: EvidenceSession, params: { kind: string; gate?: string; justification: string }) {
  const kinds = ["soft-gate-skipped", "soft-gate-resolved", "ruling"];
  if (!kinds.includes(params.kind)) throw new Refusal(`kind must be one of ${kinds.join(", ")}`);
  const justification = required("justification", params.justification);
  const gate = params.gate === undefined ? undefined : required("gate", params.gate, 64);
  if (gate !== undefined && HARD.includes(gate) && params.kind !== "ruling") {
    throw new Refusal(`${gate} is a hard gate: hard gates are never skipped or resolved by a decision, whatever the autonomy level`);
  }
  if (gate !== undefined && !SOFT.includes(gate) && !HARD.includes(gate)) throw new Refusal(`unknown gate ${gate} (soft gates: ${SOFT_GATES.join(", ")})`);
  if (params.kind !== "ruling" && gate === undefined) throw new Refusal(`${params.kind} needs the soft gate id (${SOFT_GATES.join(", ")})`);
  if (params.kind === "soft-gate-skipped" && !autonomyAllowsSkip(gate as SoftGateId, s.autonomy, s.softened)) {
    return text(`record_decision rejected: soft gate ${gate} cannot be skipped at autonomy ${s.autonomy} (${skipRule(s.autonomy, s.softened)}). Resolve the gate with the owner instead.`, undefined, true);
  }
  try {
    s.ledger.append({ v: 1, ts: now(), runId: s.runId, type: "decision", kind: params.kind, ...(gate !== undefined ? { gate } : {}), justification });
  } catch (e) {
    throw new Error(`the decision could not be recorded in the run ledger (${(e as Error).message})`);
  }
  return text(`Decision recorded: ${params.kind}${gate !== undefined ? ` (${gate})` : ""}.`, { kind: params.kind, ...(gate !== undefined ? { gate } : {}) });
}
