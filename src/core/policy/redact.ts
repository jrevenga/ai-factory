// Redaction applied before anything reaches the run ledger (Phase 2 ruling 15).

const MASK = "***";
const MAX_SUMMARY = 500;

type Rule = readonly [RegExp, string];

const RULES: readonly Rule[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, MASK],
  // Unterminated block (truncated input): mask from the header to the end.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g, MASK],
  // Greedy userinfo (a password may contain "@"); the user part may be empty.
  [/:\/\/[^\s/:@]*:[^\s/]+@/g, `://${MASK}@`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, MASK],
  [/\bgh[pous]_[A-Za-z0-9]{16,}/g, MASK],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abpr]-[A-Za-z0-9-]+/g, MASK],
  // JSON: "password": "value"
  [/("[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${MASK}"`],
  // --password value / --token value
  [/(--[A-Za-z0-9-]*(?:password|passwd|secret|token|api-?key)[A-Za-z0-9-]*)(\s+)(?!-)\S+/gi, `$1$2${MASK}`],
  // NAME=value, including prefixed/suffixed names (DB_PASSWORD, AWS_SECRET_ACCESS_KEY). May cross a newline.
  [
    /(?<![A-Za-z])([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${MASK}`,
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

export function summarizeCommand(cmd: string): string {
  const flat = redact(cmd).replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_SUMMARY) return flat;
  const cut = flat.slice(0, MAX_SUMMARY);
  const last = cut.charCodeAt(cut.length - 1);
  // Do not leave a lone high surrogate at the cut.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
/** A "line" without a newline is cut here, so a stream that never prints one stays bounded in memory. */
const MAX_PENDING = 64 * 1024;
/** M1: how far before the cut a whitespace or the start of a secret may move it. */
const CUT_WINDOW = 512;
const globalRules: readonly RegExp[] = RULES.map(([re]) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`));

/**
 * M1: where to cut a newline-free run longer than MAX_PENDING so that no secret straddles the cut: at the last
 * whitespace within CUT_WINDOW before it, then moved back to the start of any redaction match that spans it.
 */
function safeCut(text: string): number {
  let at = MAX_PENDING;
  for (let i = MAX_PENDING - 1; i > MAX_PENDING - CUT_WINDOW; i--) {
    if (/\s/.test(text[i]!)) {
      at = i;
      break;
    }
  }
  for (let round = 0; round < 8; round++) {
    const lo = Math.max(0, at - CUT_WINDOW);
    const window = text.slice(lo, at + CUT_WINDOW);
    let moved = false;
    for (const re of globalRules) {
      for (const m of window.matchAll(re)) {
        const start = lo + m.index;
        if (start > 0 && start < at && start + m[0].length > at) {
          at = start;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return at;
}

/**
 * Line-wise `redact` for streamed command output (Task 10: no secrets in check logs). Complete lines are redacted
 * as they arrive; a private key block spanning lines is masked from its BEGIN line through its END line.
 */
export class LineRedactor {
  private pending = "";
  private inKey = false;

  /** Redacted complete lines of `text` (with their newlines); the unterminated rest is kept for the next call. */
  push(text: string): string {
    this.pending += text;
    let out = "";
    for (;;) {
      const nl = this.pending.indexOf("\n");
      if (nl < 0) {
        // Cut only with a full window after the cut point, so a secret still arriving is seen whole.
        if (this.pending.length < MAX_PENDING + CUT_WINDOW) break;
        const cut = safeCut(this.pending);
        out += this.line(this.pending.slice(0, cut));
        this.pending = this.pending.slice(cut);
        continue;
      }
      out += this.line(this.pending.slice(0, nl + 1));
      this.pending = this.pending.slice(nl + 1);
    }
    return out;
  }

  /** The redacted unterminated rest. */
  end(): string {
    const rest = this.pending;
    this.pending = "";
    return rest === "" ? "" : this.line(rest);
  }

  private line(line: string): string {
    if (this.inKey) {
      const m = KEY_END.exec(line);
      if (m === null) return "";
      this.inKey = false;
      return redact(line.slice(m.index + m[0].length));
    }
    const begin = KEY_BEGIN.exec(line);
    if (begin !== null && !KEY_END.test(line.slice(begin.index))) {
      this.inKey = true;
      return `${redact(line.slice(0, begin.index))}${MASK}${line.endsWith("\n") ? "\n" : ""}`;
    }
    return redact(line);
  }
}
