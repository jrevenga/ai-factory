// Command classification (Phase 2 rulings 1, 2, 17, 18). Pure: nothing here executes a command.
//
// Each segment from `tokenizeCommandLine` is classified on its own; the line's reported class is the most
// severe segment class, `hardClass` the most severe hard class, and `allowlisted` requires every segment to be
// read-only or allowlisted. Anything not recognized by the rule tables is `unknown`.
import path from "node:path";
import * as R from "./command-rules.ts";
import { tokenizeCommandLine, type Segment } from "./shell.ts";

export type CommandClass = "read-only" | "local-write" | "destructive" | "remote-mutating" | "unknown";
export type HardClass = "destructive" | "remote-mutating";

const ORDER: Readonly<Record<CommandClass, number>> = {
  "read-only": 0,
  "local-write": 1,
  unknown: 2,
  destructive: 3,
  "remote-mutating": 4,
};

/** Severity order for the reported class only (ruling 2). */
export function severity(c: CommandClass): number {
  return ORDER[c];
}

function maxClass(a: CommandClass, b: CommandClass): CommandClass {
  return severity(b) > severity(a) ? b : a;
}

function isHard(c: CommandClass): c is HardClass {
  return c === "destructive" || c === "remote-mutating";
}

/** R58: which configured external programs git could run during a read-only command (fact gathered by the adapter). */
export interface GitHelpers {
  /** `diff.external`, `diff.<driver>.textconv/command` or `GIT_EXTERNAL_DIFF` is set. */
  diff: boolean;
  /** `core.fsmonitor` names a program (a non-boolean value). */
  fsmonitor: boolean;
}

export interface CommandContext {
  /** Project-declared runners, already tokenized to argv; matched by argv equality. */
  projectCommands: string[][];
  /**
   * R58: undefined means no helper is configured. When set, a git invocation that would be read-only is `unknown`
   * unless it carries both `--no-ext-diff` and `--no-textconv`; with an fsmonitor program it is always `unknown`
   * (`-c core.fsmonitor=false` is itself unclassified).
   */
  gitHelpers?: GitHelpers;
}

export interface SegmentClassification {
  argv: string[];
  class: CommandClass;
  allowlisted: boolean;
  /** This segment's share of the line's `pathArgs`, `inputPaths` and `readArgs` (R28 needs the segment order). */
  pathArgs: string[];
  inputPaths: string[];
  readArgs: string[];
  /**
   * R37: the explicit paths `git add` stages (also in `inputPaths`). The gate requires each to be a known
   * non-directory: staging a directory can sweep secret files into git objects.
   */
  stagePaths?: string[];
  /**
   * R43: operands the gate requires to be known non-directories (a directory operand of diff or cp, or of a runner
   * that rewrites its operands, reads or writes descendants the facts do not cover); otherwise the segment is unknown.
   */
  nonDirPaths?: string[];
  /** R48: entries that must not exist (a fetch name that is also a repository path or bundle); otherwise the segment is unknown. */
  absentPaths?: string[];
  /** R41: repository paths selected by git syntax (`rev:path`, `:path`, `-L range:path`, pathspecs). */
  logicalPaths?: string[];
  /** R41: the segment prints tracked file contents (git diff/show/blame, log with patches, status -v). */
  trackedContent?: boolean;
}

export interface CommandClassification {
  class: CommandClass;
  segments: SegmentClassification[];
  hardClass?: HardClass;
  reasons: string[];
  /** Paths written by the line (write arguments and output redirection targets), for the gate's path checks. */
  pathArgs: string[];
  /** Paths read that are not file arguments (`<` sources, `git -C` dirs of read-only git): checked for secrets only. */
  inputPaths: string[];
  /**
   * R25: candidate file words of every read-only or local-write segment (`extractReadArgs`). Any of them may name a
   * file whose content the program prints, whatever option introduces it; the gate secret-checks them.
   */
  readArgs: string[];
  /**
   * R41: repository paths that git syntax selects (no filesystem resolution): the gate checks each with
   * `isSecretPath` relative to the project root and home.
   */
  logicalPaths: string[];
  /** R41: some segment prints tracked file contents; the gate needs the extension's `trackedSecret` fact. */
  trackedContent: boolean;
  allowlisted: boolean;
}

interface Verdict {
  class: CommandClass;
  allowlisted: boolean;
  reasons: string[];
  pathArgs: string[];
  /** Paths read without being file arguments (`git -C` of read-only git); reported in `inputPaths`. */
  readPaths?: string[];
  /** R37: explicit `git add` paths (see SegmentClassification.stagePaths). */
  stagePaths?: string[];
  /** R40: the grammar's read facts; undefined falls back to `extractReadArgs` for read-only/local-write segments. */
  readArgs?: string[];
  nonDirPaths?: string[];
  absentPaths?: string[];
  logicalPaths?: string[];
  trackedContent?: boolean;
}

const readOnly = (reason: string): Verdict => ({ class: "read-only", allowlisted: true, reasons: [reason], pathArgs: [] });
const localWrite = (reason: string, pathArgs: string[] = [], allowlisted = true): Verdict => ({
  class: "local-write",
  allowlisted,
  reasons: [reason],
  pathArgs,
});
const unknown = (reason: string, pathArgs: string[] = []): Verdict => ({ class: "unknown", allowlisted: false, reasons: [reason], pathArgs });
const destructive = (reason: string, pathArgs: string[] = []): Verdict => ({
  class: "destructive",
  allowlisted: false,
  reasons: [reason],
  pathArgs,
});
const remote = (reason: string): Verdict => ({ class: "remote-mutating", allowlisted: false, reasons: [reason], pathArgs: [] });

// --- argument helpers (conservative: over-detection only ever makes a command less trusted) ---

function argvEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function startsWithArgs(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((x, i) => args[i] === x);
}

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** True if any `-abc` cluster contains one of `letters`. */
function hasShort(args: readonly string[], letters: string): boolean {
  return args.some((a) => a.length > 1 && a[0] === "-" && a[1] !== "-" && [...a.slice(1)].some((c) => letters.includes(c)));
}

/** True if a long option equals, or is an abbreviation of, one of `names` (GNU and git accept abbreviations). */
function hasLong(args: readonly string[], names: readonly string[]): boolean {
  return args.some((a) => {
    if (!a.startsWith("--") || a.length <= 2) return false;
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    return names.some((n) => n === name || n.startsWith(name));
  });
}

function positionals(args: readonly string[]): string[] {
  return args.filter((a) => a === "-" || !a.startsWith("-"));
}

// --- option grammar parser (R40) ---

interface ParsedOption {
  /** `-x`, `--name` (go flags: `-name`), or `-NUM`. */
  name: string;
  kind: R.Opt;
  value?: string;
  /** argv index of the option word. */
  index: number;
  /** Seen after the first operand (a POSIX parser would take the word as an operand). */
  late: boolean;
  word: string;
}

interface ParsedOperand {
  word: string;
  index: number;
  /** After `--`. */
  afterDoubleDash: boolean;
}

type Parsed = { ok: true; options: ParsedOption[]; operands: ParsedOperand[] } | { ok: false; reason: string };

