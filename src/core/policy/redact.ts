// Redaction applied before anything reaches the run ledger (Phase 2 ruling 15).

const MASK = "***";
const MAX_SUMMARY = 500;

type Rule = readonly [RegExp, string];

const RULES: readonly Rule[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, MASK],
  // Unterminated block (truncated input): mask from the header to the end.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, MASK],
  [/:\/\/[^\s/:@]+:[^\s/@]+@/g, `://${MASK}@`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, MASK],
  [/\bgh[pous]_[A-Za-z0-9]{16,}/g, MASK],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abpr]-[A-Za-z0-9-]+/g, MASK],
  [/\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi, `$1$2${MASK}`],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

export function summarizeCommand(cmd: string): string {
  const flat = redact(cmd).replace(/\s+/g, " ").trim();
  return flat.length > MAX_SUMMARY ? flat.slice(0, MAX_SUMMARY) : flat;
}
