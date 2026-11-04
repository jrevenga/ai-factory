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

export interface CommandContext {
  /** Project-declared runners, already tokenized to argv; matched by argv equality. */
  projectCommands: string[][];
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

interface ParsedOption {
  name: string;
  value?: string;
}

type OptionLookup = (name: string) => { value: boolean } | undefined;
type ParseResult = { ok: true; options: ParsedOption[]; positionals: string[] } | { ok: false; option: string };

/** getopt-style parser: unrecognized options fail so the caller can return `unknown`. */
function parseOptions(args: readonly string[], short: OptionLookup, long: OptionLookup): ParseResult {
  const options: ParsedOption[] = [];
  const pos: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (endOfOptions || a === "-" || !a.startsWith("-")) {
      pos.push(a);
    } else if (a === "--") {
      endOfOptions = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      const spec = long(name);
      if (!spec) return { ok: false, option: a };
      if (!spec.value) {
        if (eq >= 0) return { ok: false, option: a };
        options.push({ name });
      } else {
        const value = eq >= 0 ? a.slice(eq + 1) : args[++i];
        if (value === undefined) return { ok: false, option: a };
        options.push({ name, value });
      }
    } else {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        const spec = short(c);
        if (!spec) return { ok: false, option: a };
        if (!spec.value) {
          options.push({ name: `-${c}` });
          continue;
        }
        const rest = a.slice(j + 1);
        const value = rest !== "" ? rest : args[++i];
        if (value === undefined) return { ok: false, option: a };
        options.push({ name: `-${c}`, value });
        break;
      }
    }
  }
  return { ok: true, options, positionals: pos };
}

function parseWithSpec(args: readonly string[], spec: R.OptionSpec): ParseResult {
  return parseOptions(
    args,
    (c) => (spec.shortBool.includes(c) ? { value: false } : spec.shortValue.includes(c) ? { value: true } : undefined),
    (n) => (spec.longBool.includes(n) ? { value: false } : spec.longValue.includes(n) ? { value: true } : undefined),
  );
}

// --- per-command rules ---

function classifyReadOnly(name: string, args: readonly string[], rule: R.ReadOnlyRule): Verdict {
  const why = `${name} with this option ${rule.denyReason ?? R.DEFAULT_DENY_REASON}`;
  if (rule.denyLong && hasLong(args, rule.denyLong)) return unknown(why);
  if (rule.denyShort && hasShort(args, rule.denyShort)) return unknown(why);
  if (rule.maxPositionals !== undefined && positionals(args).length > rule.maxPositionals) {
    return unknown(`${name} with an output file argument`);
  }
  return readOnly(`${name} is read-only`);
}

function classifyFind(args: readonly string[]): Verdict {
  if (args.some((a) => R.FIND_DESTRUCTIVE_PREDICATES.has(a))) return destructive("find -delete removes files");
  if (args.some((a) => R.FIND_UNKNOWN_PREDICATES.has(a))) return unknown("find predicate executes a command or writes a file");
  return readOnly("find without action predicates is read-only");
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
 * intended: a word that is not a file costs only a fact.
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
  if (dirs.length > 0 && v.stagePaths !== undefined) {
    return unknown("git -C with git add: the staged paths resolve against another directory and cannot be checked (R37)", dirs);
  }
  if (dirs.length > 0) {
    if (v.class === "read-only") v.readPaths = [...dirs, ...(v.readPaths ?? [])];
    else v.pathArgs = [...dirs, ...v.pathArgs];
  }
  return v;
}

function classifyGitSubcommand(sub: string, rest: readonly string[]): Verdict {
  const readDeny = lookup(R.GIT_READ_ONLY, sub);
  if (readDeny) {
    const shortDeny = lookup(R.GIT_READ_ONLY_SHORT, sub);
    if ((readDeny.length > 0 && hasLong(rest, readDeny)) || (shortDeny !== undefined && hasShort(rest, shortDeny))) {
      return unknown(`git ${sub} with an option that writes, runs code, reads a named file or leaves the repository`);
    }
    // git diff falls back to --no-index on its own when a path lies outside the work tree.
    if (sub === "diff" && positionals(rest).some(mayLeaveWorkTree)) {
      return unknown("git diff with a path that may lie outside the work tree compares arbitrary files (implicit --no-index)");
    }
    return readOnly(`git ${sub} is read-only`);
  }
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
      if (rest[0] === "list") return readOnly("git stash list is read-only");
      if (rest[0] === "push") {
        const opts = rest.slice(1);
        if (hasShort(opts, R.GIT_STASH_UNTRACKED_SHORT) || hasLong(opts, R.GIT_STASH_UNTRACKED_LONG)) {
          return unknown("git stash with untracked or ignored files stores them in git objects, secret files included (R37)");
        }
        return localWrite("git stash push is allowlisted");
      }
      if (rest[0] === "drop" || rest[0] === "clear") return destructive(`git stash ${rest[0]} discards stashed work`);
      return unknown("git stash other than push/list");
    }
    case "restore": {
      if (hasShort(rest, "W") || hasLong(rest, ["--worktree"])) return destructive("git restore --worktree discards changes");
      if (hasShort(rest, "S") || hasLong(rest, ["--staged"])) return localWrite("git restore --staged is allowlisted");
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
  const parsed = parseWithSpec(rest, R.GIT_COMMIT_SPEC);
  if (!parsed.ok) return unknown(`git commit ${parsed.option} may stage or read files (R37)`);
  if (parsed.positionals.length > 0) return unknown("git commit with pathspecs stages those paths, secret files included (R37)");
  return localWrite("git commit is allowlisted");
}

