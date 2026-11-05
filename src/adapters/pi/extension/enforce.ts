// GatePolicy enforcement in Pi's `tool_call` hook (Phase 2 Task 7). This module turns a tool call into a core
// `ToolAction` with filesystem facts, asks core for the decision, resolves `ask` through the UI (ruling 4),
// audits every decision as one ledger `gate` event, and runs ruling 8's machine-section post-check at
// `tool_result`. It fails closed: any exception (facts, policy context, config, ledger) blocks the call.
import { lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { planCheck } from "../../../core/evidence/check-plan.ts";
import type { RunEvent } from "../../../core/ledger/events.ts";
import { classifyCommandLine, isPathLikeArg } from "../../../core/policy/command.ts";
import { evaluateGate, type GateContext, type GateResult, type ToolAction } from "../../../core/policy/gate.ts";
import type { PathFacts } from "../../../core/policy/paths.ts";
import { summarizeCommand } from "../../../core/policy/redact.ts";
import { INITIAL_ROUTE } from "../../../core/route/route.ts";
import type { RouteState } from "../../../core/route/types.ts";
import { editTouchesMachine, MACHINE_CLOSE, MACHINE_OPEN, parseMachine, touchesMachine, type TextEdit } from "../../../core/task/machine.ts";
import { commandPathFacts, pathFacts, trackedSecretFact } from "./facts.ts";
import type { Reconciler } from "./reconcile.ts";

/** Ruling 4: an unanswered confirm dialog denies after 120 s. */
export const CONFIRM_TIMEOUT_MS = 120_000;
const BLOCK_PREFIX = "Blocked by the factory gate";
const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
/** grep, find and ls search Pi's cwd when no path is given (dist/core/tools/*.js). */
const DEFAULT_CWD_TOOLS: ReadonlySet<string> = new Set(["grep", "find", "ls"]);
/** R30: a command the owner cannot read in full is not offered for approval. */
export const MAX_APPROVAL_CHARS = 4000;
const TASK_FILE_DIRS = [".factory", "knowledge", "tasks"];
/**
 * Task 10: `run_check` runs a command, so the gate decides it exactly as it decides `bash` for the same command line
 * (same facts, hard gates, ask path and answer-route reconciliation), resolved against the directory the check runs in.
 */
export const RUN_CHECK_TOOL = "run_check";

// --- Route state ---------------------------------------------------------------------------------------------
// Task 8 (`set_route`, restore, reclassification) owns transitions; until then every session starts on the
// answer route (read-only), which is what the gate enforces.
let route: RouteState = INITIAL_ROUTE;
export function currentRoute(): RouteState {
  return route;
}
export function setRoute(next: RouteState): void {
  route = next;
}

// --- Tool call → ToolAction -----------------------------------------------------------------------------------

export interface ToolCallLike {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: Record<string, unknown>;
}

export interface ActionFacts {
  /** The tool's cwd (Pi's `ctx.cwd`). */
  cwd: string;
  /** `os.homedir()` unmodified: Pi expands `~` with it (facts.ts). */
  home: string;
  /** Project-declared runners, tokenized (Task 10); they must match the gate's context. */
  projectCommands: string[][];
  /**
   * Tool names this extension registered itself (review M2). A factory tool name from anyone else (another
   * extension, an MCP bridge) is `unknown`.
   */
  factoryTools?: ReadonlySet<string>;
  /** `run_check`: where the command runs (default `cwd`) and the task file whose machine section it must not change. */
  runCheck?: RunCheckFacts;
  /** The gate context's Pi agent dir, for the R41 tracked-secret fact (default `<home>/.pi/agent`). */
  piAgentDir?: string;
}

export interface RunCheckFacts {
  /** The route's write root, or the project root on the answer route (`runCheckFacts`). */
  cwd: string;
  /** Feature/project: `<worktree>/.factory/knowledge/tasks/<taskId>.md` (ruling 8 post-check after the check). */
  taskFile?: string;
}

/** Where `run_check` runs for the gate context's route, and the task file it protects. */
export function runCheckFacts(ctx: Pick<GateContext, "route" | "projectRoot">): RunCheckFacts {
  const { route } = ctx;
  const cwd = route.writeRoots[0] ?? ctx.projectRoot;
  const tiered = (route.route === "feature" || route.route === "project") && route.worktree !== undefined && route.taskId !== undefined;
  return tiered ? { cwd, taskFile: join(route.worktree!, ...TASK_FILE_DIRS, `${route.taskId!}.md`) } : { cwd };
}

/** The pre-call copy of a file whose machine section the post-check protects. */
export interface MachineCopy {
  /** Realpath of the file at call time (a symlinked path is repaired at its target). */
  file: string;
  input: string;
  /** Content before the call; undefined when the file did not exist. */
  before: string | undefined;
}

export interface PreparedAction {
  action: ToolAction;
  /** Redacted, truncated one-line description for the ledger (ruling 15). */
  summary: string;
  /** The full, unredacted action for the owner's approval dialog (R30): command text with its newlines. */
  display: string;
  /** Set for write/edit on a task file or on a file that holds machine markers (ruling 8 post-check). */
  machine?: MachineCopy;
  /** `run_check`: the command and the directory it runs in, cleared for execution once the gate allows it. */
  runCheck?: ClearedCheck;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** `.factory/knowledge/tasks/<x>.md` at the end of `resolved` (any root, case-insensitive). */
function isTaskFilePath(resolved: string): boolean {
  const segs = resolved.split(/[\\/]+/).filter((s) => s !== "");
  if (segs.length < 4) return false;
  const tail = segs.slice(-4).map((s) => s.toLowerCase());
  return TASK_FILE_DIRS.every((d, i) => tail[i] === d) && tail[3]!.endsWith(".md");
}

type Read = { kind: "missing" } | { kind: "text"; text: string } | { kind: "error" };

function readTarget(resolved: string): Read {
  if (resolved === "") return { kind: "error" };
  try {
    return { kind: "text", text: readFileSync(resolved, "utf8") };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "error" };
  }
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Pi's edit input after `prepareArguments`; legacy single-edit shapes are accepted defensively. */
function editsOf(input: Record<string, unknown>): TextEdit[] | undefined {
  const raw = input.edits;
  const list: unknown[] = Array.isArray(raw) ? [...raw] : raw !== undefined ? [raw] : [];
  if (typeof input.oldText === "string" || typeof input.newText === "string") list.push({ oldText: input.oldText, newText: input.newText });
  const edits: TextEdit[] = [];
  for (const e of list) {
    const o = e as { oldText?: unknown; newText?: unknown } | null;
    if (typeof o?.oldText !== "string" || typeof o.newText !== "string") return undefined;
    edits.push({ oldText: o.oldText, newText: o.newText });
  }
  return edits.length > 0 ? edits : undefined;
}

function writeAction(ev: ToolCallLike, tool: "write" | "edit", f: ActionFacts): PreparedAction {
  const p = str(ev.input.path);
  const content = str(ev.input.content);
  const edits = tool === "edit" ? editsOf(ev.input) : undefined;
  if (p === undefined || (tool === "write" && content === undefined) || (tool === "edit" && edits === undefined)) {
    return malformed(ev, tool);
  }
  const fact = pathFacts(p, f.cwd, f.home);
  const targetExists = fact.resolved !== "" && exists(fact.resolved);
  const cur = readTarget(fact.resolved);
  const currentText = cur.kind === "text" ? cur.text : "";
  const hasMarkers = currentText.includes(MACHINE_OPEN) || currentText.includes(MACHINE_CLOSE);
  const protectedFile = isTaskFilePath(fact.resolved) || hasMarkers;
  let touches = false;
  if (protectedFile) {
    // An unreadable existing file cannot be checked: fail closed.
    if (cur.kind === "error") touches = true;
    else if (tool === "write") touches = touchesMachine(currentText, content!);
    else touches = editTouchesMachine(currentText, edits!);
  }
  const summary = summarizeCommand(tool === "edit" ? `edit ${p} (${edits!.length} replacement(s))` : `write ${p}`);
  // N3: the owner approves what is written, not only where.
  const display =
    tool === "edit"
      ? [`edit ${p}`, ...edits!.flatMap((e, i) => [`--- replacement ${i + 1}: old text ---`, e.oldText, `--- replacement ${i + 1}: new text ---`, e.newText])].join("\n")
      : [`write ${p}`, "--- content ---", content!].join("\n");
  const action: ToolAction = { kind: "write", tool, path: fact, touchesMachineSection: touches, targetExists };
  if (!protectedFile || cur.kind === "error") return { action, summary, display };
  return { action, summary, display, machine: { file: fact.resolved, input: p, before: cur.kind === "text" ? cur.text : undefined } };
}

function commandAction(ev: ToolCallLike, tool: "bash" | "powershell", f: ActionFacts): PreparedAction {
  const command = str(ev.input.command);
  if (command === undefined) return malformed(ev, tool);
  const summary = summarizeCommand(command);
  const display = command;
  // Ruling 3: PowerShell is not classified in Phase 2; the gate asks without facts.
  if (tool === "powershell") return { action: { kind: "command", tool, command, pathFacts: [] }, summary, display };
  const c = classifyCommandLine(command, { projectCommands: f.projectCommands });
  // Gate contract (gate.ts ToolAction "command"): every pathArg and inputPath, and every readArg that is
  // path-like or exists relative to the cwd. commandPathFacts may return several facts per argument (win32).
  const args: string[] = [];
  const add = (a: string) => {
    if (!args.includes(a)) args.push(a);
  };
  for (const a of c.pathArgs) add(a);
  for (const a of c.inputPaths) add(a);
  for (const seg of c.segments) for (const a of seg.absentPaths ?? []) add(a);
  for (const a of c.readArgs) if (isPathLikeArg(a) || exists(path.resolve(f.cwd, a))) add(a);
  const facts: PathFacts[] = args.flatMap((a) => commandPathFacts(a, f.cwd, f.home));
  const action: ToolAction = { kind: "command", tool, command, pathFacts: facts };
  // R41: only content-printing git commands need the tracked-secret fact (one `git ls-files` per call).
  if (c.trackedContent) {
    const tracked = trackedSecretFact(f.cwd, f.home, f.piAgentDir ?? path.join(f.home, ".pi", "agent"));
    if (tracked !== undefined) action.trackedSecret = tracked;
  }
  return { action, summary, display };
}

/** The pre-call copy of the route's task file for the ruling-8 post-check; undefined when it cannot be read. */
function taskFileCopy(taskFile: string, cwd: string, home: string): MachineCopy | undefined {
  const fact = pathFacts(taskFile, cwd, home);
  const cur = readTarget(fact.resolved);
  return cur.kind === "error" ? undefined : { file: fact.resolved, input: taskFile, before: cur.kind === "text" ? cur.text : undefined };
}

/**
 * `run_check` is gated as the `bash` command it runs (Task 10, decision 1), with facts resolved in the directory it
 * runs in. A check can rewrite the task file through project code the gate cannot see, so its machine section gets
 * the ruling-8 post-check like a write.
 */
function runCheckAction(ev: ToolCallLike, f: ActionFacts): PreparedAction {
  const rc = f.runCheck ?? { cwd: f.cwd };
  const prepared = commandAction(ev, "bash", { ...f, cwd: rc.cwd });
  const command = str(ev.input.command);
  if (prepared.action.kind !== "command" || command === undefined) return prepared;
  const display = `run_check in ${rc.cwd}:\n${prepared.display}`;
  const machine = rc.taskFile !== undefined ? taskFileCopy(rc.taskFile, rc.cwd, f.home) : undefined;
  return { ...prepared, display, runCheck: { command, cwd: rc.cwd }, ...(machine !== undefined ? { machine } : {}) };
}

function rawInput(ev: ToolCallLike): string {
  try {
    return JSON.stringify(ev.input, null, 2) ?? "";
  } catch {
    return "(unserializable input)";
  }
}

function malformed(ev: ToolCallLike, tool: string): PreparedAction {
  const display = `${tool} (malformed input) ${rawInput(ev)}`;
  return { action: { kind: "unknown", tool }, summary: summarizeCommand(display), display };
}

export function prepareAction(ev: ToolCallLike, f: ActionFacts): PreparedAction {
  const tool = ev.toolName;
  if (f.factoryTools?.has(tool) === true) {
    if (tool === RUN_CHECK_TOOL) return runCheckAction(ev, f);
    const display = `${tool} ${rawInput(ev)}`;
    return { action: { kind: "factory", tool }, summary: summarizeCommand(display), display };
  }
  if (tool === "write" || tool === "edit") return writeAction(ev, tool, f);
  if (tool === "bash" || tool === "powershell") return commandAction(ev, tool, f);
  if (READ_TOOLS.has(tool)) {
    const given = ev.input.path;
    if (given !== undefined && typeof given !== "string") return malformed(ev, tool);
    const p = given ?? (DEFAULT_CWD_TOOLS.has(tool) ? "." : undefined);
    if (p === undefined) return malformed(ev, tool);
    const fact = pathFacts(p, f.cwd, f.home, tool === "read" ? { read: true } : {});
    const pattern = str(ev.input.pattern);
    const display = `${tool} ${pattern !== undefined ? `${pattern} ` : ""}${p}`;
    return { action: { kind: "read", tool, path: fact }, summary: summarizeCommand(display), display };
  }
  const display = `${tool} ${rawInput(ev)}`;
  return { action: { kind: "unknown", tool }, summary: summarizeCommand(display), display };
}

export function toToolAction(ev: ToolCallLike, f: ActionFacts): ToolAction {
  return prepareAction(ev, f).action;
}

// --- Machine-section post-check (ruling 8) --------------------------------------------------------------------

export interface LedgerSink {
  append(e: RunEvent): void;
}

type ResultLike = Pick<ToolResultEvent, "toolCallId" | "content" | "isError"> & { structuredContent?: ToolResultEvent["structuredContent"] };

/** Atomic replace (temp file in the same directory, then rename), keeping the file's mode. */
export function atomicWrite(file: string, text: string, tag = "restore"): void {
  let mode: number | undefined;
  try {
    mode = statSync(file).mode & 0o7777;
  } catch {
    mode = undefined;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.factory-${tag}-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, text, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    renameSync(tmp, file);
  } catch (e) {
    // Review M2: never leave the temp file behind (a later checkpoint would commit it).
    try {
      unlinkSync(tmp);
    } catch {
      // Not created, or already renamed.
    }
    throw e;
  }
}

/**
 * The pre-call text with only the machine block put back: the after-call block replaced by the pre-call block
 * when both are valid single blocks, else the whole pre-call file (the block cannot be located safely).
 */
function repaired(before: string, after: string | undefined): { text: string; whole: boolean } {
  const b = parseMachine(before);
  const a = after === undefined ? undefined : parseMachine(after);
  if (after !== undefined && b && !("invalid" in b) && a && !("invalid" in a)) {
    const text = after.slice(0, a.start) + before.slice(b.start, b.end) + after.slice(a.end);
    if (!touchesMachine(before, text)) return { text, whole: false };
  }
  return { text: before, whole: true };
}

const fileKey = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file);

/**
 * The text whose machine block the post-check expects (carry-forward Task 9): the pre-call copy, unless extension
 * code (`task_progress`) wrote the file after the copy was taken; then the block the extension wrote, spliced into
 * the pre-call text when both blocks are valid (else the extension's text).
 */
function expectedText(before: string | undefined, written: string | undefined): string | undefined {
  if (written === undefined) return before;
  if (before === undefined) return written;
  const b = parseMachine(before);
  const w = parseMachine(written);
  if (b && !("invalid" in b) && w && !("invalid" in w)) return before.slice(0, b.start) + written.slice(w.start, w.end) + before.slice(b.end);
  return written;
}

export class MachinePostChecks {
  private readonly pending = new Map<string, MachineCopy & { seq: number }>();
  /** realpath (case-folded on win32) → the last text extension code wrote there, with its sequence number. */
  private readonly written = new Map<string, { text: string; seq: number }>();
  private seq = 0;

  remember(toolCallId: string, copy: MachineCopy): void {
    this.pending.set(toolCallId, { ...copy, seq: ++this.seq });
  }

  /** Extension code wrote `text` to `file` (realpath): its machine block is the expected state from now on. */
  recordWrite(file: string, text: string): void {
    this.written.set(fileKey(file), { text, seq: ++this.seq });
  }

  get size(): number {
    return this.pending.size;
  }

  /** Review M4: entries whose `tool_result` never fires (another extension blocked the call) are dropped here. */
  clear(): void {
    this.pending.clear();
    this.written.clear();
  }

  /**
   * Ruling 8 post-check: re-reads the file of an allowed write/edit; if its machine block changed, restores it
   * from the pre-call copy (byte-for-byte), audits an `error` event and appends a note to the tool result.
   */
  afterToolResult(ev: ResultLike, ledger: LedgerSink, runId: string): ToolResultEventResult | undefined {
    const copy = this.pending.get(ev.toolCallId);
    if (copy === undefined) return undefined;
    this.pending.delete(ev.toolCallId);
    const now = readTarget(copy.file);
    const after = now.kind === "text" ? now.text : undefined;
    const ext = this.written.get(fileKey(copy.file));
    const expected = expectedText(copy.before, ext !== undefined && ext.seq > copy.seq ? ext.text : undefined);
    const before = expected ?? "";
    if (now.kind === "error") {
      return this.note(ev, ledger, runId, `could not re-read ${copy.input} to verify its machine-owned section; check it before continuing`);
    }
    if (!touchesMachine(before, after ?? "")) return undefined;
    let message: string;
    try {
      if (expected === undefined) {
        // The file did not exist before the call: a machine block in it is not the model's to write.
        const p = after === undefined ? undefined : parseMachine(after);
        const text = after !== undefined && p && !("invalid" in p) ? after.slice(0, p.start) + after.slice(p.end) : "";
        atomicWrite(copy.file, text);
        message = `the machine-owned section that this call added to ${copy.input} was removed (only extension code writes it)`;
      } else {
        const r = repaired(expected, after);
        atomicWrite(copy.file, r.text);
        message = r.whole
          ? `this call changed the machine-owned section of ${copy.input}; the file was restored to its content before the call (only extension code writes that section)`
          : `this call changed the machine-owned section of ${copy.input}; the section was restored (only extension code writes it), the rest of the change was kept`;
      }
    } catch (e) {
      message = `this call changed the machine-owned section of ${copy.input} and restoring it failed (${(e as Error).message}); check it before continuing`;
    }
    return this.note(ev, ledger, runId, message);
  }

  private note(ev: ResultLike, ledger: LedgerSink, runId: string, message: string): ToolResultEventResult {
    try {
      ledger.append({ v: 1, ts: new Date().toISOString(), runId, type: "error", where: "machine-section", message });
    } catch {
      // The note still reaches the model; the ledger failure itself cannot be audited.
    }
    const content = [...ev.content, { type: "text" as const, text: `\n[factory] ${message}` }];
    return { content, ...(ev.structuredContent !== undefined ? { structuredContent: ev.structuredContent } : {}) };
  }
}

// --- enforce ---------------------------------------------------------------------------------------------------

export interface GateUi {
  confirm(title: string, message: string): Promise<boolean>;
}

/**
 * R31 (amended): every allowed call, with whether it may change the filesystem, from its decision until its result.
 * Pi's default parallel tool execution runs every `tool_call` hook of a batch before executing any call, so facts
 * of one call could predate another call's effects. Within a group (the top-level calls, or the nested calls of
 * one running parent), a call is denied while a mutating call is in flight, and a mutating call is denied while
 * any call is in flight. A nested call is also checked against its ancestors' groups, the ancestors excluded.
 * Sequential execution is unaffected (`tool_result` fires before the next `tool_call`).
 */
export class InFlightCalls {
  private static readonly TOP = "";
  /** group key (TOP or a parent's toolCallId) → (toolCallId → may mutate). */
  private readonly groups = new Map<string, Map<string, boolean>>();
  private readonly groupOf = new Map<string, string>();

  /** The group a call with this parent joins: the parent's when the parent is in flight, else the top level. */
  groupFor(parentToolCallId: string | undefined): string {
    return parentToolCallId !== undefined && this.groupOf.has(parentToolCallId) ? parentToolCallId : InFlightCalls.TOP;
  }

  /** Why a call joining `group` must wait, or undefined. */
  conflict(group: string, mutating: boolean): string | undefined {
    let key = group;
    let exclude: string | undefined;
    for (;;) {
      for (const [id, m] of this.groups.get(key) ?? []) {
        if (id === exclude) continue;
        if (m) return "another call that may change files is still running";
        if (mutating) return "this call may change files while other calls are still running";
      }
      if (key === InFlightCalls.TOP) return undefined;
      exclude = key;
      key = this.groupOf.get(key) ?? InFlightCalls.TOP;
    }
  }

  add(toolCallId: string, group: string, mutating: boolean): void {
    let g = this.groups.get(group);
    if (g === undefined) this.groups.set(group, (g = new Map()));
    g.set(toolCallId, mutating);
    this.groupOf.set(toolCallId, group);
  }

  /** Called at `tool_result` and `tool_execution_end`; also drops the call's own nested calls. */
  done(toolCallId: string): void {
    const group = this.groupOf.get(toolCallId);
    if (group !== undefined) {
      this.groups.get(group)?.delete(toolCallId);
      this.groupOf.delete(toolCallId);
    }
    const nested = this.groups.get(toolCallId);
    if (nested !== undefined) {
      this.groups.delete(toolCallId);
      for (const id of [...nested.keys()]) {
        this.groupOf.delete(id);
        this.done(id);
      }
    }
  }

  has(toolCallId: string): boolean {
    return this.groupOf.has(toolCallId);
  }

  get size(): number {
    return this.groupOf.size;
  }

  /** Backstop at `agent_settled` / `session_shutdown`. */
  clear(): void {
    this.groups.clear();
    this.groupOf.clear();
  }
}

/**
 * Task 10: `run_check` calls the gate allowed, by toolCallId, with the exact command and cwd. The tool runs only a
 * call found here (consumed once), so a `run_check` that did not pass through this hook, or whose input changed
 * after it, never runs.
 */
export interface ClearedCheck {
  command: string;
  cwd: string;
  /**
   * Task 11: the check is an answer-route runner the gate reconciles; its fingerprints must not write git objects
   * into the user's repository (data-safety rule), so they use a temporary object directory.
   */
  reconciled?: boolean;
}

export class GatedChecks {
  private readonly cleared = new Map<string, ClearedCheck>();

  clear(): void {
    this.cleared.clear();
  }

  approve(toolCallId: string, check: ClearedCheck): void {
    this.cleared.set(toolCallId, { ...check });
  }

  /** The cleared check for this call, removed; undefined when the gate did not allow it. */
  take(toolCallId: string): ClearedCheck | undefined {
    const c = this.cleared.get(toolCallId);
    this.cleared.delete(toolCallId);
    return c;
  }

  get size(): number {
    return this.cleared.size;
  }
}

export interface EnforceDeps {
  /** Built per call: route, mode and facts can change between calls. May throw (config error → deny). */
  policyContext(): GateContext;
  ledger: LedgerSink;
  runId: string;
  /** `os.homedir()` unmodified (see ActionFacts.home). */
  home: string;
  postChecks: MachinePostChecks;
  inFlight: InFlightCalls;
  /** Tool names this extension registered (review M2). */
  factoryTools: ReadonlySet<string>;
  /** Present only when Pi has a dialog-capable UI (`ctx.hasUI`); otherwise `ask` denies (ruling 4). */
  ui?: GateUi;
  /** Task 10: where allowed `run_check` calls are cleared for execution. Without it no `run_check` can run. */
  gatedChecks?: GatedChecks;
  /**
   * Task 11: snapshots of answer-route runner calls (`reconcile: true`), reconciled at their `tool_result`. Without
   * it such a call is denied (fail closed).
   */
  reconciler?: Reconciler;
}

export type BlockResult = { block: true; reason: string };

function confirmWithTimeout(ui: GateUi, title: string, message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS);
    timer.unref?.();
    // Review M3: a synchronous throw from confirm resolves to false like a rejection.
    Promise.resolve()
      .then(() => ui.confirm(title, message))
      .then(
        (ok) => {
          clearTimeout(timer);
          resolve(ok === true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
  });
}

interface Outcome {
  decision: "allow" | "deny" | "allow (approved)" | "deny (rejected)";
  reason: string;
  block?: string;
}

const deny = (reason: string): Outcome => ({ decision: "deny", reason, block: `${BLOCK_PREFIX}: ${reason}` });

/** Control, format (bidi, zero-width) and non-space separator characters other than space, tab and newline. */
const HIDDEN = /[^\S \t\n]|[\p{C}]/gu;

/** R33/N3: every character a terminal could hide or reinterpret becomes a visible `\u{…}` escape. */
export function visible(text: string): { text: string; escaped: boolean } {
  let escaped = false;
  const out = text.replace(HIDDEN, (ch) => {
    if (ch === " " || ch === "\t" || ch === "\n") return ch;
    escaped = true;
    return `\\u{${ch.codePointAt(0)!.toString(16)}}`;
  });
  return { text: out, escaped };
}

async function resolveAsk(r: GateResult, tool: string, display: string, ui: GateUi | undefined): Promise<Outcome> {
  const label = r.hardGate ?? r.class ?? "unclassified";
  if (ui === undefined) return deny(`requires human approval (${label}): ${r.reason}`);
  // R30: the owner approves exactly what runs: the full, unredacted text with its newlines, or nothing. The cap
  // applies to the text as shown (after escaping).
  const shown = visible(display);
  if (shown.text.length > MAX_APPROVAL_CHARS) {
    return deny(`too long to approve safely (${shown.text.length} > ${MAX_APPROVAL_CHARS} characters; ${label}): ${r.reason}`);
  }
  const message = [
    `Tool: ${tool}`,
    `Reason: ${r.reason}`,
    "",
    "Action (exactly as it will run):",
    shown.text,
    ...(shown.escaped ? ["", "Warning: control or invisible characters are shown as \\u{…} escapes."] : []),
    "",
    "Allow this call?",
  ].join("\n");
  const ok = await confirmWithTimeout(ui, `Factory gate: ${label}`, message);
  if (ok) return { decision: "allow (approved)", reason: `approved by the user: ${r.reason}` };
  const reason = `rejected by the user or not answered within ${CONFIRM_TIMEOUT_MS / 1000} s (${label}): ${r.reason}`;
  return { decision: "deny (rejected)", reason, block: `${BLOCK_PREFIX}: ${reason}` };
}

/** Factory tools that change files or git state (Task 9: the task file, checkpoint commits and undo refs). */
const MUTATING_FACTORY_TOOLS: ReadonlySet<string> = new Set(["task_progress"]);

/** R31: write, edit, powershell, unknown tools, mutating factory tools and every bash command that is not read-only. */
function mayMutate(action: ToolAction, r: GateResult): boolean {
  switch (action.kind) {
    case "write":
    case "unknown":
      return true;
    case "factory":
      return MUTATING_FACTORY_TOOLS.has(action.tool);
    case "command":
      return action.tool === "powershell" || r.class !== "read-only";
    default:
      return false;
  }
}

/**
 * Evaluates one tool call against the GatePolicy and returns Pi's block result for a deny. Every decision,
 * allow included, appends exactly one `gate` event; when that append fails the call is blocked (no unaudited
 * effects).
 */
export async function enforce(ev: ToolCallLike, ctx: { cwd: string }, deps: EnforceDeps): Promise<BlockResult | undefined> {
  let summary = summarizeCommand(ev.toolName);
  let r: GateResult;
  let prepared: PreparedAction | undefined;
  const group = deps.inFlight.groupFor(ev.parentToolCallId);
  let mutating = true;
  let taskFile: string | undefined;
  /** Task 11: the work tree an allowed answer-route runner is reconciled in. */
  let reconcileRoot: string | undefined;
  try {
    const policy = deps.policyContext();
    taskFile = runCheckFacts(policy).taskFile;
    prepared = prepareAction(ev, {
      cwd: ctx.cwd,
      home: deps.home,
      projectCommands: policy.projectCommands,
      factoryTools: deps.factoryTools,
      runCheck: runCheckFacts(policy),
      piAgentDir: policy.piAgentDir,
    });
    summary = prepared.summary;
    r = evaluateGate(prepared.action, policy);
    if (prepared.runCheck !== undefined && r.decision !== "deny") {
      // Denied before any ask: the owner is never asked about a command run_check would refuse to run.
      const plan = planCheck(prepared.runCheck.command, policy.projectCommands);
      if (!plan.ok) r = { ...r, decision: "deny", reason: plan.error, reconcile: false };
    }
    // Decision 1: run_check writes a log and takes fingerprints; it is a writing call for R31 whatever it runs.
    mutating = prepared.runCheck !== undefined || mayMutate(prepared.action, r);
    // R31: decided before any ask, so the owner is never asked about a call that would race another one.
    const busy = r.decision === "deny" ? undefined : deps.inFlight.conflict(group, mutating);
    if (busy !== undefined) {
      r = { ...r, decision: "deny", reason: `${busy}: re-issue this call after the previous call finishes (R31)`, reconcile: false };
    } else if (r.decision !== "deny" && r.reconcile) {
      // Ruling 5: answer-route runners run only with reconciliation (Task 11, replacing the R29 deny).
      if (deps.reconciler === undefined) {
        r = { ...r, decision: "deny", reason: "answer-route runner reconciliation is not available in this session (fail closed): declare a change route with set_route", reconcile: false };
      } else {
        reconcileRoot = prepared.runCheck?.cwd ?? policy.projectRoot;
      }
    }
  } catch (e) {
    r = { decision: "deny", reason: `policy error (fail closed): ${(e as Error).message}`, reconcile: false };
    prepared = undefined;
  }

  // R31 (R2-1): reserve the slot before any dialog, so a sibling call arriving while the owner decides is denied.
  const reserved = r.decision !== "deny" && prepared !== undefined;
  if (reserved) deps.inFlight.add(ev.toolCallId, group, mutating);
  const block = (reason: string): BlockResult => {
    if (reserved) deps.inFlight.done(ev.toolCallId);
    return { block: true, reason };
  };

  let outcome: Outcome;
  try {
    outcome =
      r.decision === "ask"
        ? await resolveAsk(r, ev.toolName, prepared?.display ?? ev.toolName, deps.ui)
        : r.decision === "allow"
          ? { decision: "allow", reason: r.reason }
          : deny(r.reason);
  } catch (e) {
    outcome = deny(`approval failed (fail closed): ${(e as Error).message}`);
  }

  // Task 11 (R38): the snapshot is taken before the decision is audited, so a call without a valid snapshot is
  // recorded (and blocked) as a deny.
  let snapshotTaken = false;
  if (outcome.block === undefined && reconcileRoot !== undefined && deps.reconciler !== undefined) {
    try {
      deps.reconciler.begin(ev.toolCallId, ev.parentToolCallId, reconcileRoot);
      snapshotTaken = true;
    } catch (e) {
      outcome = deny(`answer-route runner refused: ${(e as Error).message} (no valid snapshot to reconcile it, fail closed)`);
    }
  }

  try {
    deps.ledger.append({
      v: 1,
      ts: new Date().toISOString(),
      runId: deps.runId,
      type: "gate",
      tool: ev.toolName,
      toolCallId: ev.toolCallId,
      ...(ev.parentToolCallId !== undefined ? { parentToolCallId: ev.parentToolCallId } : {}),
      decision: outcome.decision,
      ...(r.class !== undefined ? { class: r.class } : {}),
      ...(r.hardGate !== undefined ? { hardGate: r.hardGate } : {}),
      reason: outcome.reason,
      summary,
    });
  } catch (e) {
    if (snapshotTaken) deps.reconciler?.discard(ev.toolCallId);
    return block(`${BLOCK_PREFIX}: the audit ledger could not be written (fail closed): ${(e as Error).message}`);
  }

  if (outcome.block !== undefined || prepared === undefined) return block(outcome.block ?? `${BLOCK_PREFIX}: ${outcome.reason}`);
  if (prepared.machine !== undefined) {
    deps.postChecks.remember(ev.toolCallId, prepared.machine);
  } else if (prepared.action.kind === "command" && mutating && taskFile !== undefined) {
    // M6: project code a command runs (an allowlisted or declared runner) can rewrite the task file too.
    const copy = taskFileCopy(taskFile, ctx.cwd, deps.home);
    if (copy !== undefined) deps.postChecks.remember(ev.toolCallId, copy);
  }
  if (prepared.runCheck !== undefined) deps.gatedChecks?.approve(ev.toolCallId, { ...prepared.runCheck, ...(snapshotTaken ? { reconciled: true } : {}) });
  return undefined;
}
