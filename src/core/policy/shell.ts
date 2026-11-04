// Fail-closed shell command tokenizer (Phase 2 ruling 1).
//
// A raw-text pre-scan rejects every character or construct where bash could expand, substitute or split
// differently from this lexer; what remains is a tiny grammar: words, single/double-quoted strings, the list
// operators `&&` `||` `;` `|` and newline, and the redirections `>` `>>` `<` `2>` `2>>` `2>&1` `&>`.
// Anything unrecognized returns `{ ok: false }`, which classifies as `unknown`.
//
// The returned segments are the single source of truth for classification and for `run_check` execution.
// A leading `~/` is kept literally in words and targets (bash would expand it; consumers must expand it).

export type JoinOperator = "&&" | "||" | ";" | "|" | "\n";
export type RedirectionOperator = ">" | ">>" | "<" | "2>" | "2>>" | "2>&1" | "&>";

export interface Redirection {
  op: RedirectionOperator;
  /** Target word; empty for `2>&1`. */
  target: string;
}

export interface Segment {
  /** Leading `NAME=value` words. Null-prototype object. */
  assignments: Record<string, string>;
  argv: string[];
  redirections: Redirection[];
  /** Operator joining this segment to the previous one; absent on the first segment. */
  joinedBy?: JoinOperator;
}

export type TokenizeResult = { ok: true; segments: Segment[] } | { ok: false; reason: string };

