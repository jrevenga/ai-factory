// The machine-owned section of a task file (M §7.1, §14 row 5): written by extension code only.
//
// Fail-closed contract: markers are recognised only outside YAML frontmatter. The body must contain
// either no markers (0 open / 0 close) or exactly one well-ordered pair (1/1). Anything else (a second
// block, a dangling or stray marker, reversed order, a marker quoted in a code block) makes
// `parseMachine` return `{ invalid: true, reason }`; `replaceMachine` then throws `MachineSectionError`
// and `touchesMachine` reports true, so callers never act on a hijacked or ambiguous block.
export const MACHINE_OPEN = "<!-- machine: written by code only -->";
export const MACHINE_CLOSE = "<!-- /machine -->";

const ORDER = ["phase", "base", "checkpoint", "worktree", "run"];
const SEP = " · ";
const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

export class MachineSectionError extends Error {
  constructor(reason: string) {
    super(`invalid machine section: ${reason}`);
    this.name = "MachineSectionError";
  }
}

export interface ParsedMachine {
  fields: Record<string, string>;
  /** Offset of MACHINE_OPEN in the whole text. */
  start: number;
  /** Offset just after MACHINE_CLOSE in the whole text. */
  end: number;
}
export interface InvalidMachine {
  invalid: true;
  reason: string;
}

function countOf(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

const bodyStart = (md: string): number => FRONTMATTER.exec(md)?.[0].length ?? 0;

export function parseMachine(md: string): ParsedMachine | InvalidMachine | undefined {
  const from = bodyStart(md);
  const body = md.slice(from);
  const opens = countOf(body, MACHINE_OPEN);
  const closes = countOf(body, MACHINE_CLOSE);
  if (opens === 0 && closes === 0) return undefined;
  if (opens !== 1 || closes !== 1) return { invalid: true, reason: `${opens} open and ${closes} close markers` };
  const start = body.indexOf(MACHINE_OPEN);
  const closeAt = body.indexOf(MACHINE_CLOSE);
  if (closeAt < start) return { invalid: true, reason: "close marker precedes open marker" };
  const inner = body.slice(start + MACHINE_OPEN.length, closeAt).trim();
  const fields: Record<string, string> = {};
  for (const part of inner.split(SEP)) {
    const i = part.indexOf(":");
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { fields, start: from + start, end: from + closeAt + MACHINE_CLOSE.length };
}

/** Throws on keys or values that would not round-trip through `parseMachine`. */
export function renderMachine(fields: Record<string, string>, eol = "\n"): string {
  for (const [k, v] of Object.entries(fields)) {
    if (!KEY.test(k)) throw new Error(`invalid machine field name: ${JSON.stringify(k)}`);
    if (v.includes(SEP) || /[\r\n]/.test(v) || v.includes("-->") || v !== v.trim()) {
      throw new Error(`machine field ${k} has a value that cannot be represented`);
    }
  }
  const keys = [...ORDER.filter((k) => k in fields), ...Object.keys(fields).filter((k) => !ORDER.includes(k))];
  return `${MACHINE_OPEN}${eol}${keys.map((k) => `${k}: ${fields[k]}`).join(SEP)}${eol}${MACHINE_CLOSE}`;
}

export function replaceMachine(md: string, fields: Record<string, string>): string {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const block = renderMachine(fields, eol);
  const existing = parseMachine(md);
  if (existing && "invalid" in existing) throw new MachineSectionError(existing.reason);
  if (existing) return md.slice(0, existing.start) + block + md.slice(existing.end);
  const at = bodyStart(md);
  return `${md.slice(0, at)}${block}${eol}${eol}${md.slice(at)}`;
}

/** True when the block changed, appeared or disappeared, or when either side is not a valid section. */
export function touchesMachine(before: string, after: string): boolean {
  const a = parseMachine(before);
  const b = parseMachine(after);
  if ((a && "invalid" in a) || (b && "invalid" in b)) return true;
  const slice = (md: string, p: ParsedMachine | InvalidMachine | undefined): string | undefined =>
    p && !("invalid" in p) ? md.slice(p.start, p.end) : undefined;
  return slice(before, a) !== slice(after, b);
}

export interface TextEdit {
  oldText: string;
  newText: string;
}

/** What Pi's fuzzy edit matching may treat as equal: line endings, trailing spaces, quote, dash and space variants. */
function fuzzy(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

function overlapsExactly(text: string, needle: string, start: number, end: number): boolean {
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (i < end && i + needle.length > start) return true;
  }
  return false;
}

/**
 * Ruling 8's conservative pre-check for Pi's `edit` (whose fuzzy matcher is not exported, so an in-memory replay
 * can diverge; the post-check at `tool_result` covers what this misses). True when:
 * - the current file's markers are ambiguous (fail closed), or an `oldText` is empty;
 * - any `newText` contains a marker (a block would appear, or the section would become ambiguous);
 * - any `oldText` contains a marker or a line of the current block, or an exact occurrence of it overlaps the block;
 * - an `oldText` has no exact occurrence (Pi falls back to fuzzy matching) and, normalized, lies inside the block;
 * - replaying the edits exactly changes the block.
 */
export function editTouchesMachine(current: string, edits: readonly TextEdit[]): boolean {
  const parsed = parseMachine(current);
  if (parsed && "invalid" in parsed) return true;
  for (const e of edits) {
    if (e.oldText === "") return true;
    if (e.newText.includes(MACHINE_OPEN) || e.newText.includes(MACHINE_CLOSE)) return true;
  }
  if (!parsed) return false;
  const block = current.slice(parsed.start, parsed.end);
  const lines = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const fuzzyBlock = fuzzy(block);
  let replayed = current;
  let replayable = true;
  for (const { oldText, newText } of edits) {
    if (oldText.includes(MACHINE_OPEN) || oldText.includes(MACHINE_CLOSE)) return true;
    if (lines.some((l) => oldText.includes(l))) return true;
    if (current.includes(oldText)) {
      if (overlapsExactly(current, oldText, parsed.start, parsed.end)) return true;
      if (replayable) replayed = replayed.replace(oldText, () => newText);
    } else {
      replayable = false;
      const needle = fuzzy(oldText).trim();
      if (needle === "" || fuzzyBlock.includes(needle)) return true;
    }
  }
  return replayable && touchesMachine(current, replayed);
}