function classifyBin(bin: string, rest: readonly string[]): Verdict {
  if (R.ANY_ARGS_RUNNERS.has(bin)) return localWrite(`${bin} is an allowlisted runner`);
  if (bin === "prettier") {
    if (rest.some((a) => R.PRETTIER_WRITE.includes(a))) return localWrite("prettier --write is allowlisted", positionals(rest));
    return rest.some((a) => R.PRETTIER_REQUIRED.includes(a))
      ? localWrite("prettier --check is allowlisted")
      : unknown("prettier without --check or --write");
  }
  return unknown(`${bin} is not an allowlisted runner`);
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
  const rest = args.slice(1);
  const flagName = (a: string): string => (a.startsWith("--") ? a.slice(1) : a);
  if (rest.some((a) => R.GO_DENY.some((d) => flagName(a) === d || flagName(a).startsWith(`${d}=`)))) {
    return unknown("go option runs another program");
  }
  const outputs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const f = flagName(rest[i]!);
    if (f === "-o" && rest[i + 1] !== undefined) outputs.push(rest[i + 1]!);
    else if (f.startsWith("-o=")) outputs.push(f.slice(3));
  }
  return localWrite(`go ${sub} is allowlisted`, outputs);
}

function classifyCargo(args: readonly string[]): Verdict {
  const sub = args[0];
  if (sub === undefined || !R.CARGO_SUBCOMMANDS.has(sub)) return unknown("cargo subcommand is not allowlisted");
  if (args.some((a) => R.CARGO_DENY.some((d) => a === d || a.startsWith(`${d}=`) || (d === "-Z" && a.startsWith("-Z"))))) {
    return unknown("cargo option injects configuration");
  }
  return localWrite(`cargo ${sub} is allowlisted`);
}

function classifyPathCommand(name: string, args: readonly string[], spec: R.OptionSpec, allowlisted: boolean): Verdict {
  const parsed = parseWithSpec(args, spec);
  if (!parsed.ok) return unknown(`${name}: unrecognized option ${parsed.option}`, positionals(args));
  const targets = parsed.options.filter((o) => R.TARGET_DIRECTORY_OPTIONS.has(o.name) && o.value !== undefined).map((o) => o.value!);
  return localWrite(`${name} writes local files`, [...targets, ...parsed.positionals], allowlisted);
}

function classifyRm(args: readonly string[]): Verdict {
  if (hasShort(args, "rR") || hasLong(args, ["--recursive", "--no-preserve-root"])) {
    return destructive("recursive rm", positionals(args));
  }
  return classifyPathCommand("rm", args, R.RM_SPEC, false);
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
      if (!/^[A-Za-z0-9._-]*$/.test(suffix)) return unknown("sed -i backup suffix with a path");
      inPlace = true;
    }
  }
  if (!inPlace) return unknown("sed without -i");
  const parsed = parseWithSpec(remaining, R.SED_SPEC);
  if (!parsed.ok) return unknown(`sed: unrecognized option ${parsed.option}`);
  const scripts = parsed.options.filter((o) => o.name === "-e").map((o) => o.value!);
  const files = [...parsed.positionals];
  if (scripts.length === 0 && files.length > 0) scripts.push(files.shift()!);
  if (scripts.length !== 1 || !isPlainSubstitution(scripts[0]!)) return unknown("sed script other than one plain s/re/repl/flags");
  if (files.length === 0) return unknown("sed -i without files");
  return localWrite("sed -i with a plain substitution is allowlisted", files);
}