const MAX_LENGTH = 100_000;
// `~` is handled separately (allowed only as a leading `~/` of an unquoted word).
const REJECTED = new Set(["`", "$", "#", "\\", "{", "}", "(", ")", "*", "?", "[", "]", "!"]);
const TILDE_PREV = new Set([" ", "\t", "\n", ";", "|", "&", "<", ">"]);
const DELIMITERS = new Set([" ", "\t", "\n", ";", "|", "&", "<", ">"]);
const RESERVED_WORDS = new Set([
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done",
  "function", "time", "coproc", "in",
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INVISIBLE = /[\p{C}\p{Z}]/u;

/**
 * R33: the first control, format (bidi, zero-width) or non-space separator character of `text` as `U+XXXX`, or
 * undefined. Space, tab and newline are ordinary. Such characters can hide part of a command in a terminal.
 */
export function invisibleCharacter(text: string): string | undefined {
  for (const ch of text) {
    if (ch !== " " && ch !== "\t" && ch !== "\n" && INVISIBLE.test(ch)) {
      return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return undefined;
}

function prescan(cmd: string): string | undefined {
  if (cmd.length > MAX_LENGTH) return "command line too long";
  if (cmd.trim() === "") return "empty command";
  for (const ch of cmd) {
    if (ch !== " " && ch !== "\t" && ch !== "\n" && INVISIBLE.test(ch)) return "non-printable or invisible character";
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    const next = cmd[i + 1];
    if (REJECTED.has(ch)) return `unsupported shell character \`${ch}\``;
    if (ch === "~") {
      const atWordStart = i === 0 || TILDE_PREV.has(cmd[i - 1]!);
      if (!atWordStart || next !== "/") return "`~` is only supported as a leading `~/`";
    } else if (ch === "<" && next === "<") {
      return "here-documents and here-strings are not supported";
    } else if (ch === "|" && next === "&") {
      return "`|&` is not supported";
    } else if (ch === "&") {
      if (next === "&") i++;
      else if (next === ">") continue;
      else if (cmd[i - 1] === ">" && next === "1") continue;
      else return "a lone `&` (background job) is not supported";
    }
  }
  return undefined;
}

type Token =
  | { kind: "word"; text: string; quotedAt: number }
  | { kind: "op"; op: JoinOperator }
  | { kind: "redir"; op: RedirectionOperator };

interface WordBuffer {
  text: string;
  /** Text length when the first quote started; -1 if the word has no quoted part. */
  quotedAt: number;
}

type LexResult = { ok: true; tokens: Token[] } | { ok: false; reason: string };

function lex(cmd: string): LexResult {
  const tokens: Token[] = [];
  let word: WordBuffer | null = null;
  const flush = (): void => {
    if (word) tokens.push({ kind: "word", text: word.text, quotedAt: word.quotedAt });
    word = null;
  };
  const fail = (reason: string): LexResult => ({ ok: false, reason });

  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    const next = cmd[i + 1];
    if (ch === " " || ch === "\t") {
      flush();
      i++;
    } else if (ch === "\n" || ch === ";") {
      flush();
      tokens.push({ kind: "op", op: ch === ";" ? ";" : "\n" });
      i++;
    } else if (ch === "|") {
      flush();
      if (next === "&") return fail("`|&` is not supported");
      if (next === "|") {
        tokens.push({ kind: "op", op: "||" });
        i += 2;
      } else {
        tokens.push({ kind: "op", op: "|" });
        i++;
      }
    } else if (ch === "&") {
      flush();
      if (next === "&") {
        tokens.push({ kind: "op", op: "&&" });
        i += 2;
      } else if (next === ">") {
        if (cmd[i + 2] === ">") return fail("`&>>` is not supported");
        tokens.push({ kind: "redir", op: "&>" });
        i += 2;
      } else {
        return fail("a lone `&` (background job) is not supported");
      }
    } else if (ch === ">" || ch === "<") {
      const current: WordBuffer | null = word;
      const digits = current !== null && current.quotedAt === -1 && /^[0-9]+$/.test(current.text);
      const fd2 = digits && current.text === "2";
      if (digits && !(fd2 && ch === ">")) return fail("unsupported file-descriptor redirection");
      if (fd2) word = null;
      else flush();
      if (ch === "<") {
        if (next === "<" || next === ">" || next === "&" || next === "(") return fail("unsupported input redirection");
        tokens.push({ kind: "redir", op: "<" });
        i++;
      } else if (next === ">") {
        tokens.push({ kind: "redir", op: fd2 ? "2>>" : ">>" });
        i += 2;
      } else if (next === "&") {
        const after = cmd[i + 3];
        if (!fd2 || cmd[i + 2] !== "1" || (after !== undefined && !DELIMITERS.has(after))) {
          return fail("only `2>&1` file-descriptor duplication is supported");
        }
        tokens.push({ kind: "redir", op: "2>&1" });
        i += 3;
      } else if (next === "|" || next === "(") {
        return fail("unsupported output redirection");
      } else {
        tokens.push({ kind: "redir", op: fd2 ? "2>" : ">" });
        i++;
      }
    } else if (ch === "'" || ch === '"') {
      const end = cmd.indexOf(ch, i + 1);
      if (end < 0) return fail("unterminated quote");
      const content = cmd.slice(i + 1, end);
      for (const c of content) {
        if (REJECTED.has(c) || c === "~") return fail(`unsupported character \`${c}\` inside quotes`);
      }
      word ??= { text: "", quotedAt: -1 };
      if (word.quotedAt === -1) word.quotedAt = word.text.length;
      word.text += content;
      i = end + 1;
    } else if (ch === "~") {
      if (word !== null || next !== "/") return fail("`~` is only supported as a leading `~/`");
      word = { text: "~", quotedAt: -1 };
      i++;
    } else if (REJECTED.has(ch)) {
      return fail(`unsupported shell character \`${ch}\``);
    } else {
      word ??= { text: "", quotedAt: -1 };
      word.text += ch;
      i++;
    }
  }
  flush();
  return { ok: true, tokens };
}

function assignmentOf(t: { text: string; quotedAt: number }): [string, string] | undefined {
  const eq = t.text.indexOf("=");
  if (eq <= 0) return undefined;
  if (t.quotedAt !== -1 && t.quotedAt <= eq) return undefined;
  const name = t.text.slice(0, eq);
  return NAME.test(name) ? [name, t.text.slice(eq + 1)] : undefined;
}

function newSegment(): Segment {
  return { assignments: Object.create(null) as Record<string, string>, argv: [], redirections: [] };
}

export function tokenizeCommandLine(cmd: string): TokenizeResult {
  const pre = prescan(cmd);
  if (pre !== undefined) return { ok: false, reason: pre };
  const lexed = lex(cmd);
  if (!lexed.ok) return lexed;
  const tokens = lexed.tokens;

  const segments: Segment[] = [];
  let cur = newSegment();
  let empty = true;
  let pending: JoinOperator | undefined;

  const finish = (): string | undefined => {
    const first = cur.argv[0];
    if (first !== undefined && RESERVED_WORDS.has(first)) return `shell reserved word \`${first}\` is not supported`;
    if (segments.length > 0 && pending !== undefined) cur.joinedBy = pending;
    segments.push(cur);
    cur = newSegment();
    empty = true;
    return undefined;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "word") {
      empty = false;
      const assignment = cur.argv.length === 0 ? assignmentOf(t) : undefined;
      if (assignment) cur.assignments[assignment[0]] = assignment[1];
      else cur.argv.push(t.text);
    } else if (t.kind === "redir") {
      empty = false;
      if (t.op === "2>&1") {
        cur.redirections.push({ op: t.op, target: "" });
      } else {
        const target = tokens[k + 1];
        if (target === undefined || target.kind !== "word") return { ok: false, reason: `\`${t.op}\` without a target` };
        cur.redirections.push({ op: t.op, target: target.text });
        k++;
      }
    } else if (t.op === "\n") {
      if (empty) continue;
      const err = finish();
      if (err) return { ok: false, reason: err };
      pending = "\n";
    } else {
      if (empty) return { ok: false, reason: `\`${t.op}\` without a preceding command` };
      const err = finish();
      if (err) return { ok: false, reason: err };
      pending = t.op;
    }
  }
  if (!empty) {
    const err = finish();
    if (err) return { ok: false, reason: err };
  } else if (pending === "&&" || pending === "||" || pending === "|") {
    return { ok: false, reason: `dangling \`${pending}\`` };
  }
  if (segments.length === 0) return { ok: false, reason: "empty command" };
  return { ok: true, segments };
}

/** File targets of every redirection, in order (excludes `2>&1`). */
export function redirectTargets(segments: readonly Segment[]): string[] {
  return segments.flatMap((s) => s.redirections.filter((r) => r.op !== "2>&1").map((r) => r.target));
}
