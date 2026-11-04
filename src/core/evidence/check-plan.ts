// What `run_check` may execute (Phase 2 Task 10, plan review I13). Pure: nothing here runs a command.
//
// The command is tokenized once with the gate's lexer; the same segments are classified and, when allowed, become
// the argv lists `run_check` spawns without a shell. Only `&&` joins segments; any other operator, a pipeline or a
// redirection is rejected. Every segment must be read-only, on the unattended allowlist or project-declared.
import { DECLARED_COMMAND_NAMES } from "../config/schema.ts";
import { classifyCommandLine } from "../policy/command.ts";
import { tokenizeCommandLine } from "../policy/shell.ts";

export const SIMPLE_COMMANDS_ONLY = "run_check runs simple commands; split the pipeline";

export interface CheckStep {
  argv: string[];
  /** Leading `NAME=value` assignments (only the names the classifier allows survive classification, ruling 17). */
  env: Record<string, string>;
}

export type CheckPlan = { ok: true; steps: CheckStep[] } | { ok: false; error: string };

export function argvEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * The steps `run_check` runs for `command`, or why it refuses. `projectCommands` are the declared runners, tokenized
 * (`declaredCommands`); they must be the gate's.
 */
export function planCheck(command: string, projectCommands: string[][]): CheckPlan {
  const tok = tokenizeCommandLine(command);
  if (!tok.ok) return { ok: false, error: `run_check cannot run this command line (${tok.reason}): ${SIMPLE_COMMANDS_ONLY}` };
  for (const seg of tok.segments) {
    if ((seg.joinedBy !== undefined && seg.joinedBy !== "&&") || seg.redirections.length > 0) return { ok: false, error: SIMPLE_COMMANDS_ONLY };
    if (seg.argv.length === 0) return { ok: false, error: `run_check needs a command word in every segment: ${SIMPLE_COMMANDS_ONLY}` };
  }
  const c = classifyCommandLine(command, { projectCommands });
  // The classifier tokenizes the same text with the same lexer; a difference would be a bug, never run then.
  if (c.segments.length !== tok.segments.length || c.segments.some((s, i) => !argvEqual(s.argv, tok.segments[i]!.argv))) {
    return { ok: false, error: "run_check refused: the classified segments differ from the segments to run (internal error)" };
  }
  if (!c.allowlisted) {
    const why = c.reasons.length > 0 ? c.reasons.join("; ") : c.class;
    return {
      ok: false,
      error: `run_check runs only read-only, allowlisted or project-declared commands (.factory/config.json commands.${DECLARED_COMMAND_NAMES.join("|")}, matched by exact argv): ${why}`,
    };
  }
  return { ok: true, steps: tok.segments.map((s) => ({ argv: [...s.argv], env: { ...s.assignments } })) };
}

export interface DeclaredCommand {
  name: string;
  argv: string[];
}

/**
 * Project-declared runners from `.factory/config.json` `commands`, tokenized with the gate's lexer. A declaration is
 * used only when it is one simple command (one segment, no assignment, no redirection); anything else is ignored and
 * reported, so a declaration never widens the allowlist beyond one exact argv.
 */
export function declaredCommands(commands: Record<string, unknown> | undefined): { declared: DeclaredCommand[]; ignored: string[] } {
  const declared: DeclaredCommand[] = [];
  const ignored: string[] = [];
  if (commands === undefined) return { declared, ignored };
  for (const name of DECLARED_COMMAND_NAMES) {
    if (!Object.hasOwn(commands, name)) continue;
    const value = commands[name];
    if (typeof value !== "string") {
      ignored.push(`commands.${name}: not a string`);
      continue;
    }
    const tok = tokenizeCommandLine(value);
    if (!tok.ok) {
      ignored.push(`commands.${name}: ${tok.reason}`);
      continue;
    }
    const [seg, ...rest] = tok.segments;
    if (seg === undefined || rest.length > 0 || seg.redirections.length > 0 || Object.keys(seg.assignments).length > 0 || seg.argv.length === 0) {
      ignored.push(`commands.${name}: must be one simple command (no operators, redirections or NAME=value assignments)`);
      continue;
    }
    declared.push({ name, argv: [...seg.argv] });
  }
  return { declared, ignored };
}

/** The declared name whose argv equals the whole plan (a single step), if any. */
export function declaredNameOf(steps: readonly CheckStep[], declared: readonly DeclaredCommand[]): string | undefined {
  if (steps.length !== 1) return undefined;
  return declared.find((d) => argvEqual(d.argv, steps[0]!.argv))?.name;
}