function classifyNet(name: "curl" | "wget", args: readonly string[]): Verdict {
  const spec = name === "curl" ? R.CURL_SPEC : R.WGET_SPEC;
  const effects = new Map<string, R.NetEffect>();
  const parsed = parseOptions(
    args,
    (c) => {
      const s = lookup(spec.short, c);
      if (s) effects.set(`-${c}`, s.effect);
      return s;
    },
    (n) => {
      const s = lookup(spec.long, n);
      if (s) effects.set(n, s.effect);
      return s;
    },
  );
  if (!parsed.ok) return unknown(`${name}: unrecognized option ${parsed.option}`);
  let mutate = false;
  let config = false;
  let badMethod = false;
  let cwdWrite = false;
  let outputGiven = false;
  let outDir: string | undefined;
  const writes: string[] = [];
  const urls = [...parsed.positionals];
  for (const o of parsed.options) {
    const value = o.value ?? "";
    switch (effects.get(o.name)) {
      case "mutate":
        mutate = true;
        break;
      case "config":
        config = true;
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
      default:
        if (o.name === "--url") urls.push(value);
    }
  }
  if (mutate) return remote(`${name} sends data or uses a mutating method`);
  if (config) return unknown(`${name} reads options from a config file or executes commands`);
  if (badMethod) return unknown(`${name} with an unrecognized method`);
  if (urls.length === 0 || urls.some((u) => !R.NET_URL.test(u))) return unknown(`${name} without an http(s) URL`);
  if (name === "wget" && !outputGiven && !parsed.options.some((o) => o.name === "--spider")) cwdWrite = true;
  const pathArgs: string[] = [];
  for (const w of writes) {
    pathArgs.push(w);
    if (outDir !== undefined) pathArgs.push(`${outDir}/${w}`);
  }
  if (cwdWrite || (outDir !== undefined && writes.length > 0)) pathArgs.push(outDir ?? ".");
  if (pathArgs.length > 0) return localWrite(`${name} writes a local file`, pathArgs, false);
  return readOnly(`${name} fetch to stdout is read-only`);
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
  return readOnly("gh api GET is read-only");
}

function classifyByName(name: string, args: readonly string[]): Verdict {
  const probes = lookup(R.VERSION_PROBES, name);
  if (probes?.some((p) => argvEqual(p, args))) return readOnly(`${name} version probe`);
  if (R.ALWAYS_UNKNOWN.has(name)) return unknown(`${name} runs or alters another command`);

  if (R.RECURSIVE_READERS.has(name)) return unknown(`${name} searches directories recursively and can read secrets (R23)`);
  const rule = lookup(R.READ_ONLY_COMMANDS, name);
  if (rule) return classifyReadOnly(name, args, rule);
  if (R.PACKAGE_MANAGERS.has(name)) return classifyPackageManager(name, args);
  if (R.ANY_ARGS_RUNNERS.has(name) || name === "prettier") return classifyBin(name, args);
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
      if (startsWithArgs(args, R.UV_ALLOWLIST_PREFIX) || R.UV_ALLOWLIST_EXACT.some((t) => argvEqual(t, args))) {
        return localWrite(`uv ${args.slice(0, 2).join(" ")} is allowlisted`);
      }
      return unknown("uv invocation is not allowlisted");
    case "go":
      return classifyGo(args);
    case "cargo":
      return classifyCargo(args);
    case "make":
      return args.length === 1 && R.MAKE_TARGETS.has(args[0]!) ? localWrite(`make ${args[0]} is allowlisted`) : unknown("make invocation is not allowlisted");
    case "mkdir":
      return classifyPathCommand(name, args, R.MKDIR_SPEC, true);
    case "touch":
      return classifyPathCommand(name, args, R.TOUCH_SPEC, true);
    case "tee":
      return classifyPathCommand(name, args, R.TEE_SPEC, true);
    case "cp":
      return classifyPathCommand(name, args, R.CP_SPEC, true);
    case "mv":
      return classifyPathCommand(name, args, R.MV_SPEC, true);
    case "rmdir":
      return classifyPathCommand(name, args, R.RMDIR_SPEC, false);
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
    const declared = ctx.projectCommands.some((pc) => argvEqual(pc, seg.argv));
    if (declared && !isHard(v.class)) {
      v = {
        class: v.class === "read-only" ? "read-only" : "local-write",
        allowlisted: true,
        reasons: ["project-declared command"],
        pathArgs: v.pathArgs,
        ...(v.readPaths ? { readPaths: v.readPaths } : {}),
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
  return { class: cls, allowlisted, reasons, pathArgs, inputPaths, ...(v.stagePaths !== undefined ? { stagePaths: v.stagePaths } : {}) };
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
    const segReadArgs = v.class === "read-only" || v.class === "local-write" ? extractReadArgs(seg.argv.slice(1)) : [];
    segments.push({
      argv: seg.argv,
      class: v.class,
      allowlisted: v.allowlisted,
      pathArgs: [...v.pathArgs],
      inputPaths: [...v.inputPaths],
      readArgs: segReadArgs,
      ...(v.stagePaths !== undefined && v.stagePaths.length > 0 ? { stagePaths: [...v.stagePaths] } : {}),
    });
    cls = maxClass(cls, v.class);
    if (isHard(v.class) && (hard === undefined || severity(v.class) > severity(hard))) hard = v.class;
    allowlisted &&= v.allowlisted;
    const label = seg.argv[0] ?? "(none)";
    for (const r of v.reasons) reasons.push(`segment ${i + 1} (${label}): ${r}`);
    for (const p of v.pathArgs) if (!pathArgs.includes(p)) pathArgs.push(p);
    for (const p of v.inputPaths) if (!inputPaths.includes(p)) inputPaths.push(p);
    for (const w of segReadArgs) if (!readArgs.includes(w)) readArgs.push(w);
  });
  const result: CommandClassification = { class: cls, segments, reasons, pathArgs, inputPaths, readArgs, allowlisted };
  if (hard !== undefined) result.hardClass = hard;
  return result;
}
