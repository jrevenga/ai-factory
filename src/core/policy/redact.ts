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
    /(?<![A-Za-z])([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*)(\s*[=:]\s*)\S+/gi,
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