/** How an option takes its value: none, optional (attached or after `=` only), or required (attached or next word). */
function arity(kind: R.Opt): "none" | "optional" | "required" {
  if (kind === "flag") return "none";
  if (kind === "opt-opaque") return "optional";
  if (typeof kind === "object" && "pattern" in kind && kind.optional === true) return "optional";
  return "required";
}

/** Why `name` (with `value`) makes the command `unknown`, or undefined. */
function refusal(name: string, kind: R.Opt, value: string | undefined): string | undefined {
  if (typeof kind !== "object") return undefined;
  if ("reject" in kind) return `${name} ${kind.reject}`;
  return value !== undefined && !kind.pattern.test(value) ? `${name}=${value} ${kind.reason}` : undefined;
}

/** R40 echo: a word made only of the grammar's flag letters (`-n`, `-neE`) is an option; anything else is text. */
function isFlagCluster(a: string, g: R.Grammar): boolean {
  return /^-[^-]/.test(a) && [...a.slice(1)].every((c) => g.short !== undefined && lookup(g.short, c) === "flag");
}

/**
 * Parses `args` against `g`. Unknown options, options rejected by the grammar, a flag given a value and a value
 * option without its value all fail, so the caller returns `unknown`.
 */
function parseArgs(args: readonly string[], g: R.Grammar): Parsed {
  const options: ParsedOption[] = [];
  const operands: ParsedOperand[] = [];
  const fail = (reason: string): Parsed => ({ ok: false, reason });
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const seenOperand = operands.length > 0;
    const text = g.unknownAsText === true && !isFlagCluster(a, g);
    if (end || g.noOptions || text || a === "-" || !a.startsWith("-") || (g.order === "posix" && seenOperand)) {
      operands.push({ word: a, index: i, afterDoubleDash: end });
      continue;
    }
    if (a === "--") {
      end = true;
      continue;
    }
    if (seenOperand && g.order === "strict") return fail(`option ${a} after an operand (it could be taken as an output operand)`);
    const late = seenOperand;
    if (g.numeric === true && /^-[0-9]+$/.test(a)) {
      options.push({ name: "-NUM", kind: "opaque", value: a.slice(1), index: i, late, word: a });
      continue;
    }
    if (g.goFlags === true || a.startsWith("--")) {
      const raw = g.goFlags === true && a.startsWith("--") ? a.slice(1) : a;
      const eq = raw.indexOf("=");
      const name = eq < 0 ? raw : raw.slice(0, eq);
      const kind = g.long === undefined ? undefined : lookup(g.long, name);
      if (kind === undefined) return fail(`unrecognized option ${a} (R40: options outside the grammar are unknown)`);
      const takes = arity(kind);
      if (takes === "none" && eq >= 0) return fail(`${name} takes no value`);
      const value = eq >= 0 ? raw.slice(eq + 1) : takes === "required" ? args[++i] : undefined;
      if (takes === "required" && value === undefined) return fail(`${name} without a value`);
      const r = refusal(name, kind, value);
      if (r !== undefined) return fail(r);
      options.push({ name, kind, ...(value !== undefined ? { value } : {}), index: i, late, word: a });
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      const name = `-${c}`;
      const kind = g.short === undefined ? undefined : lookup(g.short, c);
      if (kind === undefined) return fail(`unrecognized option ${name}${a.length > 2 ? ` in ${a}` : ""} (R40: options outside the grammar are unknown)`);
      const takes = arity(kind);
      if (takes === "none") {
        const r = refusal(name, kind, undefined);
        if (r !== undefined) return fail(r);
        options.push({ name, kind, index: i, late, word: a });
        continue;
      }
      // A value option takes the rest of the bundle; a required one otherwise takes the next word.
      const rest = a.slice(j + 1);
      const value = rest !== "" ? rest : takes === "required" ? args[++i] : undefined;
      if (takes === "required" && value === undefined) return fail(`${name} without a value`);
      const r = refusal(name, kind, value);
      if (r !== undefined) return fail(r);
      options.push({ name, kind, ...(value !== undefined ? { value } : {}), index: i, late, word: a });
      break;
    }
  }
  return { ok: true, options, operands };
}

interface GrammarFacts {
  readArgs: string[];
  pathArgs: string[];
  nonDirPaths: string[];
  absentPaths: string[];
  /** Operands after the leading (pattern/filter) ones, `-` included. */
  operands: string[];
}

function pushUnique(out: string[], w: string): void {
  if (w !== "" && w !== "-" && !out.includes(w)) out.push(w);
}

/** The facts of a successful parse, or why the operands are outside the grammar. */
function grammarFacts(p: Extract<Parsed, { ok: true }>, g: R.Grammar): GrammarFacts | { error: string } {
  const given = (n: string) => p.options.some((o) => o.name === n);
  const leadCount = g.leading !== undefined && !(g.leading.unless ?? []).some(given) ? g.leading.count : 0;
  const leading = p.operands.slice(0, leadCount);
  const rest = p.operands.slice(leadCount);
  const bad = g.leadingReject !== undefined ? leading.find((o) => g.leadingReject!.pattern.test(o.word)) : undefined;
  if (bad !== undefined) return { error: g.leadingReject!.reason };
  if (g.max !== undefined && rest.length > g.max) {
    return { error: g.max === 0 ? "operands are not allowlisted" : `more than ${g.max} operand(s): an extra operand can be an output file` };
  }
  const off = g.pattern !== undefined ? rest.find((o) => !g.pattern!.test(o.word)) : undefined;
  if (off !== undefined) return { error: `operand ${off.word} is outside the allowlisted form` };
  const first = g.firstOperand !== undefined ? rest[0] : undefined;
  if (first !== undefined && !g.firstOperand!.pattern.test(first.word)) return { error: `${first.word}: ${g.firstOperand!.reason}` };
  const tail = g.afterDoubleDash !== undefined ? rest.find((o) => o.afterDoubleDash && !g.afterDoubleDash!.test(o.word)) : undefined;
  if (tail !== undefined) return { error: `argument ${tail.word} after -- is not allowlisted` };

  type Item = { index: number; read?: string; write?: string };
  const items: Item[] = [];
  for (const o of p.options) {
    if (o.kind === "read-path" && o.value !== undefined) items.push({ index: o.index, read: o.value });
    else if (o.kind === "write-path" && o.value !== undefined) items.push({ index: o.index, read: o.value, write: o.value });
    // A POSIX-order parser (BSD, POSIXLY_CORRECT) takes the words after the first operand as file operands.
    if (o.late && g.operands !== "opaque") {
      items.push({ index: o.index, read: o.word });
      if (o.value !== undefined) items.push({ index: o.index, read: o.value });
    }
  }
  for (const o of rest) {
    if (g.operands === "read-path") items.push({ index: o.index, read: o.word });
    else if (g.operands === "write-path") items.push({ index: o.index, read: o.word, write: o.word });
  }
  if (first !== undefined && g.firstOperand!.nonDir === true) items.push({ index: first.index, read: first.word });
  items.sort((x, y) => x.index - y.index);
  const readArgs: string[] = [];
  const pathArgs: string[] = [];
  for (const it of items) {
    if (it.read !== undefined) pushUnique(readArgs, it.read);
    if (it.write !== undefined) pushUnique(pathArgs, it.write);
  }
  const nonDirPaths: string[] = [];
  if (g.nonDirOperands === true) for (const o of rest) pushUnique(nonDirPaths, o.word);
  if (first !== undefined && g.firstOperand!.nonDir === true) pushUnique(nonDirPaths, first.word);
  const absentPaths: string[] = [];
  if (first !== undefined) for (const x of g.firstOperand!.absentSuffixes ?? []) pushUnique(absentPaths, first.word + x);
  return { readArgs, pathArgs, nonDirPaths, absentPaths, operands: rest.map((o) => o.word) };
}

