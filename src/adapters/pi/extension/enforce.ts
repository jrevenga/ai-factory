// GatePolicy enforcement in Pi's `tool_call` hook (Phase 2 Task 7). This module turns a tool call into a core
// `ToolAction` with filesystem facts, asks core for the decision, resolves `ask` through the UI (ruling 4),
// audits every decision as one ledger `gate` event, and runs ruling 8's machine-section post-check at
// `tool_result`. It fails closed: any exception (facts, policy context, config, ledger) blocks the call.
import { lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { RunEvent } from "../../../core/ledger/events.ts";
import { classifyCommandLine, isPathLikeArg } from "../../../core/policy/command.ts";
import { evaluateGate, type GateContext, type GateResult, type ToolAction } from "../../../core/policy/gate.ts";
import type { PathFacts } from "../../../core/policy/paths.ts";
import { summarizeCommand } from "../../../core/policy/redact.ts";
import { INITIAL_ROUTE } from "../../../core/route/route.ts";
import type { RouteState } from "../../../core/route/types.ts";
import { editTouchesMachine, MACHINE_CLOSE, MACHINE_OPEN, parseMachine, touchesMachine, type TextEdit } from "../../../core/task/machine.ts";
import { commandPathFacts, pathFacts } from "./facts.ts";

/** Ruling 4: an unanswered confirm dialog denies after 120 s. */
export const CONFIRM_TIMEOUT_MS = 120_000;
const BLOCK_PREFIX = "Blocked by the factory gate";
const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
/** grep, find and ls search Pi's cwd when no path is given (dist/core/tools/*.js). */
const DEFAULT_CWD_TOOLS: ReadonlySet<string> = new Set(["grep", "find", "ls"]);
const FACTORY_TOOLS: ReadonlySet<string> = new Set(["set_route", "task_progress", "run_check", "record_decision", "record_review"]);
const TASK_FILE_DIRS = [".factory", "knowledge", "tasks"];

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
  /** Redacted, truncated one-line description for the ledger and the confirm dialog. */
  summary: string;
  /** Set for write/edit on a task file or on a file that holds machine markers (ruling 8 post-check). */
  machine?: MachineCopy;
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
    return { action: { kind: "unknown", tool }, summary: summarizeCommand(`${tool} (malformed input)`) };
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
  const action: ToolAction = { kind: "write", tool, path: fact, touchesMachineSection: touches, targetExists };
  if (!protectedFile || cur.kind === "error") return { action, summary };
  return { action, summary, machine: { file: fact.resolved, input: p, before: cur.kind === "text" ? cur.text : undefined } };
}

function commandAction(ev: ToolCallLike, tool: "bash" | "powershell", f: ActionFacts): PreparedAction {
  const command = str(ev.input.command);
  if (command === undefined) return { action: { kind: "unknown", tool }, summary: summarizeCommand(`${tool} (malformed input)`) };
  const summary = summarizeCommand(command);
  // Ruling 3: PowerShell is not classified in Phase 2; the gate asks without facts.
  if (tool === "powershell") return { action: { kind: "command", tool, command, pathFacts: [] }, summary };
  const c = classifyCommandLine(command, { projectCommands: f.projectCommands });
  // Gate contract (gate.ts ToolAction "command"): every pathArg and inputPath, and every readArg that is
  // path-like or exists relative to the cwd. commandPathFacts may return several facts per argument (win32).
  const args: string[] = [];
  const add = (a: string) => {
    if (!args.includes(a)) args.push(a);
  };
  for (const a of c.pathArgs) add(a);
  for (const a of c.inputPaths) add(a);
  for (const a of c.readArgs) if (isPathLikeArg(a) || exists(path.resolve(f.cwd, a))) add(a);
  const facts: PathFacts[] = args.flatMap((a) => commandPathFacts(a, f.cwd, f.home));
  return { action: { kind: "command", tool, command, pathFacts: facts }, summary };
}

export function prepareAction(ev: ToolCallLike, f: ActionFacts): PreparedAction {
  const tool = ev.toolName;
  if (FACTORY_TOOLS.has(tool)) return { action: { kind: "factory", tool }, summary: summarizeCommand(`${tool} ${JSON.stringify(ev.input)}`) };
  if (tool === "write" || tool === "edit") return writeAction(ev, tool, f);
  if (tool === "bash" || tool === "powershell") return commandAction(ev, tool, f);
  if (READ_TOOLS.has(tool)) {
    const given = ev.input.path;
    if (given !== undefined && typeof given !== "string") return { action: { kind: "unknown", tool }, summary: `${tool} (malformed input)` };
    const p = given ?? (DEFAULT_CWD_TOOLS.has(tool) ? "." : undefined);
    if (p === undefined) return { action: { kind: "unknown", tool }, summary: `${tool} (malformed input)` };
    const fact = pathFacts(p, f.cwd, f.home, tool === "read" ? { read: true } : {});
    const pattern = str(ev.input.pattern);
    return { action: { kind: "read", tool, path: fact }, summary: summarizeCommand(`${tool} ${pattern !== undefined ? `${pattern} ` : ""}${p}`) };
  }
  let input: string;
  try {
    input = JSON.stringify(ev.input) ?? "";
  } catch {
    input = "(unserializable input)";
  }
  return { action: { kind: "unknown", tool }, summary: summarizeCommand(`${tool} ${input}`) };
}