type GrammarResult = { ok: true; parsed: Extract<Parsed, { ok: true }>; facts: GrammarFacts } | { ok: false; reason: string };

function applyGrammar(name: string, args: readonly string[], g: R.Grammar): GrammarResult {
  const parsed = parseArgs(args, g);
  if (!parsed.ok) return { ok: false, reason: `${name}: ${parsed.reason}` };
  const facts = grammarFacts(parsed, g);
  if ("error" in facts) return { ok: false, reason: `${name}: ${facts.error}` };
  return { ok: true, parsed, facts };
}

/** Grammar facts as verdict fields (empty lists omitted). */
function factFields(f: GrammarFacts): Pick<Verdict, "readArgs" | "nonDirPaths" | "absentPaths"> {
  return {
    readArgs: f.readArgs,
    ...(f.nonDirPaths.length > 0 ? { nonDirPaths: f.nonDirPaths } : {}),
    ...(f.absentPaths.length > 0 ? { absentPaths: f.absentPaths } : {}),
  };
}

// --- per-command rules ---

function classifyGrammar(name: string, args: readonly string[], g: R.Grammar): Verdict {
  const r = applyGrammar(name, args, g);
  if (!r.ok) return unknown(r.reason);
  return { ...readOnly(`${name} is read-only`), ...factFields(r.facts) };
}

/** find's expression grammar (R40): global options, start points, then primaries from the tables. */
function classifyFind(args: readonly string[]): Verdict {
  if (args.some((a) => R.FIND_DESTRUCTIVE_PREDICATES.has(a))) return destructive("find -delete removes files");
  const reads: string[] = [];
  let i = 0;
  while (i < args.length) {
    const kind = lookup(R.FIND_GLOBAL, args[i]!);
    if (kind === undefined && !/^-O[0-3]$/.test(args[i]!)) break;
    i += kind === "opaque" ? 2 : 1;
  }
  while (i < args.length && !args[i]!.startsWith("-")) pushUnique(reads, args[i++]!);
  while (i < args.length) {
    const a = args[i]!;
    if (R.FIND_FLAGS.has(a)) {
      i++;
      continue;
    }
    const kind = lookup(R.FIND_VALUES, a) ?? (R.FIND_NEWER_FILE.test(a) ? "read-path" : R.FIND_NEWER_TIME.test(a) ? "opaque" : undefined);
    if (kind === undefined) return unknown(`find: unrecognized expression ${a} (R40: primaries outside the grammar are unknown)`);
    const value = args[i + 1];
    const refused = refusal(`find ${a}`, kind, value);
    if (refused !== undefined) return unknown(refused);
    if (value === undefined) return unknown(`find ${a} without a value`);
    if (kind === "read-path") pushUnique(reads, value);
    i += 2;
  }
  return { ...readOnly("find without action predicates is read-only"), readArgs: reads };
}

/** Absolute, home-relative or parent-relative spellings (posix or Windows) that can point outside the work tree. */
function mayLeaveWorkTree(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~/") || p === ".." || p.startsWith("../") || /^[A-Za-z]:/.test(p);
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** R25: a word that may name a file: contains `/` or `\`, or starts with `~` or `.`; URLs are not path-like. */
export function isPathLikeArg(w: string): boolean {
  if (w === "" || URL_SCHEME.test(w)) return false;
  return w.includes("/") || w.includes("\\") || w.startsWith("~") || w.startsWith(".");
}

/**
 * R25: every word that may name a file read by the command: non-flag words, every word after `--`, the value of
 * `--opt=value`, and for a short cluster `-xVALUE` both the text after the first letter and, when a path character
 * (`/`, `\`, `~`, `.`) appears later in the cluster, the text from it (`-rf/x` → `f/x`, `/x`). Over-reporting is
 * intended: a word that is not a file costs only a fact. R40: used only for segments without a grammar (exact-argv
 * runners, project-declared commands); grammar-parsed programs report their read facts precisely.
 */
export function extractReadArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  const push = (w: string) => {
    if (w !== "" && !out.includes(w)) out.push(w);
  };
  let operands = false;
  for (const a of args) {
    if (operands) push(a);
    else if (a === "--") operands = true;
    else if (a === "-") continue;
    else if (!a.startsWith("-")) push(a);
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) push(a.slice(eq + 1));
    } else {
      push(a.slice(2));
      const i = a.slice(2).search(/[/\\~.]/);
      if (i > 0) push(a.slice(2 + i));
    }
  }
  return out;
}

function classifyGit(args: readonly string[]): Verdict {
  const v = classifyGitInvocation(args);
  // R45: git honours these wherever they appear in its argv; a grammar may have taken them for an option's value.
  if (!isHard(v.class) && hasLong(args, R.GIT_RAW_SCANNED_LONG)) {
    const hit = args.find((a) => hasLong([a], R.GIT_RAW_SCANNED_LONG))!;
    return unknown(`git honours ${hit.split("=")[0]} anywhere in its arguments, whatever option precedes it (R45)`);
  }
  return v;
}

function classifyGitInvocation(args: readonly string[]): Verdict {
  if (hasLong(args, R.GIT_INJECTION_LONG)) return unknown("git option injects configuration or redirects the repository");
  if (hasLong(args, R.GIT_FILE_LIST_LONG)) return unknown("git reads a pathspec list from a file or stdin (R24)");
  const dirs: string[] = [];
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (a === "-C") {
      const dir = args[i + 1];
      if (dir === undefined) return unknown("git -C without a directory");
      dirs.push(dir);
      i += 2;
    } else if (R.GIT_GLOBAL_FLAGS.has(a)) {
      i++;
    } else if (a.startsWith("-c")) {
      return unknown("git -c injects configuration");
    } else {
      if (args.includes("push")) return remote(`git push (with unrecognized global option ${a})`);
      return unknown(`unrecognized git global option ${a}`);
    }
  }
  const sub = args[i];
  if (sub === undefined) return unknown("git without a subcommand");
  const v = classifyGitSubcommand(sub, args.slice(i + 1));
  if (dirs.length === 0) return v;
  // Hard classes keep their class (they ask anyway); everything else is unknown (R41).
  if (isHard(v.class)) return { ...v, pathArgs: [...dirs, ...v.pathArgs] };
  const u = unknown("git -C runs git in another directory, against which its operands resolve; the facts do not model that (R41)");
  if (v.class === "read-only") u.readPaths = dirs;
  else u.pathArgs = dirs;
  return u;
}

/** R41: the repository path a git word selects: `rev:path`, `:path`, `:N:path`, or the word itself (a pathspec). */
function logicalPath(w: string): string {
  if (w.startsWith(":")) {
    const rest = w.slice(1);
    return /^[0-3]:/.test(rest) ? rest.slice(2) : rest;
  }
  const i = w.indexOf(":");
  return i < 0 ? w : w.slice(i + 1);
}

/** R40/R41: an allowlisted read-only git subcommand parsed against its grammar, with logical paths and content. */
function classifyGitRead(sub: string, rest: readonly string[], g: R.Grammar): Verdict {
  const r = applyGrammar(`git ${sub}`, rest, g);
  if (!r.ok) return unknown(r.reason);
  // git diff falls back to --no-index on its own when a path lies outside the work tree. git looks at raw words (the
  // first non-option word), so an option's separate value counts too (R45).
  const rawWords = rest.filter((w) => w !== "--" && !w.startsWith("-"));
  if (sub === "diff" && [...r.facts.operands, ...rawWords].some(mayLeaveWorkTree)) {
    return unknown("git diff with a path that may lie outside the work tree compares arbitrary files (implicit --no-index)");
  }
  const logical: string[] = [];
  const items: { index: number; path: string }[] = [];
  for (const o of r.parsed.options) {
    // `-L <start>,<end>:<file>` / `-L :<funcname>:<file>`: the file follows the last colon.
    if (o.name === "-L" && o.value !== undefined) items.push({ index: o.index, path: o.value.slice(o.value.lastIndexOf(":") + 1) });
  }
  for (const o of r.parsed.operands) items.push({ index: o.index, path: logicalPath(o.word) });
  items.sort((x, y) => x.index - y.index);
  for (const it of items) pushUnique(logical, it.path);
  const opts = r.parsed.options.map((o) => o.name);
  const patch = opts.some((n) => R.GIT_LOG_CONTENT.has(n));
  // diff/show with only name/count formats print no content; show still prints a blob operand whatever the format.
  const statOnly =
    (sub === "diff" || sub === "show") &&
    !patch &&
    opts.some((n) => R.GIT_NO_CONTENT_FORMATS.has(n)) &&
    (sub === "diff" ||
      (!opts.some((n) => R.GIT_REF_SELECTORS.has(n)) &&
        r.parsed.operands.every((o) => o.afterDoubleDash || R.GIT_SHOW_COMMIT_REVISION.test(o.word))));
  const content =
    (R.GIT_CONTENT_SUBCOMMANDS.has(sub) && !statOnly) ||
    (sub === "log" && patch) ||
    (sub === "status" && opts.some((n) => n === "-v" || n === "--verbose"));
  return {
    ...readOnly(`git ${sub} is read-only`),
    ...factFields(r.facts),
    ...(logical.length > 0 ? { logicalPaths: logical } : {}),
    ...(content ? { trackedContent: true } : {}),
  };
}

function classifyGitSubcommand(sub: string, rest: readonly string[]): Verdict {
  const read = lookup(R.GIT_READ_GRAMMARS, sub);
  if (read) return classifyGitRead(sub, rest, read);
  switch (sub) {
    case "branch": {
      if (hasShort(rest, "dD") || hasLong(rest, ["--delete"])) return destructive("git branch -d/-D deletes a branch");
      const listing = rest.includes("-l") || rest.includes("--list");
      const listOnly = rest.every(
        (a) =>
          R.GIT_BRANCH_LIST_FLAGS.has(a) ||
          R.GIT_BRANCH_LIST_PREFIXES.some((p) => a.startsWith(p)) ||
          (listing && !a.startsWith("-")),
      );
      return listOnly ? readOnly("git branch listing is read-only") : unknown("git branch that creates, moves or configures a branch");
    }
    case "tag": {
      if (hasShort(rest, "d") || hasLong(rest, ["--delete"])) return unknown("git tag deletion");
      const listing = rest.includes("-l") || rest.includes("--list");
      const listOnly = rest.every(
        (a) => R.GIT_TAG_LIST_FLAGS.has(a) || R.GIT_TAG_LIST_PREFIXES.some((p) => a.startsWith(p)) || (listing && !a.startsWith("-")),
      );
      return listOnly ? readOnly("git tag listing is read-only") : unknown("git tag that creates a tag");
    }
    case "config": {
      const reads = rest.filter((a) => R.GIT_CONFIG_READ_FLAGS.has(a));
      const readForm = rest.every(
        (a) => R.GIT_CONFIG_READ_FLAGS.has(a) || R.GIT_CONFIG_READ_MODIFIERS.has(a) || a.startsWith("--type=") || !a.startsWith("-"),
      );
      return reads.length === 1 && readForm ? readOnly("git config read") : unknown("git config write");
    }
    case "remote": {
      const ok =
        rest.length === 0 ||
        argvEqual(rest, ["-v"]) ||
        argvEqual(rest, ["--verbose"]) ||
        (rest[0] === "get-url" && rest.length === 2 && !rest[1]!.startsWith("-"));
      return ok ? readOnly("git remote listing is read-only") : unknown("git remote that changes configuration");
    }
    case "add":
      return classifyGitAdd(rest);
    case "commit":
      return classifyGitCommit(rest);
    case "switch": {
      if (hasShort(rest, "f") || hasLong(rest, ["--discard-changes", "--force"])) return destructive("git switch discarding changes");
      const create = (rest[0] === "-c" || rest[0] === "--create") && (rest.length === 2 || rest.length === 3);
      return create && rest.slice(1).every((a) => !a.startsWith("-"))
        ? localWrite("git switch -c is allowlisted")
        : unknown("git switch other than -c <branch>");
    }
    case "checkout": {
      const create = rest[0] === "-b" && (rest.length === 2 || rest.length === 3) && rest.slice(1).every((a) => !a.startsWith("-"));
      return create ? localWrite("git checkout -b is allowlisted") : destructive("git checkout may discard working tree changes");
    }
    case "stash": {
      if (rest[0] === "list") {
        // `git stash list` takes log options, `--output=<file>` included (finding 2).
        return rest.length === 1 ? { ...readOnly("git stash list is read-only"), readArgs: [] } : unknown("git stash list with arguments takes log options, which can write files (R41)");
      }
      if (rest[0] === "push") {
        const opts = rest.slice(1);
        if (hasShort(opts, R.GIT_STASH_UNTRACKED_SHORT) || hasLong(opts, R.GIT_STASH_UNTRACKED_LONG)) {
          return unknown("git stash with untracked or ignored files stores them in git objects, secret files included (R37)");
        }
        const r = applyGrammar("git stash push", opts, R.GIT_STASH_PUSH_GRAMMAR);
        if (!r.ok) return unknown(r.reason);
        return { ...localWrite("git stash push is allowlisted"), ...factFields(r.facts) };
      }
      if (rest[0] === "drop" || rest[0] === "clear") return destructive(`git stash ${rest[0]} discards stashed work`);
      return unknown("git stash other than push/list");
    }
    case "restore": {
      if (hasShort(rest, "W") || hasLong(rest, ["--worktree"])) return destructive("git restore --worktree discards changes");
      if (hasShort(rest, "S") || hasLong(rest, ["--staged"])) {
        const r = applyGrammar("git restore --staged", rest, R.GIT_RESTORE_STAGED_GRAMMAR);
        if (!r.ok) return unknown(r.reason);
        return { ...localWrite("git restore --staged is allowlisted"), ...factFields(r.facts) };
      }
      return destructive("git restore discards working tree changes");
    }
    case "reset":
      return hasLong(rest, ["--hard"]) ? destructive("git reset --hard discards work") : unknown("git reset without --hard");
    case "clean":
      return destructive("git clean deletes untracked files");
    case "push": {
      const v = remote("git push mutates a remote");
      if (hasShort(rest, "f") || hasLong(rest, R.GIT_PUSH_FORCE) || rest.some((a) => a.startsWith("+"))) {
        v.reasons.push("force push also rewrites remote history");
      }
      return v;
    }
    case "rebase":
    case "filter-branch":
    case "filter-repo":
      return destructive(`git ${sub} rewrites history`);
    case "update-ref":
      return hasShort(rest, "d") || hasLong(rest, ["--delete"]) ? destructive("git update-ref -d deletes a ref") : unknown("git update-ref");
    default:
      return unknown(`git ${sub} is not in the rule tables`);
  }
}

/** A pathspec that names the whole tree or a parent of it once normalized (`.`, `./`, `src/..`, `..`). */
function isTreePath(p: string): boolean {
  const n = path.posix.normalize(p.replaceAll("\\", "/"));
  return n === "." || n === "./" || n === ".." || n.startsWith("../") || n === "/";
}

/**
 * R37: `git add` is allowlisted only for explicit paths with listed options. Everything that can stage beyond the
 * named files (`-A`, `-u`, `.`, a directory, no pathspec, pathspec magic or globs, any other option) is `unknown`.
 * The named paths are input paths, so the gate secret-checks each and asks `secrets` for a secret one.
 */
function classifyGitAdd(rest: readonly string[]): Verdict {
  const paths: string[] = [];
  let end = false;
  for (const a of rest) {
    if (!end && a === "--") {
      end = true;
    } else if (!end && a.startsWith("-") && a !== "-") {
      const ok = a.startsWith("--") ? R.GIT_ADD_LONG.includes(a) : [...a.slice(1)].every((c) => R.GIT_ADD_SHORT.includes(c));
      if (!ok) return unknown(`git add ${a} may stage files beyond the named ones, secret files included (R37)`);
    } else {
      paths.push(a);
    }
  }
  if (paths.length === 0) return unknown("git add without an explicit path (R37)");
  const sweeping = paths.find((p) => p.startsWith(":") || /[*?[\]]/.test(p) || /[\\/]$/.test(p) || isTreePath(p));
  if (sweeping !== undefined) {
    return unknown(`git add ${sweeping} names a directory, the whole tree or uses pathspec magic, and can stage secret files (R37)`);
  }
  return { ...localWrite("git add of explicit files is allowlisted"), readPaths: [...paths], stagePaths: [...paths] };
}

/** R37: `git commit` is allowlisted without `-a`/`--all`, without pathspecs and with listed options only. */
function classifyGitCommit(rest: readonly string[]): Verdict {
  if (hasLong(rest, ["--amend"])) return destructive("git commit --amend rewrites history");
  const parsed = parseArgs(rest, R.GIT_COMMIT_GRAMMAR);
  if (!parsed.ok) return unknown(`git commit: ${parsed.reason}; it may stage or read files (R37)`);
  if (parsed.operands.length > 0) return unknown("git commit with pathspecs stages those paths, secret files included (R37)");
  return { ...localWrite("git commit is allowlisted"), readArgs: [] };
}

/** An allowlisted runner (ruling 18) parsed against its grammar (R40). */
function classifyBin(bin: string, rest: readonly string[]): Verdict {
  const g = lookup(R.RUNNER_GRAMMARS, bin);
  if (g === undefined) return unknown(`${bin} is not an allowlisted runner`);
  const r = applyGrammar(bin, rest, g);
  if (!r.ok) return unknown(r.reason);
  const names = r.parsed.options.map((o) => o.name);
  if (bin === "prettier" && !names.some((n) => R.PRETTIER_REQUIRED.includes(n))) return unknown("prettier without --check or --write");
  const rewrites = (lookup(R.RUNNER_REWRITE, bin) ?? []).some((n) => names.includes(n));
  if (!rewrites) return { ...localWrite(`${bin} is an allowlisted runner`), readArgs: r.facts.readArgs };
  // `prettier --write` / `eslint --fix` rewrite each operand (a directory: every file below it, R43).
  const targets = r.facts.operands.filter((o) => o !== "-");
  return { ...localWrite(`${bin} rewrites its operands`, targets), readArgs: r.facts.readArgs, ...(targets.length > 0 ? { nonDirPaths: targets } : {}) };
}

function classifyPackageManager(name: string, args: readonly string[]): Verdict {
  const remoteWords = lookup(R.PACKAGE_MANAGER_REMOTE, name) ?? [];
  const hit = args.find((a) => remoteWords.includes(a));
  if (hit) return remote(`${name} ${hit} mutates a registry`);
  if (name === "npm" && args[0] === "exec") {
    const bin = args[3];
    if (args[1] === "--no" && args[2] === "--" && bin !== undefined && R.NPX_BINS.has(bin)) return classifyBin(bin, args.slice(4));
    return unknown("npm exec may download and run code; only `npm exec --no -- <bin>` for known runners is allowed");
  }
  const frozen = lookup(R.PACKAGE_MANAGER_FROZEN_INSTALL, name) ?? [];
  if ([...R.PACKAGE_MANAGER_ALLOWLIST, ...frozen].some((t) => argvEqual(t, args))) {
    return localWrite(`${name} ${args.join(" ")} is allowlisted`);
  }
  return unknown(`${name} ${args.join(" ")} is not an allowlisted runner`);
}

function classifyNpx(args: readonly string[]): Verdict {
  const bin = args[1];
  if (args[0] === "--no-install" && bin !== undefined && R.NPX_BINS.has(bin)) return classifyBin(bin, args.slice(2));
  return unknown("npx may download and run code; only `npx --no-install <bin>` for known runners is allowed");
}

function classifyGo(args: readonly string[]): Verdict {
  const sub = args[0];
  if (sub === undefined || !R.GO_SUBCOMMANDS.has(sub)) return unknown(`go ${sub ?? ""} is not allowlisted`.trim());
  const r = applyGrammar(`go ${sub}`, args.slice(1), R.GO_GRAMMAR);
  if (!r.ok) return unknown(r.reason);
  return { ...localWrite(`go ${sub} is allowlisted`, r.facts.pathArgs), readArgs: r.facts.readArgs };
}

function classifyCargo(args: readonly string[]): Verdict {
  const sub = args[0];
  if (sub === undefined || !R.CARGO_SUBCOMMANDS.has(sub)) return unknown("cargo subcommand is not allowlisted");
  const r = applyGrammar(`cargo ${sub}`, args.slice(1), R.CARGO_GRAMMAR);
  if (!r.ok) return unknown(r.reason);
  return { ...localWrite(`cargo ${sub} is allowlisted`), readArgs: r.facts.readArgs };
}

function classifyPathCommand(name: string, args: readonly string[], g: R.Grammar, allowlisted: boolean): Verdict {
  const r = applyGrammar(name, args, g);
  if (!r.ok) return unknown(r.reason, positionals(args));
  return { ...localWrite(`${name} writes local files`, r.facts.pathArgs, allowlisted), ...factFields(r.facts) };
}

function classifyRm(args: readonly string[]): Verdict {
  if (hasShort(args, "rR") || hasLong(args, ["--recursive", "--no-preserve-root"])) {
    return destructive("recursive rm", positionals(args));
  }
  return classifyPathCommand("rm", args, R.RM_GRAMMAR, false);
}

function isPlainSubstitution(script: string): boolean {
  if (!script.startsWith("s/") || script.includes("\n")) return false;
  const parts = script.slice(2).split("/");
  return parts.length === 3 && parts[0] !== "" && R.SED_SUBSTITUTION_FLAGS.test(parts[2]!);
}

function classifySed(args: readonly string[]): Verdict {
  let inPlace = false;
  const remaining: string[] = [];
  for (const a of args) {
    const suffix = a === "-i" || a === "--in-place" ? "" : a.startsWith("--in-place=") ? a.slice(11) : a.startsWith("-i") ? a.slice(2) : undefined;
    if (suffix === undefined) {
      remaining.push(a);
    } else {
      // R46: a backup suffix writes `<file><suffix>` (with `*` or `/`, anywhere) without a fact.
      if (suffix !== "") return unknown(`sed -i with backup suffix ${suffix} writes a backup file without a fact (R46)`);
      inPlace = true;
    }
  }
  if (!inPlace) return unknown("sed without -i");
  const parsed = parseArgs(remaining, R.SED_GRAMMAR);
  if (!parsed.ok) return unknown(`sed: ${parsed.reason}`);
  const scripts = parsed.options.filter((o) => o.name === "-e").map((o) => o.value!);
  const files = parsed.operands.map((o) => o.word);
  if (scripts.length === 0 && files.length > 0) scripts.push(files.shift()!);
  if (scripts.length !== 1 || !isPlainSubstitution(scripts[0]!)) return unknown("sed script other than one plain s/re/repl/flags");
  if (files.length === 0) return unknown("sed -i without files");
  return { ...localWrite("sed -i with a plain substitution is allowlisted", files), readArgs: [...files] };
}

/** R42: the local files a curl/wget data option sends (`@file`, `name=@file`, `name=<file`, `name@file`). */
function dataFileRefs(name: string, value: string): string[] {
  const out: string[] = [];
  if (value.startsWith("@")) out.push(value.slice(1));
  const form = /=([@<])([^;]*)/.exec(value);
  if (form !== null && (name === "-F" || name === "--form")) out.push(form[2]!);
  if (name === "--data-urlencode" && !value.startsWith("@")) {
    const at = value.indexOf("@");
    if (at > 0 && !value.slice(0, at).includes("=")) out.push(value.slice(at + 1));
  }
  return out.filter((f) => f !== "" && f !== "-");
}

function classifyNet(name: "curl" | "wget", args: readonly string[]): Verdict {
  const spec = name === "curl" ? R.CURL_SPEC : R.WGET_SPEC;
  const grammar: R.Grammar = {
    short: Object.fromEntries(Object.entries(spec.short).map(([k, s]) => [k, s.value ? "opaque" : "flag"])),
    long: Object.fromEntries(Object.entries(spec.long).map(([k, s]) => [k, s.value ? "opaque" : "flag"])),
    operands: "opaque",
  };
  const parsed = parseArgs(args, grammar);
  if (!parsed.ok) return unknown(`${name}: ${parsed.reason} (R42: options outside the minimal grammar are unknown)`);
  const effect = (o: ParsedOption): R.NetEffect | undefined =>
    (o.name.startsWith("--") ? lookup(spec.long, o.name) : lookup(spec.short, o.name.slice(1)))?.effect;
  let mutate = false;
  let fileRef: string | undefined;
  let cookieFile = false;
  let badMethod = false;
  let cwdWrite = false;
  let outputGiven = false;
  let outDir: string | undefined;
  const writes: string[] = [];
  const reads: string[] = [];
  const urls = parsed.operands.map((o) => o.word);
  for (const o of parsed.options) {
    const value = o.value ?? "";
    switch (effect(o)) {
      case "safe":
        if (value.startsWith("@")) fileRef ??= o.name;
        if (o.name === "--url") urls.push(value);
        break;
      case "cookie":
        if (!value.includes("=")) cookieFile = true;
        break;
      case "mutate":
        mutate = true;
        break;
      case "mutate-data":
        mutate = true;
        for (const f of dataFileRefs(o.name, value)) pushUnique(reads, f);
        break;
      case "mutate-file":
        mutate = true;
        if (value !== ".") pushUnique(reads, value);
        break;
      case "method": {
        const m = value.toUpperCase();
        if (R.MUTATING_METHODS.has(m)) mutate = true;
        else if (!R.SAFE_METHODS.has(m)) badMethod = true;
        break;
      }
      case "output":
        outputGiven = true;
        if (value !== "-") writes.push(value);
        break;
      case "output-cwd":
        cwdWrite = true;
        break;
      case "output-dir":
        outDir = value;
        break;
      case "write-file":
        if (value !== "-") writes.push(value);
        break;
    }
  }
  if (mutate) return { ...remote(`${name} sends data or uses a mutating method`), readArgs: reads };
  if (fileRef !== undefined) return unknown(`${name} ${fileRef} with an @-prefixed value reads the named file (R42)`);
  if (cookieFile) return unknown(`${name} -b/--cookie with a file name reads cookies from it (R42)`);
  if (badMethod) return unknown(`${name} with an unrecognized method`);
  if (urls.length === 0 || urls.some((u) => !R.NET_URL.test(u))) return unknown(`${name} without an http(s) URL`);
  if (name === "wget" && !outputGiven && !parsed.options.some((o) => o.name === "--spider")) cwdWrite = true;
  const pathArgs: string[] = [];
  for (const w of writes) {
    pathArgs.push(w);
    if (outDir !== undefined) pathArgs.push(`${outDir}/${w}`);
  }
  if (cwdWrite || (outDir !== undefined && writes.length > 0)) pathArgs.push(outDir ?? ".");
  if (pathArgs.length > 0) return { ...localWrite(`${name} writes a local file`, pathArgs, false), readArgs: [] };
  return { ...readOnly(`${name} fetch to stdout is read-only`), readArgs: [] };
}

function classifyGh(args: readonly string[]): Verdict {
  const remoteSub = args.find((a) => R.GH_REMOTE_SUBCOMMANDS.has(a));
  if (remoteSub !== undefined) return remote(`gh ${remoteSub} mutates GitHub state`);
  const idx = args.findIndex((a) => !a.startsWith("-"));
  const sub = idx < 0 ? undefined : args[idx];
  if (sub !== "api") return unknown(`gh ${sub ?? ""} is not in the rule tables`.trim());
  const rest = args.slice(idx + 1);
  if (hasShort(rest, "fF") || hasLong(rest, ["--field", "--raw-field", "--input"])) return remote("gh api with fields or input sends data");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    let method: string | undefined;
    if (a === "-X" || a === "--method") method = rest[i + 1] ?? "";
    else if (a.startsWith("--method=")) method = a.slice(9);
    else if (a.startsWith("-X")) method = a.slice(2);
    else if (a[0] === "-" && a[1] !== "-" && a.includes("X")) method = "";
    else if (a.startsWith("--") && "--method".startsWith(a.split("=")[0]!)) method = "";
    if (method !== undefined && method.toUpperCase() !== "GET") return remote("gh api with a non-GET method");
  }
  if (idx > 0) return unknown("gh options before api are not in the rule tables");
  const r = applyGrammar("gh api", rest, R.GH_API_GRAMMAR);
  if (!r.ok) return unknown(r.reason);
  return { ...readOnly("gh api GET is read-only"), readArgs: [] };
}

function classifyByName(name: string, args: readonly string[]): Verdict {
  const probes = lookup(R.VERSION_PROBES, name);
  if (probes?.some((p) => argvEqual(p, args))) return readOnly(`${name} version probe`);
  if (R.ALWAYS_UNKNOWN.has(name)) return unknown(`${name} runs or alters another command`);

  if (R.RECURSIVE_READERS.has(name)) return unknown(`${name} searches directories recursively and can read secrets (R23)`);
  const grammar = lookup(R.READ_ONLY_GRAMMARS, name);
  if (grammar) return classifyGrammar(name, args, grammar);
  if (R.PACKAGE_MANAGERS.has(name)) return classifyPackageManager(name, args);
  if (lookup(R.RUNNER_GRAMMARS, name) !== undefined) return classifyBin(name, args);
  if (R.DESTRUCTIVE_COMMANDS.has(name) || R.DESTRUCTIVE_PREFIXES.some((p) => name.startsWith(p))) {
    const outputs = name === "dd" ? args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)) : [];
    return destructive(`${name} is destructive`, outputs);
  }
  if (R.REMOTE_ALWAYS.has(name)) return remote(`${name} acts on a remote host`);
  if (R.CLOUD_CLIS.has(name)) return remote(`${name} mutates cloud state`);
  const remoteSubs = lookup(R.REMOTE_SUBCOMMANDS, name);
  if (remoteSubs) {
    const hit = args.find((a) => remoteSubs.includes(a));
    return hit ? remote(`${name} ${hit} mutates remote state`) : unknown(`${name} subcommand is not in the rule tables`);
  }

  switch (name) {
    case "find":
      return classifyFind(args);
    case "git":
      return classifyGit(args);
    case "npx":
      return classifyNpx(args);
    case "uv":
      if (startsWithArgs(args, R.UV_ALLOWLIST_PREFIX)) {
        const v = classifyBin("pytest", args.slice(R.UV_ALLOWLIST_PREFIX.length));
        return v.class === "local-write" ? { ...v, reasons: ["uv run pytest is allowlisted"] } : v;
      }
      if (R.UV_ALLOWLIST_EXACT.some((t) => argvEqual(t, args))) return localWrite(`uv ${args.join(" ")} is allowlisted`);
      return unknown("uv invocation is not allowlisted");
    case "go":
      return classifyGo(args);
    case "cargo":
      return classifyCargo(args);
    case "make":
      return args.length === 1 && R.MAKE_TARGETS.has(args[0]!) ? localWrite(`make ${args[0]} is allowlisted`) : unknown("make invocation is not allowlisted");
    case "mkdir":
      return classifyPathCommand(name, args, R.MKDIR_GRAMMAR, true);
    case "touch":
      return classifyPathCommand(name, args, R.TOUCH_GRAMMAR, true);
    case "tee":
      return classifyPathCommand(name, args, R.TEE_GRAMMAR, true);
    case "cp":
      return classifyPathCommand(name, args, R.CP_GRAMMAR, true);
    case "mv":
      return classifyPathCommand(name, args, R.MV_GRAMMAR, true);
    case "rmdir":
      return classifyPathCommand(name, args, R.RMDIR_GRAMMAR, false);
    case "rm":
      return classifyRm(args);
    case "sed":
      return classifySed(args);
    case "chmod":
      return hasShort(args, "R") || hasLong(args, ["--recursive"]) ? destructive("recursive chmod") : unknown("chmod is not allowlisted");
    case "curl":
    case "wget":
      return classifyNet(name, args);
    case "gh":
      return classifyGh(args);
    case "rsync":
      return positionals(args).some((a) => a.includes(":")) ? remote("rsync to or from a remote host") : unknown("local rsync is not allowlisted");
  }

  if (R.SHELLS.has(name)) {
    if (hasShort(args, "c")) return unknown(`${name} with inline code`);
    if (positionals(args).length === 0) return unknown(`${name} without a script reads commands from stdin`);
    return unknown(`${name} runs a script`);
  }
  if (R.INTERPRETERS.has(name) || /^python[0-9.]*$/.test(name)) return unknown(`${name} runs arbitrary code`);
  return unknown(`${name} is not in the rule tables`);
}

/** Lowercased basename without `.exe`/`.cmd`/`.bat`; undefined for an empty name. */
function commandName(argv0: string): string | undefined {
  const base = argv0.slice(argv0.lastIndexOf("/") + 1).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  return base === "" ? undefined : base;
}

function classifySegment(seg: Segment, ctx: CommandContext): Verdict & { inputPaths: string[] } {
  const argv0 = seg.argv[0];
  let v: Verdict;
  if (argv0 === undefined) {
    v = unknown("segment has no command word (assignment or redirection only)");
  } else {
    const name = commandName(argv0);
    v = name === undefined ? unknown("empty command word") : classifyByName(name, seg.argv.slice(1));
    if (name === "git" && v.class === "read-only" && ctx.gitHelpers !== undefined) {
      const args = seg.argv.slice(1);
      const h = ctx.gitHelpers;
      if (h.fsmonitor) {
        v = { ...v, class: "unknown", allowlisted: false, reasons: ["git is configured with a core.fsmonitor program that read commands would run (R58)"] };
      } else if (h.diff && !(args.includes("--no-ext-diff") && args.includes("--no-textconv"))) {
        v = {
          ...v,
          class: "unknown",
          allowlisted: false,
          reasons: ["git has a diff helper configured (diff.external, a textconv or GIT_EXTERNAL_DIFF); admitted only with --no-ext-diff and --no-textconv (R58)"],
        };
      }
    }
    const declared = ctx.projectCommands.some((pc) => argvEqual(pc, seg.argv));
    if (declared && !isHard(v.class)) {
      // The grammar's facts stay (content and directory checks); read facts fall back to the over-approximation.
      const { readArgs: _grammarReads, ...facts } = v;
      v = {
        ...facts,
        class: v.class === "read-only" ? "read-only" : "local-write",
        allowlisted: true,
        reasons: ["project-declared command"],
      };
    } else if (name !== argv0 && !isHard(v.class)) {
      v = unknown(`command word \`${argv0}\` is not a canonical command name (path, case or extension)`, v.pathArgs);
    }
    const injected = Object.keys(seg.assignments).filter((n) => !R.ALLOWED_ASSIGNMENTS.has(n));
    if (injected.length > 0) v = unknown(`environment assignment ${injected.join(", ")} is not allowed`, v.pathArgs);
  }
  let cls = v.class;
  const pathArgs = [...v.pathArgs];
  const inputPaths: string[] = [...(v.readPaths ?? [])];
  const reasons = [...v.reasons];
  for (const r of seg.redirections) {
    if (r.op === "2>&1" || R.NULL_TARGETS.has(r.target)) continue;
    (r.op === "<" ? inputPaths : pathArgs).push(r.target);
    if (R.NETWORK_TARGET_PREFIXES.some((p) => r.target.startsWith(p))) {
      cls = maxClass(cls, "remote-mutating");
      reasons.push(`redirection to ${r.target} opens a network connection`);
    }
    if (r.op !== "<") cls = maxClass(cls, "local-write");
  }
  const allowlisted = v.allowlisted && (cls === "read-only" || cls === "local-write");
  const { readPaths: _readPaths, ...rest } = v;
  return { ...rest, class: cls, allowlisted, reasons, pathArgs, inputPaths };
}