export function toToolAction(ev: ToolCallLike, f: ActionFacts): ToolAction {
  return prepareAction(ev, f).action;
}

// --- Machine-section post-check (ruling 8) --------------------------------------------------------------------

export interface LedgerSink {
  append(e: RunEvent): void;
}

type ResultLike = Pick<ToolResultEvent, "toolCallId" | "content" | "isError"> & { structuredContent?: ToolResultEvent["structuredContent"] };

/** Atomic replace in the file's directory, keeping its mode. */
function atomicWrite(file: string, text: string): void {
  let mode: number | undefined;
  try {
    mode = statSync(file).mode & 0o7777;
  } catch {
    mode = undefined;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.factory-restore-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, text, mode === undefined ? {} : { mode });
  renameSync(tmp, file);
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

export class MachinePostChecks {
  private readonly pending = new Map<string, MachineCopy>();

  remember(toolCallId: string, copy: MachineCopy): void {
    this.pending.set(toolCallId, copy);
  }

  get size(): number {
    return this.pending.size;
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
    const before = copy.before ?? "";
    if (now.kind === "error") {
      return this.note(ev, ledger, runId, `could not re-read ${copy.input} to verify its machine-owned section; check it before continuing`);
    }
    if (!touchesMachine(before, after ?? "")) return undefined;
    let message: string;
    try {
      if (copy.before === undefined) {
        // The file did not exist before the call: a machine block in it is not the model's to write.
        const p = after === undefined ? undefined : parseMachine(after);
        const text = after !== undefined && p && !("invalid" in p) ? after.slice(0, p.start) + after.slice(p.end) : "";
        atomicWrite(copy.file, text);
        message = `the machine-owned section that this call added to ${copy.input} was removed (only extension code writes it)`;
      } else {
        const r = repaired(copy.before, after);
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

export interface EnforceDeps {
  /** Built per call: route, mode and facts can change between calls. May throw (config error → deny). */
  policyContext(): GateContext;
  ledger: LedgerSink;
  runId: string;
  /** `os.homedir()` unmodified (see ActionFacts.home). */
  home: string;
  postChecks: MachinePostChecks;
  /** Present only when Pi has a dialog-capable UI (`ctx.hasUI`); otherwise `ask` denies (ruling 4). */
  ui?: GateUi;
}

export type BlockResult = { block: true; reason: string };

function confirmWithTimeout(ui: GateUi, title: string, message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS);
    timer.unref?.();
    ui.confirm(title, message).then(
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

async function resolveAsk(r: GateResult, tool: string, summary: string, ui: GateUi | undefined): Promise<Outcome> {
  const label = r.hardGate ?? r.class ?? "unclassified";
  if (ui === undefined) {
    const reason = `requires human approval (${label}): ${r.reason}`;
    return { decision: "deny", reason, block: `${BLOCK_PREFIX}: ${reason}` };
  }
  const message = [`Tool: ${tool}`, `Action: ${summary}`, `Reason: ${r.reason}`, "", "Allow this call?"].join("\n");
  const ok = await confirmWithTimeout(ui, `Factory gate: ${label}`, message);
  if (ok) return { decision: "allow (approved)", reason: `approved by the user: ${r.reason}` };
  const reason = `rejected by the user or not answered within ${CONFIRM_TIMEOUT_MS / 1000} s (${label}): ${r.reason}`;
  return { decision: "deny (rejected)", reason, block: `${BLOCK_PREFIX}: ${reason}` };
}

/**
 * Evaluates one tool call against the GatePolicy and returns Pi's block result for a deny. Every decision,
 * allow included, appends exactly one `gate` event; when that append fails the call is blocked (no unaudited
 * effects). The answer-route runner reconciliation (Task 11) hooks in where `r.reconcile` is true.
 */
export async function enforce(ev: ToolCallLike, ctx: { cwd: string }, deps: EnforceDeps): Promise<BlockResult | undefined> {
  let summary = summarizeCommand(ev.toolName);
  let r: GateResult;
  let prepared: PreparedAction | undefined;
  try {
    const policy = deps.policyContext();
    prepared = prepareAction(ev, { cwd: ctx.cwd, home: deps.home, projectCommands: policy.projectCommands });
    summary = prepared.summary;
    r = evaluateGate(prepared.action, policy);
  } catch (e) {
    r = { decision: "deny", reason: `policy error (fail closed): ${(e as Error).message}`, reconcile: false };
    prepared = undefined;
  }

  const outcome: Outcome =
    r.decision === "ask"
      ? await resolveAsk(r, ev.toolName, summary, deps.ui)
      : r.decision === "allow"
        ? { decision: "allow", reason: r.reason }
        : { decision: "deny", reason: r.reason, block: `${BLOCK_PREFIX}: ${r.reason}` };

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
    return { block: true, reason: `${BLOCK_PREFIX}: the audit ledger could not be written (fail closed): ${(e as Error).message}` };
  }

  if (outcome.block !== undefined) return { block: true, reason: outcome.block };
  // Task 11: when `r.reconcile` is true (allowlisted runner on the answer route), take the snapshot here and
  // reconcile at `tool_result`.
  if (prepared?.machine !== undefined) deps.postChecks.remember(ev.toolCallId, prepared.machine);
  return undefined;
}