/**
 * R28: a copy or move whose result can contain a symbolic link that a later segment then follows. Any `mv` counts
 * (a moved directory or symlink keeps its links; whether the source is a directory is not known here).
 */
function plantsLinks(argv: readonly string[]): string | undefined {
  const name = argv[0] === undefined ? undefined : commandName(argv[0]);
  const args = argv.slice(1);
  if (name === "mv") return "mv keeps symbolic links";
  if (name !== "cp") return undefined;
  const preserve = args.some((a) => /^--pr(e(s(e(r(ve?)?)?)?)?)?=/.test(a) && /\b(links|all)\b/.test(a.slice(a.indexOf("=") + 1)));
  const keeps = preserve || hasShort(args, R.CP_LINK_PRESERVING_SHORT) || hasLong(args, R.CP_LINK_PRESERVING_LONG);
  const derefs = hasShort(args, R.CP_DEREFERENCE_SHORT) || hasLong(args, R.CP_DEREFERENCE_LONG);
  return keeps && !derefs ? "cp copies symbolic links as links" : undefined;
}

/**
 * R32: a recursive copy that follows links copies the targets of links inside the tree (e.g. a committed
 * `evil/aws -> ~/.aws`) into the destination, where they are ordinary files; facts see only the top argument.
 * The only allowlisted recursive copier is `cp` (rsync, tar and the like are already unknown).
 */
function copiesLinkTargets(argv: readonly string[]): string | undefined {
  const name = argv[0] === undefined ? undefined : commandName(argv[0]);
  if (name !== "cp") return undefined;
  const args = argv.slice(1);
  const recursive = hasShort(args, R.CP_RECURSIVE_SHORT) || hasLong(args, R.CP_RECURSIVE_LONG);
  const derefs = hasShort(args, R.CP_DEREFERENCE_SHORT) || hasLong(args, R.CP_DEREFERENCE_LONG);
  return recursive && derefs ? "a recursive cp that follows links copies the targets of links inside the tree (R32)" : undefined;
}

export function classifyCommandLine(cmd: string, ctx: CommandContext): CommandClassification {
  const tok = tokenizeCommandLine(cmd);
  if (!tok.ok) {
    return {
      class: "unknown",
      segments: [],
      reasons: [`not classifiable: ${tok.reason}`],
      pathArgs: [],
      inputPaths: [],
      readArgs: [],
      logicalPaths: [],
      trackedContent: false,
      allowlisted: false,
    };
  }
  let cls: CommandClass = "read-only";
  let hard: HardClass | undefined;
  let allowlisted = true;
  const segments: SegmentClassification[] = [];
  const reasons: string[] = [];
  const pathArgs: string[] = [];
  const inputPaths: string[] = [];
  const readArgs: string[] = [];
  const logicalPaths: string[] = [];
  let trackedContent = false;
  const last = tok.segments.length - 1;
  tok.segments.forEach((seg, i) => {
    const v = classifySegment(seg, ctx);
    const planted = i < last ? plantsLinks(seg.argv) : undefined;
    const linkReasons = [
      ...(planted !== undefined ? [`${planted} and a later segment may follow them (R28)`] : []),
      ...[copiesLinkTargets(seg.argv)].filter((r): r is string => r !== undefined),
    ];
    if (linkReasons.length > 0) {
      if (severity(v.class) < severity("unknown")) v.class = "unknown";
      v.allowlisted = false;
      v.reasons = [...v.reasons, ...linkReasons];
    }
    // R40: a grammar's read facts are exact (any class: a remote curl upload reports its file); segments without a
    // grammar fall back to the R25 over-approximation when read-only or local-write.
    const segReadArgs = v.readArgs ?? (v.class === "read-only" || v.class === "local-write" ? extractReadArgs(seg.argv.slice(1)) : []);
    const nonEmpty = (k: "stagePaths" | "nonDirPaths" | "absentPaths" | "logicalPaths") => (v[k] !== undefined && v[k].length > 0 ? { [k]: [...v[k]] } : {});
    segments.push({
      argv: seg.argv,
      class: v.class,
      allowlisted: v.allowlisted,
      pathArgs: [...v.pathArgs],
      inputPaths: [...v.inputPaths],
      readArgs: [...segReadArgs],
      ...nonEmpty("stagePaths"),
      ...nonEmpty("nonDirPaths"),
      ...nonEmpty("absentPaths"),
      ...nonEmpty("logicalPaths"),
      ...(v.trackedContent === true ? { trackedContent: true } : {}),
    });
    for (const p of v.logicalPaths ?? []) if (!logicalPaths.includes(p)) logicalPaths.push(p);
    trackedContent ||= v.trackedContent === true;
    cls = maxClass(cls, v.class);
    if (isHard(v.class) && (hard === undefined || severity(v.class) > severity(hard))) hard = v.class;
    allowlisted &&= v.allowlisted;
    const label = seg.argv[0] ?? "(none)";
    for (const r of v.reasons) reasons.push(`segment ${i + 1} (${label}): ${r}`);
    for (const p of v.pathArgs) if (!pathArgs.includes(p)) pathArgs.push(p);
    for (const p of v.inputPaths) if (!inputPaths.includes(p)) inputPaths.push(p);
    for (const w of segReadArgs) if (!readArgs.includes(w)) readArgs.push(w);
  });
  const result: CommandClassification = { class: cls, segments, reasons, pathArgs, inputPaths, readArgs, logicalPaths, trackedContent, allowlisted };
  if (hard !== undefined) result.hardClass = hard;
  return result;
}
