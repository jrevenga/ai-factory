// Command rule tables (Phase 2 rulings 1, 2, 17, 18). Data only; interpreted by command.ts.
// Command names are matched on the normalized basename (lowercase, without .exe/.cmd/.bat).
// Anything not covered here classifies as `unknown`.

/** Leading `NAME=value` assignments that keep a segment classifiable (ruling 17). */
export const ALLOWED_ASSIGNMENTS: ReadonlySet<string> = new Set([
  "CI", "NODE_ENV", "FORCE_COLOR", "NO_COLOR", "TZ", "LANG", "LC_ALL", "TERM",
]);

/** Wrappers and builtins that run or alter other commands: always `unknown` (ruling 1). */
export const ALWAYS_UNKNOWN: ReadonlySet<string> = new Set([
  "eval", "exec", "source", ".", "command", "builtin", "env", "xargs", "sudo", "doas", "nohup", "time",
  "timeout", "watch", "nice",
]);

/** Shells and interpreters: always `unknown`; listed for precise reasons (ruling 1). */
export const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"]);
export const INTERPRETERS: ReadonlySet<string> = new Set([
  "node", "python", "python3", "py", "perl", "ruby", "pwsh", "powershell", "cmd", "deno", "bun",
]);

// --- option grammar (R40) ---
//
// Every allowlisted program (and git subcommand) declares the options it accepts. command.ts parses the arguments
// against the grammar: short bundles letter by letter (a value option takes the rest of the bundle or the next word),
// `--long=value` and `--long value`, `--` ends the options. ANY option not in the grammar makes the command `unknown`;
// long options match exactly (GNU and git abbreviations are unmodelled, so `unknown`). Value kinds decide the facts.

/** What an option is. */
export type Opt =
  /** Takes no value. */
  | "flag"
  /** The value names a file the program reads: reported in `readArgs` (the gate secret-checks it). */
  | "read-path"
  /** The value names a file the program writes: reported in `pathArgs`. */
  | "write-path"
  /** The value is not a path (a count, a pattern, a format): no fact. */
  | "opaque"
  /** An optional value, only attached (`-U5`, `-M50%`) or after `=` (`--color=always`): no fact. */
  | "opt-opaque"
  /** The option makes the command `unknown`, for this reason. */
  | { reject: string }
  /**
   * A value that must match `pattern`, otherwise the command is `unknown` for `reason` (no fact). `optional`: the value
   * is attached or after `=` only, as for `opt-opaque` (`cp --preserve[=ATTRS]`).
   */
  | { pattern: RegExp; reason: string; optional?: boolean };

export type OperandKind = "read-path" | "write-path" | "opaque";

export interface Grammar {
  /** Short option letters. */
  short?: Readonly<Record<string, Opt>>;
  /** Long options, spelled exactly with their dashes (`--all`; `-name` for go flags). */
  long?: Readonly<Record<string, Opt>>;
  /** What the operands are. `-` (stdin) is never a fact. */
  operands: OperandKind;
  /** Leading operands that are not files (a grep pattern, a jq filter), unless one of `unless` was given. */
  leading?: { count: number; unless?: readonly string[] };
  /** Leading operands matching `pattern` make the command `unknown` (jq modules, the environment). */
  leadingReject?: { pattern: RegExp; reason: string };
  /** Maximum number of (non-leading) operands; more is `unknown` (an extra operand can be an output file). */
  max?: number;
  /** Every (non-leading) operand must match; otherwise `unknown`. */
  pattern?: RegExp;
  /** `-NUM` shorthand (`head -5`, `git log -3`). */
  numeric?: boolean;
  /**
   * Where options may appear: `permute` (GNU, default: anywhere before `--`), `posix` (options end at the first
   * operand: `echo`, `printf`), `strict` (an option after an operand is `unknown`: BSD getopt would take it as an
   * operand, and for uniq that operand is the output file).
   */
  order?: "permute" | "posix" | "strict";
  /** go flag syntax: `-name`, `--name`, `-name=value`, `-name value`; `long` keys are spelled `-name`. */
  goFlags?: boolean;
  /** Every word is an operand (`test`). */
  noOptions?: boolean;
  /** R43: operands must be known non-directories at the gate (directory operands read or write descendants). */
  nonDirOperands?: boolean;
  /** Each word after `--` must match (cargo passes them to the test binary or a tool); otherwise `unknown`. */
  afterDoubleDash?: RegExp;
  /**
   * The first (non-leading) operand must match `pattern`, otherwise `unknown` for `reason`. `nonDir`: it is also a read
   * fact and must be a known non-directory at the gate (R47: a bare `git fetch` repository name that is a directory).
   */
  firstOperand?: { pattern: RegExp; reason: string; nonDir?: boolean };
  /**
   * The bash `echo` builtin: a word that is not entirely made of known option letters is text, and so is every later
   * word (`echo --version` prints `--version`). Nothing is ever an unrecognized option.
   */
  unknownAsText?: boolean;
}

const F = "flag";
const RP = "read-path";
const WP = "write-path";
const O = "opaque";
const OO = "opt-opaque";
const reject = (reason: string): Opt => ({ reject: reason });
/** One entry per letter. */
function each(letters: string, kind: Opt): Record<string, Opt> {
  return Object.fromEntries([...letters].map((c) => [c, kind]));
}
/** One entry per name. */
function all(names: readonly string[], kind: Opt): Record<string, Opt> {
  return Object.fromEntries(names.map((n) => [n, kind]));
}

const FILE_LIST = reject("reads a list of file names from a file or stdin, which the gate never sees (R24)");
const INDIRECT = reject("reads files beyond its explicit path arguments (recursion or an option-named pattern file), which can reach secrets (R23, R24)");
const WRITES_FILE = reject("writes a file named by an option value");
const RUNS_CODE = reject("runs another program or loads code");
const MODULES = reject("loads modules that can import any file (R43)");

/** Read-only programs (ruling 2, R40). Path operands are read facts. */
export const READ_ONLY_GRAMMARS: Readonly<Record<string, Grammar>> = {
  // R44: -R/--recursive, -L and -H list names and metadata only (documented exception, README Task 14).
  ls: {
    short: { ...each("aAlh1dFptrSiRLHsngoGcuUXvCmxQNbqkZ", F), ...each("IwT", O) },
    long: {
      ...all(
        [
          "--all", "--almost-all", "--human-readable", "--si", "--classify", "--directory", "--recursive", "--dereference",
          "--dereference-command-line", "--dereference-command-line-symlink-to-dir", "--size", "--inode", "--reverse",
          "--group-directories-first", "--full-time", "--numeric-uid-gid", "--no-group", "--literal", "--escape", "--quote-name",
          "--hide-control-chars", "--show-control-chars", "--ignore-backups", "--kibibytes", "--author", "--context", "--file-type",
        ],
        F,
      ),
      ...all(["--sort", "--time-style", "--format", "--block-size", "--ignore", "--hide", "--width", "--tabsize", "--quoting-style", "--indicator-style", "--time"], O),
      ...all(["--color", "--colour", "--hyperlink"], OO),
    },
    operands: RP,
  },
  cat: {
    short: each("nbsETAvetu", F),
    long: all(["--number", "--number-nonblank", "--squeeze-blank", "--show-ends", "--show-tabs", "--show-all", "--show-nonprinting"], F),
    operands: RP,
  },
  head: {
    short: { ...each("qvz", F), ...each("nc", O) },
    long: { ...all(["--quiet", "--silent", "--verbose", "--zero-terminated"], F), ...all(["--lines", "--bytes"], O) },
    operands: RP,
    numeric: true,
  },
  // No -f/-F/--follow: it never returns.
  tail: {
    short: { ...each("qvz", F), ...each("nc", O) },
    long: { ...all(["--quiet", "--silent", "--verbose", "--zero-terminated"], F), ...all(["--lines", "--bytes"], O) },
    operands: RP,
    numeric: true,
  },
  wc: {
    short: each("lwcmL", F),
    long: { ...all(["--lines", "--words", "--bytes", "--chars", "--max-line-length"], F), "--total": O, "--files0-from": FILE_LIST },
    operands: RP,
  },
  sort: {
    short: {
      ...each("bdfgiMhnRrVcCmsuz", F),
      ...each("ktS", O),
      o: WRITES_FILE,
      T: reject("writes temporary spill files into the named directory (R43)"),
    },
    long: {
      ...all(
        [
          "--ignore-leading-blanks", "--dictionary-order", "--ignore-case", "--general-numeric-sort", "--ignore-nonprinting",
          "--month-sort", "--human-numeric-sort", "--numeric-sort", "--random-sort", "--reverse", "--version-sort", "--merge",
          "--stable", "--unique", "--zero-terminated", "--debug",
        ],
        F,
      ),
      "--check": OO,
      ...all(["--key", "--field-separator", "--buffer-size", "--sort", "--parallel"], O),
      "--random-source": RP,
      "--output": WRITES_FILE,
      "--temporary-directory": reject("writes temporary spill files into the named directory (R43)"),
      "--compress-program": RUNS_CODE,
      "--files0-from": FILE_LIST,
    },
    operands: RP,
  },
  // A second operand is the output file (finding 1).
  uniq: {
    short: { ...each("cduizD", F), ...each("fsw", O) },
    long: {
      ...all(["--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated"], F),
      ...all(["--all-repeated", "--group"], OO),
      ...all(["--skip-fields", "--skip-chars", "--check-chars"], O),
    },
    operands: RP,
    max: 1,
    order: "strict",
  },
  cut: {
    short: { ...each("snz", F), ...each("bcfd", O) },
    long: {
      ...all(["--complement", "--only-delimited", "--zero-terminated"], F),
      ...all(["--bytes", "--characters", "--fields", "--delimiter", "--output-delimiter"], O),
    },
    operands: RP,
  },
  // tr reads stdin only; its operands are character sets.
  tr: {
    short: each("cCdst", F),
    long: all(["--complement", "--delete", "--squeeze-repeats", "--truncate-set1"], F),
    operands: O,
    max: 2,
  },
  grep: {
    short: {
      ...each("iyvwxclLnhHoqsbaIEFGPzZUT", F),
      ...each("emABCD", O),
      ...each("rRdf", INDIRECT),
    },
    long: {
      ...all(
        [
          "--ignore-case", "--no-ignore-case", "--invert-match", "--word-regexp", "--line-regexp", "--count", "--files-with-matches",
          "--files-without-match", "--line-number", "--no-filename", "--with-filename", "--only-matching", "--quiet", "--silent",
          "--no-messages", "--byte-offset", "--text", "--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp",
          "--null", "--null-data", "--line-buffered", "--initial-tab", "--binary",
        ],
        F,
      ),
      ...all(["--regexp", "--max-count", "--after-context", "--before-context", "--context", "--label", "--binary-files", "--devices", "--include", "--exclude", "--exclude-dir"], O),
      ...all(["--color", "--colour"], OO),
      "--exclude-from": RP,
      ...all(["--recursive", "--dereference-recursive", "--directories", "--file"], INDIRECT),
    },
    operands: RP,
    leading: { count: 1, unless: ["-e", "--regexp"] },
    numeric: true,
  },
  // R44: -L/--follow traverse names only. The first operand is the pattern.
  fd: {
    short: { ...each("HIsigFaLp0u", F), ...each("etdESjc", O), ...each("xX", RUNS_CODE) },
    long: {
      ...all(
        [
          "--hidden", "--no-ignore", "--no-ignore-vcs", "--case-sensitive", "--ignore-case", "--glob", "--regex", "--fixed-strings",
          "--absolute-path", "--follow", "--full-path", "--print0", "--unrestricted", "--show-errors", "--one-file-system",
        ],
        F,
      ),
      ...all(["--extension", "--type", "--max-depth", "--min-depth", "--exact-depth", "--exclude", "--size", "--changed-within", "--changed-before", "--max-results", "--threads", "--color", "--owner"], O),
      ...all(["--search-path", "--ignore-file"], RP),
      ...all(["--exec", "--exec-batch"], RUNS_CODE),
      "--base-directory": reject("changes the directory the paths resolve against"),
    },
    operands: RP,
    leading: { count: 1 },
  },
  // R44: -l follows links (names only).
  tree: {
    short: { ...each("adfilxpshugDFqNQvtrUCnAS", F), ...each("LPI", O), o: WRITES_FILE, R: WRITES_FILE },
    long: {
      ...all(["--noreport", "--dirsfirst", "--filesfirst", "--du", "--prune", "--si", "--inodes", "--device"], F),
      ...all(["--charset", "--filelimit", "--timefmt", "--sort"], O),
      "--fromfile": FILE_LIST,
    },
    operands: RP,
  },
  pwd: { short: each("LP", F), operands: O, max: 0 },
  which: { short: each("as", F), operands: O },
  whereis: { short: each("bmsul", F), operands: O },
  type: { short: each("afpPt", F), operands: O },
  // R44: -L reports the link target's type. `-m` echoes the magic file in warnings (R25).
  file: {
    short: { ...each("bihLkNn0rszZE", F), ...each("eFP", O), C: WRITES_FILE, f: FILE_LIST, m: reject("echoes the magic file named by its value in warnings (R25)") },
    long: {
      ...all(
        [
          "--brief", "--mime", "--mime-type", "--mime-encoding", "--no-dereference", "--dereference", "--keep-going", "--no-pad",
          "--no-buffer", "--print0", "--raw", "--special-files", "--uncompress", "--uncompress-noreport", "--extension", "--apple",
        ],
        F,
      ),
      ...all(["--exclude", "--exclude-quiet", "--separator", "--parameter"], O),
      "--compile": WRITES_FILE,
      "--files-from": FILE_LIST,
      "--magic-file": reject("echoes the magic file named by its value in warnings (R25)"),
    },
    operands: RP,
  },
  // R44: -L reports the link target's metadata.
  stat: {
    short: { ...each("Lft", F), c: O },
    long: { ...all(["--dereference", "--file-system", "--terse"], F), ...all(["--format", "--printf", "--cached"], O) },
    operands: RP,
  },
  // R44: -L/-H report sizes through links (metadata).
  du: {
    short: { ...each("abchkmsxlLHDPS0", F), ...each("dBt", O), X: RP },
    long: {
      ...all(
        [
          "--all", "--apparent-size", "--bytes", "--total", "--human-readable", "--si", "--summarize", "--one-file-system",
          "--count-links", "--dereference", "--dereference-args", "--no-dereference", "--separate-dirs", "--null", "--inodes",
        ],
        F,
      ),
      ...all(["--max-depth", "--block-size", "--threshold", "--exclude", "--time-style"], O),
      "--time": OO,
      "--exclude-from": RP,
      "--files0-from": FILE_LIST,
    },
    operands: RP,
  },
  df: {
    short: { ...each("ahHiklPT", F), ...each("txB", O) },
    long: {
      ...all(["--all", "--human-readable", "--si", "--inodes", "--local", "--portability", "--print-type", "--total", "--sync", "--no-sync"], F),
      ...all(["--type", "--exclude-type", "--block-size"], O),
      "--output": OO,
    },
    operands: RP,
  },
  echo: { short: each("neE", F), operands: O, order: "posix", unknownAsText: true },
  printf: { short: { v: reject("assigns a shell variable") }, operands: O, order: "posix" },
  true: { operands: O, order: "posix" },
  false: { operands: O, order: "posix" },
  // `test` has an expression grammar, not options; its operands may name files (metadata only).
  test: { operands: RP, noOptions: true },
  basename: { short: { ...each("az", F), s: O }, long: { ...all(["--multiple", "--zero"], F), "--suffix": O }, operands: O },
  dirname: { short: each("z", F), long: all(["--zero"], F), operands: O },
  realpath: {
    short: each("emLPqsz", F),
    long: {
      ...all(["--canonicalize-existing", "--canonicalize-missing", "--logical", "--physical", "--quiet", "--strip", "--no-symlinks", "--zero"], F),
      ...all(["--relative-to", "--relative-base"], RP),
    },
    operands: RP,
  },
  readlink: {
    short: each("femnqsvz", F),
    long: all(["--canonicalize", "--canonicalize-existing", "--canonicalize-missing", "--no-newline", "--quiet", "--silent", "--verbose", "--zero"], F),
    operands: RP,
  },
  // An operand other than `+FORMAT` sets the clock.
  date: {
    short: {
      ...each("uR", F),
      I: OO,
      d: O,
      r: RP,
      s: reject("sets the system clock"),
      f: reject("echoes every line of the named file in errors (R25)"),
    },
    long: {
      ...all(["--utc", "--universal", "--rfc-email", "--debug"], F),
      "--iso-8601": OO,
      ...all(["--rfc-3339", "--date"], O),
      "--reference": RP,
      "--set": reject("sets the system clock"),
      "--file": reject("echoes every line of the named file in errors (R25)"),
    },
    operands: O,
    max: 1,
    pattern: /^\+/,
  },
  sleep: { operands: O, pattern: /^[0-9.]+[smhd]?$/ },
  // R43: two directories compare their common children; -r recurses (INDIRECT).
  diff: {
    short: { ...each("qsuciwbBEZatTNpyd", F), ...each("UCWIFLxSD", O), X: RP, r: INDIRECT },
    long: {
      ...all(
        [
          "--brief", "--report-identical-files", "--ignore-case", "--ignore-tab-expansion", "--ignore-trailing-space",
          "--ignore-space-change", "--ignore-all-space", "--ignore-blank-lines", "--strip-trailing-cr", "--text", "--expand-tabs",
          "--initial-tab", "--suppress-blank-empty", "--new-file", "--unidirectional-new-file", "--show-c-function", "--side-by-side",
          "--left-column", "--suppress-common-lines", "--minimal", "--speed-large-files", "--normal", "--ed", "--rcs",
        ],
        F,
      ),
      ...all(
        [
          "--ignore-matching-lines", "--label", "--show-function-line", "--width", "--tabsize", "--exclude", "--starting-file",
          "--ifdef", "--old-line-format", "--new-line-format", "--unchanged-line-format", "--line-format", "--old-group-format",
          "--new-group-format", "--changed-group-format", "--unchanged-group-format", "--horizon-lines", "--palette",
        ],
        O,
      ),
      ...all(["--unified", "--context", "--color"], OO),
      "--exclude-from": RP,
      ...all(["--recursive", "--from-file", "--to-file"], INDIRECT),
    },
    operands: RP,
    max: 2,
    nonDirOperands: true,
  },
  cmp: {
    short: { ...each("bls", F), ...each("in", O) },
    long: { ...all(["--print-bytes", "--verbose", "--quiet", "--silent"], F), ...all(["--ignore-initial", "--bytes"], O) },
    operands: RP,
    max: 4,
  },
  // The first operand is the filter. `--rawfile`/`--slurpfile`/`-f` read files named by option values; `-L` and
  // `include`/`import` load modules (R43); `env`/`$ENV` print the environment.
  jq: {
    short: { ...each("nrjascCMSeR", F), L: MODULES, f: INDIRECT, i: WRITES_FILE },
    long: {
      ...all(
        [
          "--null-input", "--raw-input", "--slurp", "--compact-output", "--tab", "--color-output", "--monochrome-output",
          "--ascii-output", "--sort-keys", "--raw-output", "--raw-output0", "--join-output", "--exit-status", "--seq", "--stream",
          "--stream-errors",
        ],
        F,
      ),
      "--indent": O,
      ...all(["--rawfile", "--slurpfile", "--from-file"], INDIRECT),
      "--in-place": WRITES_FILE,
    },
    operands: RP,
    leading: { count: 1 },
    // Builtins as filter tokens only: `.env`, `.a.include` are key paths (a `.` or a word character before them).
    leadingReject: {
      pattern: /(?<![.\w$])(?:import|include|modulemeta|get_search_list|env|input_filename)\b|\$ENV\b/,
      reason: "the filter loads modules or reads the environment (R43)",
    },
  },
};

/** Content searchers that recurse by default (`unknown`, R23): the grep read tool is the supported path. */
export const RECURSIVE_READERS: ReadonlySet<string> = new Set(["rg"]);

// --- find (expression grammar, R40) ---

/** Options before the start points. R44: -L/-H follow links (names and metadata only). */
export const FIND_GLOBAL: Readonly<Record<string, Opt>> = { "-H": F, "-L": F, "-P": F, "-D": O };
/** Primaries that take no value. R44: -follow. */
export const FIND_FLAGS: ReadonlySet<string> = new Set([
  "-empty", "-executable", "-readable", "-writable", "-nouser", "-nogroup", "-true", "-false", "-prune", "-quit", "-print",
  "-print0", "-ls", "-depth", "-d", "-mount", "-xdev", "-follow", "-noleaf", "-daystart", "-ignore_readdir_race",
  "-noignore_readdir_race", "-warn", "-nowarn", "-a", "-o", "-and", "-or", "-not",
]);
/** Primaries that take one value, and its kind. */
export const FIND_VALUES: Readonly<Record<string, Opt>> = {
  ...all(
    [
      "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname", "-type", "-xtype",
      "-size", "-perm", "-user", "-group", "-uid", "-gid", "-links", "-inum", "-mtime", "-mmin", "-atime", "-amin", "-ctime",
      "-cmin", "-used", "-maxdepth", "-mindepth", "-fstype", "-regextype", "-context", "-printf",
    ],
    O,
  ),
  ...all(["-newer", "-anewer", "-cnewer", "-samefile"], RP),
  ...all(["-exec", "-execdir", "-ok", "-okdir"], RUNS_CODE),
  ...all(["-fprint", "-fprint0", "-fprintf", "-fls"], WRITES_FILE),
  "-files0-from": FILE_LIST,
};
/** `-newerXY`: a reference file, or a literal time when Y is `t`. */
export const FIND_NEWER_FILE = /^-newer[aBcm][aBcm]$/;
export const FIND_NEWER_TIME = /^-newer[aBcm]t$/;
export const FIND_DESTRUCTIVE_PREDICATES: ReadonlySet<string> = new Set(["-delete"]);

/** Exact argument vectors that are read-only version probes. */
export const VERSION_PROBES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  node: [["--version"], ["-v"]],
  npm: [["--version"], ["-v"]],
  pnpm: [["--version"]],
  yarn: [["--version"]],
  bun: [["--version"]],
  git: [["--version"]],
  aws: [["--version"]],
  gcloud: [["--version"]],
  az: [["--version"]],
};

// --- git ---

/** Global options accepted before the subcommand. `-C` is handled separately (R41: unknown). */
export const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks"]);
/** Options that inject configuration or redirect the repository: always `unknown`. */
export const GIT_INJECTION_LONG: readonly string[] = ["--config-env", "--exec-path", "--git-dir", "--work-tree"];
/** Options that read a path list from a file or stdin, anywhere on a git command line: always `unknown` (R24). */
export const GIT_FILE_LIST_LONG: readonly string[] = ["--pathspec-from-file"];
/**
 * R45: options git honours wherever they appear in its raw argv, whatever a grammar takes them for: `cmd_diff` scans
 * argv for `--no-index` before option parsing, so it cannot be hidden as another option's value. Global options
 * that change how pathspecs or the repository are read, and `--end-of-options`, are treated the same. Any of them
 * (exact, abbreviated, or `=value`) anywhere makes a non-hard git command `unknown`.
 */
export const GIT_RAW_SCANNED_LONG: readonly string[] = [
  "--no-index", "--end-of-options", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
  "--namespace", "--super-prefix", "--attr-source",
];

/** Diff output options shared by `git diff`, `git show` and `git log` (git's diff option parser). */
const GIT_DIFF_SHORT: Record<string, Opt> = {
  ...each("pusazRbwWD", F),
  // N2: -U takes an optional, attached-only value (git PARSE_OPT_OPTARG): a bare -U never consumes the next word.
  ...each("UMCBX", OO),
  ...each("lSGI", O),
  O: RP,
};
const GIT_DIFF_LONG: Record<string, Opt> = {
  ...all(
    [
      "--patch", "--no-patch", "--raw", "--patch-with-raw", "--patch-with-stat", "--numstat", "--shortstat", "--summary",
      "--name-only", "--name-status", "--full-index", "--binary", "--no-renames", "--text", "--ignore-cr-at-eol",
      "--ignore-space-at-eol", "--ignore-space-change", "--ignore-all-space", "--ignore-blank-lines", "--minimal", "--patience",
      "--histogram", "--no-color", "--no-ext-diff", "--no-textconv", "--textconv", "--pickaxe-all", "--pickaxe-regex",
      "--function-context", "--no-prefix", "--default-prefix", "--irreversible-delete", "--check", "--exit-code", "--quiet",
      "--compact-summary", "--indent-heuristic", "--no-indent-heuristic", "--no-relative",
    ],
    F,
  ),
  // Optional values, attached or after `=` only (checked against `git diff --no-index -h`, git 2.52).
  ...all(["--unified", "--stat", "--dirstat", "--color", "--word-diff", "--color-words", "--color-moved", "--abbrev", "--find-renames", "--find-copies", "--break-rewrites", "--relative"], OO),
  ...all(
    [
      "--inter-hunk-context", "--diff-filter", "--diff-algorithm", "--src-prefix", "--dst-prefix", "--line-prefix",
      "--ws-error-highlight", "--ignore-matching-lines", "--anchored", "--word-diff-regex", "--color-moved-ws", "--stat-width",
      "--stat-name-width", "--stat-count", "--stat-graph-width", "--find-object", "--rotate-to", "--skip-to",
    ],
    O,
  ),
  "--output": WRITES_FILE,
  "--ext-diff": reject("runs an external diff program"),
  "--orderfile": RP,
};
/** Revision-walk and log formatting options (`git log`, `git show`). */
const GIT_LOG_SHORT: Record<string, Opt> = { ...each("iEFPcmt", F), n: O, L: O };
const GIT_LOG_LONG: Record<string, Opt> = {
  ...all(
    [
      "--oneline", "--graph", "--all", "--reflog", "--abbrev-commit", "--no-abbrev-commit", "--reverse", "--first-parent", "--merges",
      "--no-merges", "--left-right", "--cherry-pick", "--cherry-mark", "--cherry", "--boundary", "--topo-order", "--date-order",
      "--author-date-order", "--no-decorate", "--follow", "--full-history", "--simplify-merges", "--dense", "--sparse", "--source",
      "--use-mailmap", "--no-mailmap", "--mailmap", "--log-size", "--parents", "--children", "--do-walk", "--regexp-ignore-case",
      "--invert-grep", "--all-match", "--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp", "--remove-empty",
      "--not", "--relative-date", "--no-notes", "--cc", "--full-diff", "--remerge-diff", "--combined-all-paths", "--show-pulls",
      "--no-expand-tabs", "--clear-decorations", "--no-walk",
    ],
    F,
  ),
  ...all(["--decorate", "--pretty", "--branches", "--tags", "--remotes", "--ancestry-path", "--expand-tabs"], OO),
  ...all(
    [
      "--max-count", "--skip", "--since", "--after", "--until", "--before", "--author", "--committer", "--grep", "--format",
      "--date", "--encoding", "--exclude", "--min-parents", "--max-parents", "--decorate-refs", "--decorate-refs-exclude",
      "--diff-merges",
    ],
    O,
  ),
};
/**
 * R41: diff options that print file contents (patches, line ranges, `--check`'s offending lines, N3) or select commits
 * by content (pickaxe). Verified with git 2.52: of the diff options, only -p/-u/--patch/-U/--unified/--patch-with-raw/
 * --patch-with-stat/--binary/--check/-c/--cc/--remerge-diff print content lines in `git log`; the rest are listed to
 * stay on the safe side.
 */
export const GIT_LOG_CONTENT: ReadonlySet<string> = new Set([
  "-p", "-u", "--patch", "-U", "--unified", "-W", "--function-context", "--word-diff", "--color-words", "-c", "--cc", "-m",
  "--full-diff", "--remerge-diff", "--diff-merges", "-S", "-G", "--binary", "--patch-with-raw", "--patch-with-stat", "-L",
  "--pickaxe-all", "--pickaxe-regex", "--check", "--inter-hunk-context", "--word-diff-regex",
]);
/**
 * Diff output formats that print names, counts or object ids, never content lines (verified with git 2.52). `git
 * diff`/`git show` with one of them and no GIT_LOG_CONTENT option print no file content, except that `git show`
 * prints a blob operand whatever the format (see GIT_SHOW_COMMIT_REVISION).
 */
export const GIT_NO_CONTENT_FORMATS: ReadonlySet<string> = new Set([
  "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--raw", "--summary", "--dirstat", "-X",
  "--compact-summary", "-s", "--no-patch", "--quiet",
]);
/** `git show` operands that can only name a commit (`HEAD`, or a `~`/`^` parent form): never a blob it would print. */
export const GIT_SHOW_COMMIT_REVISION = /^(?:HEAD|@|[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^][0-9]*)+)$/;

/** Allowlisted read-only git subcommands and their grammar (R40). Operands are revisions and pathspecs. */
export const GIT_READ_GRAMMARS: Readonly<Record<string, Grammar>> = {
  status: {
    short: { ...each("sbvz", F), u: OO },
    long: {
      ...all(["--short", "--branch", "--long", "--verbose", "--null", "--show-stash", "--ahead-behind", "--no-ahead-behind", "--renames", "--no-renames", "--no-column"], F),
      ...all(["--porcelain", "--untracked-files", "--ignored", "--ignore-submodules", "--column", "--find-renames"], OO),
    },
    operands: RP,
  },
  log: { short: { ...GIT_DIFF_SHORT, ...GIT_LOG_SHORT }, long: { ...GIT_DIFF_LONG, ...GIT_LOG_LONG }, operands: RP, numeric: true },
  show: { short: { ...GIT_DIFF_SHORT, ...GIT_LOG_SHORT }, long: { ...GIT_DIFF_LONG, ...GIT_LOG_LONG }, operands: RP, numeric: true },
  // `--no-index` compares arbitrary paths (directories recursively) and prints their contents (R24).
  diff: {
    short: GIT_DIFF_SHORT,
    long: { ...GIT_DIFF_LONG, ...all(["--cached", "--staged", "--merge-base"], F), "--no-index": reject("compares arbitrary paths outside the repository (R24)") },
    operands: RP,
  },
  "rev-parse": {
    short: each("q", F),
    long: {
      ...all(
        [
          "--show-toplevel", "--git-dir", "--git-common-dir", "--absolute-git-dir", "--is-inside-work-tree", "--is-inside-git-dir",
          "--is-bare-repository", "--is-shallow-repository", "--show-prefix", "--show-cdup", "--verify", "--quiet", "--symbolic",
          "--symbolic-full-name", "--all", "--revs-only", "--no-revs", "--flags", "--no-flags", "--show-superproject-working-tree",
          "--local-env-vars", "--sq", "--not", "--show-ref-format",
        ],
        F,
      ),
      ...all(["--abbrev-ref", "--short", "--branches", "--tags", "--remotes", "--show-object-format"], OO),
      ...all(["--path-format", "--since", "--until", "--after", "--before", "--default", "--git-path"], O),
      "--resolve-git-dir": RP,
    },
    operands: O,
  },
  "ls-files": {
    short: { ...each("cdmoiksutvfz", F), x: O, X: RP },
    long: {
      ...all(
        [
          "--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "--unmerged", "--killed", "--full-name",
          "--exclude-standard", "--error-unmatch", "--debug", "--eol", "--deduplicate", "--sparse", "--directory",
          "--no-empty-directory", "--recurse-submodules",
        ],
        F,
      ),
      ...all(["--exclude", "--with-tree", "--format"], O),
      "--abbrev": OO,
      "--exclude-from": RP,
      "--exclude-per-directory": reject("reads the named file in every directory as a pattern file, without a fact (N5)"),
    },
    operands: RP,
  },
  // `--contents` prints the named file; `-S` and `--ignore-revs-file` echo the named file in errors (R25).
  blame: {
    short: { ...each("ltsewnfcpb", F), ...each("MC", OO), L: O, S: reject("echoes the named graft file in errors (R25)") },
    long: {
      ...all(
        [
          "--root", "--show-stats", "--porcelain", "--line-porcelain", "--incremental", "--show-name", "--show-number", "--show-email",
          "--score-debug", "--reverse", "--first-parent", "--color-lines", "--color-by-age", "--progress", "--no-progress",
        ],
        F,
      ),
      ...all(["--date", "--ignore-rev", "--since"], O),
      "--abbrev": OO,
      "--contents": reject("prints the named file (R25)"),
      "--ignore-revs-file": reject("echoes the named file in errors (R25)"),
    },
    operands: RP,
  },
  describe: {
    long: {
      ...all(["--tags", "--all", "--long", "--always", "--exact-match", "--first-parent", "--contains"], F),
      ...all(["--abbrev", "--dirty", "--broken"], OO),
      ...all(["--candidates", "--match", "--exclude"], O),
    },
    operands: O,
  },
  // Remote and branch names only: a refspec with `:` writes local refs, a URL can name another transport. R47: the
  // repository is a remote name (no `/`, `.`, `~` or `:`: a path, a `<name>.git` directory, a bundle, `file://`).
  fetch: {
    short: { ...each("qvpta", F), j: O },
    long: {
      ...all(["--all", "--prune", "--prune-tags", "--tags", "--no-tags", "--quiet", "--verbose", "--dry-run", "--progress", "--no-progress"], F),
      ...all(["--depth", "--deepen", "--shallow-since", "--jobs"], O),
      "--upload-pack": RUNS_CODE,
    },
    operands: O,
    pattern: /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/,
    firstOperand: {
      pattern: /^[A-Za-z0-9_][A-Za-z0-9_-]*$/,
      reason: "the repository is a filesystem path or URL, not a remote name: the facts do not cover another repository (R47)",
      nonDir: true,
    },
  },
};
/** R41: git subcommands that print tracked file contents (always). `log` does with GIT_LOG_CONTENT; `status` with -v. */
export const GIT_CONTENT_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "show", "blame"]);

export const GIT_BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "-l", "--list", "--no-color", "--color",
]);
export const GIT_BRANCH_LIST_PREFIXES: readonly string[] = [
  "--sort=", "--format=", "--contains=", "--no-contains=", "--merged=", "--no-merged=", "--points-at=",
];
export const GIT_TAG_LIST_FLAGS: ReadonlySet<string> = new Set(["-l", "--list", "-n", "--no-color", "--color"]);
export const GIT_TAG_LIST_PREFIXES: readonly string[] = [
  "--sort=", "--format=", "--contains=", "--no-contains=", "--merged=", "--no-merged=", "--points-at=", "-n",
];
export const GIT_CONFIG_READ_FLAGS: ReadonlySet<string> = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
export const GIT_CONFIG_READ_MODIFIERS: ReadonlySet<string> = new Set([
  "--global", "--local", "--system", "--show-origin", "--show-scope", "--null", "-z", "--name-only", "--bool", "--int",
  "--path",
]);
export const GIT_PUSH_FORCE: readonly string[] = ["--force", "--force-with-lease", "--force-if-includes"];
/** R37: the only `git add` options allowed with explicit paths (exact spellings; anything else is `unknown`). */
export const GIT_ADD_SHORT = "vnNf";
export const GIT_ADD_LONG: readonly string[] = ["--verbose", "--dry-run", "--intent-to-add", "--force"];
/** R37: `git stash push` options that store untracked (or ignored) files. */
export const GIT_STASH_UNTRACKED_SHORT = "ua";
export const GIT_STASH_UNTRACKED_LONG: readonly string[] = ["--include-untracked", "--all"];
/** `git stash push` (after the R37 check). */
export const GIT_STASH_PUSH_GRAMMAR: Grammar = {
  short: { ...each("kqS", F), m: O },
  long: { ...all(["--keep-index", "--no-keep-index", "--quiet", "--staged"], F), "--message": O },
  operands: RP,
};
/** `git restore --staged` (after the destructive checks). */
export const GIT_RESTORE_STAGED_GRAMMAR: Grammar = {
  short: { ...each("Sq", F), s: O },
  long: { ...all(["--staged", "--quiet"], F), "--source": O },
  operands: RP,
};
/** R37: `git commit` options allowed (no `-a`/`--all`, `-i`/`-o`, `-F`, `-C`/`-c`, `--fixup`, ...); no pathspecs. */
export const GIT_COMMIT_GRAMMAR: Grammar = {
  short: { ...each("qvsn", F), m: O },
  long: {
    ...all(["--quiet", "--verbose", "--signoff", "--no-verify", "--allow-empty", "--allow-empty-message", "--no-edit"], F),
    ...all(["--message", "--author", "--date"], O),
  },
  operands: O,
  max: 0,
};

// --- package managers and runners (ruling 18) ---

export const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Exact argument vectors after any package manager that are allowlisted (project scripts). */
export const PACKAGE_MANAGER_ALLOWLIST: readonly (readonly string[])[] = [
  ["test"],
  ["run", "test"],
  ["run", "build"],
  ["run", "lint"],
  ["run", "typecheck"],
];
/**
 * Frozen installs, per manager (controller ruling R22): only flags the manager honours.
 * npm ignores `--frozen-lockfile`/`--immutable` and would run a full install, so npm gets `ci` only.
 */
export const PACKAGE_MANAGER_FROZEN_INSTALL: Readonly<Record<string, readonly (readonly string[])[]>> = {
  npm: [["ci"]],
  pnpm: [["install", "--frozen-lockfile"]],
  yarn: [["install", "--frozen-lockfile"], ["install", "--immutable"]],
  bun: [["install", "--frozen-lockfile"]],
};
/** Any of these arguments makes a package-manager invocation remote-mutating. */
export const PACKAGE_MANAGER_REMOTE: Readonly<Record<string, readonly string[]>> = {
  npm: ["publish", "unpublish", "deprecate", "dist-tag"],
  pnpm: ["publish"],
  yarn: ["publish"],
  bun: ["publish"],
};
/** Binaries reachable through `npx --no-install <bin>` / `npm exec --no -- <bin>`. */
export const NPX_BINS: ReadonlySet<string> = new Set(["vitest", "jest", "tsc", "eslint", "prettier"]);

/**
 * Runner grammars (ruling 18, R40). Runners execute project code by design; the grammar keeps out options that
 * write files the gate cannot see (output files, cache and output directories), load other code, or change the root.
 */
const OUTSIDE_WRITE = reject("writes files at a location named by an option value");
const CHANGES_ROOT = reject("changes the project root or config the runner loads");
export const RUNNER_GRAMMARS: Readonly<Record<string, Grammar>> = {
  vitest: {
    short: { ...each("u", F), ...each("t", O), c: RP },
    long: {
      ...all(["--run", "--coverage", "--passWithNoTests", "--update", "--allowOnly", "--globals", "--typecheck", "--no-file-parallelism", "--no-watch", "--no-color"], F),
      ...all(["--silent", "--watch", "--changed"], OO),
      ...all(["--reporter", "--testNamePattern", "--project", "--bail", "--environment", "--pool", "--mode", "--retry", "--testTimeout"], O),
      "--config": RP,
      "--dir": RP,
      ...all(["--outputFile", "--coverage.reportsDirectory"], OUTSIDE_WRITE),
      "--root": CHANGES_ROOT,
    },
    operands: O,
  },
  jest: {
    short: { ...each("iuo", F), ...each("tw", O), c: RP },
    long: {
      ...all(["--ci", "--runInBand", "--coverage", "--verbose", "--passWithNoTests", "--detectOpenHandles", "--forceExit", "--json", "--listTests", "--onlyChanged", "--updateSnapshot", "--silent", "--no-cache"], F),
      ...all(["--watchAll", "--bail"], OO),
      ...all(["--testNamePattern", "--testPathPattern", "--maxWorkers", "--selectProjects", "--shard", "--testTimeout"], O),
      "--config": RP,
      ...all(["--outputFile", "--coverageDirectory", "--cacheDirectory"], OUTSIDE_WRITE),
      "--rootDir": CHANGES_ROOT,
    },
    operands: O,
  },
  // File operands emit `.js` next to each file (possibly outside the root): not allowlisted (`max: 0`).
  tsc: {
    short: { ...each("bv", F), p: RP },
    long: {
      ...all(["--noEmit", "--build", "--listFiles", "--listEmittedFiles", "--incremental", "--skipLibCheck", "--strict", "--extendedDiagnostics", "--diagnostics", "--version", "--force", "--verbose", "--dry"], F),
      "--pretty": OO,
      ...all(["--target", "--module", "--lib", "--jsx", "--moduleResolution"], O),
      "--project": RP,
      ...all(["--outDir", "--outFile", "--declarationDir", "--tsBuildInfoFile", "--generateTrace", "--rootDir"], OUTSIDE_WRITE),
    },
    operands: O,
    max: 0,
  },
  // `--fix` rewrites the operands (reported as writes, R43 files only).
  eslint: {
    short: { f: O, c: RP },
    long: {
      ...all(["--fix", "--fix-dry-run", "--no-eslintrc", "--no-config-lookup", "--quiet", "--cache", "--no-cache", "--color", "--no-color", "--report-unused-disable-directives", "--no-warn-ignored", "--no-ignore", "--debug", "--no-error-on-unmatched-pattern", "--no-inline-config"], F),
      ...all(["--max-warnings", "--ext", "--format", "--ignore-pattern", "--env", "--global", "--parser", "--parser-options", "--rule", "--fix-type", "--cache-strategy"], O),
      ...all(["--config", "--ignore-path"], RP),
      ...all(["--output-file", "--cache-location"], OUTSIDE_WRITE),
      ...all(["--rulesdir", "--plugin", "--resolve-plugins-relative-to"], RUNS_CODE),
      o: OUTSIDE_WRITE,
    },
    operands: RP,
  },
  // Allowlisted only with --check/--write; `--write` rewrites the operands (reported as writes, R43 files only).
  prettier: {
    short: { ...each("cwlu", F) },
    long: {
      ...all(["--check", "--write", "--list-different", "--no-config", "--cache", "--ignore-unknown", "--no-error-on-unmatched-pattern", "--with-node-modules", "--use-tabs", "--no-semi", "--single-quote", "--no-editorconfig", "--no-color"], F),
      ...all(["--log-level", "--cache-strategy", "--end-of-line", "--print-width", "--tab-width", "--trailing-comma", "--prose-wrap", "--parser", "--config-precedence"], O),
      ...all(["--ignore-path", "--config"], RP),
      "--cache-location": OUTSIDE_WRITE,
      "--plugin": RUNS_CODE,
    },
    operands: RP,
  },
  pytest: {
    short: { ...each("xqvsl", F), ...each("kmrW", O), c: RP, p: RUNS_CODE, o: CHANGES_ROOT },
    long: {
      ...all(["--exitfirst", "--quiet", "--verbose", "--lf", "--last-failed", "--ff", "--failed-first", "--nf", "--new-first", "--sw", "--stepwise", "--co", "--collect-only", "--no-header", "--disable-warnings", "--strict-markers", "--showlocals", "--cache-clear"], F),
      ...all(["--maxfail", "--tb", "--durations", "--capture", "--import-mode"], O),
      "--config-file": RP,
      ...all(["--rootdir", "--confcutdir", "--override-ini"], CHANGES_ROOT),
      ...all(["--basetemp", "--junitxml", "--junit-xml", "--log-file", "--result-log"], OUTSIDE_WRITE),
    },
    operands: RP,
  },
};
/** prettier is allowlisted only with one of these options. */
export const PRETTIER_REQUIRED: readonly string[] = ["--check", "-c", "--write", "-w"];
/** `prettier --write` / `eslint --fix` rewrite their operands in place: they are reported as pathArgs. */
export const RUNNER_REWRITE: Readonly<Record<string, readonly string[]>> = { prettier: ["--write", "-w"], eslint: ["--fix"] };
export const UV_ALLOWLIST_PREFIX: readonly string[] = ["run", "pytest"];
export const UV_ALLOWLIST_EXACT: readonly (readonly string[])[] = [["sync", "--frozen"]];
export const GO_SUBCOMMANDS: ReadonlySet<string> = new Set(["test", "build", "vet"]);
/** go test/build/vet flags (go flag syntax). `-exec`, `-toolexec` and `-vettool` run another program. */
export const GO_GRAMMAR: Grammar = {
  long: {
    ...all(["-v", "-race", "-cover", "-short", "-benchmem", "-json", "-failfast", "-a", "-trimpath", "-x", "-n"], F),
    ...all(["-run", "-skip", "-count", "-timeout", "-tags", "-bench", "-benchtime", "-p", "-parallel", "-cpu", "-mod", "-covermode", "-coverpkg", "-buildvcs"], O),
    "-o": WP,
    ...all(["-exec", "-toolexec", "-vettool"], RUNS_CODE),
    // `-ldflags=-extld=<prog>` runs another linker; the compiler and assembler flags are refused alike.
    ...all(["-ldflags", "-gcflags", "-asmflags", "-extldflags"], reject("passes flags to the compiler or linker, which can run another program")),
    ...all(["-C", "-modfile", "-overlay"], CHANGES_ROOT),
  },
  operands: O,
  goFlags: true,
};
export const CARGO_SUBCOMMANDS: ReadonlySet<string> = new Set(["test", "build", "check", "clippy", "fmt"]);
/** cargo options; words after `--` (test binary, clippy or rustfmt arguments) are limited to harmless ones. */
export const CARGO_GRAMMAR: Grammar = {
  short: { ...each("qvr", F), ...each("pFj", O), Z: reject("enables unstable options") },
  long: {
    ...all(["--release", "--workspace", "--all", "--all-features", "--no-default-features", "--lib", "--bins", "--tests", "--benches", "--examples", "--all-targets", "--locked", "--frozen", "--offline", "--quiet", "--verbose", "--no-fail-fast", "--doc", "--check"], F),
    ...all(["--package", "--features", "--target", "--jobs", "--bin", "--test", "--example", "--bench", "--color", "--message-format", "--profile", "--exclude"], O),
    "--config": reject("injects configuration"),
    ...all(["--target-dir", "--manifest-path"], CHANGES_ROOT),
  },
  operands: O,
  afterDoubleDash: /^(?:--nocapture|--ignored|--include-ignored|--exact|--quiet|--show-output|--check|--test-threads=\d+|-[DWA]|-[DWA][A-Za-z0-9_:-]+|[A-Za-z0-9_:.-]+)$/,
};
export const MAKE_TARGETS: ReadonlySet<string> = new Set(["test", "build", "lint"]);

/** `gh api` GET options (remote-mutating forms are detected first). */
export const GH_API_GRAMMAR: Grammar = {
  short: { ...each("i", F), ...each("HqtXp", O) },
  long: { ...all(["--include", "--paginate", "--silent", "--verbose", "--slurp"], F), ...all(["--header", "--jq", "--template", "--hostname", "--method", "--preview"], O) },
  operands: O,
  max: 1,
};

// --- local writes with path arguments ---

// Write commands use `order: "strict"`: where options stop at the first operand (BSD, POSIXLY_CORRECT), a later
// option word is an operand, so `cp a b -f` would write a file named `-f` the facts never see.
export const MKDIR_GRAMMAR: Grammar = { short: { ...each("pv", F), m: O }, long: { ...all(["--parents", "--verbose"], F), "--mode": O }, operands: WP, order: "strict" };
/** `-r`/`--reference` read the reference file's times: a read fact. */
export const TOUCH_GRAMMAR: Grammar = {
  short: { ...each("acmh", F), ...each("dt", O), r: RP },
  long: { ...all(["--no-create", "--no-dereference"], F), "--date": O, "--time": O, "--reference": RP },
  operands: WP,
  order: "strict",
};
export const TEE_GRAMMAR: Grammar = { short: each("aip", F), long: all(["--append", "--ignore-interrupts"], F), operands: WP, order: "strict" };
/** R46: backups (`dest~`, `dest<SUFFIX>`, numbered) are written next to the destination without a fact. */
const BACKUP = reject("writes a backup file next to the destination, without a fact (R46)");
/** R43: `cp -t` copies into a directory (unknown); every operand must be a known non-directory at the gate. */
export const CP_GRAMMAR: Grammar = {
  short: { ...each("rRafinpvuLPTHxls", F), ...each("bS", BACKUP), t: reject("copies into a directory, writing children the gate has no facts for (R43)") },
  long: {
    ...all(
      [
        "--recursive", "--archive", "--force", "--interactive", "--no-clobber", "--verbose", "--update", "--parents",
        "--no-target-directory", "--dereference", "--no-dereference",
      ],
      F,
    ),
    // Non-link attributes only: `links`/`all` copy links as links (R28).
    "--preserve": {
      pattern: /^(?:mode|ownership|timestamps)(?:,(?:mode|ownership|timestamps))*$/,
      reason: "preserves attributes other than mode, ownership and timestamps (links keep symbolic links, R28)",
      optional: true,
    },
    ...all(["--backup", "--suffix"], BACKUP),
    "--target-directory": reject("copies into a directory, writing children the gate has no facts for (R43)"),
  },
  operands: WP,
  nonDirOperands: true,
  order: "strict",
};
export const MV_GRAMMAR: Grammar = {
  short: { ...each("finvuT", F), ...each("bS", BACKUP), t: WP },
  long: { ...all(["--force", "--interactive", "--no-clobber", "--verbose", "--update", "--no-target-directory"], F), ...all(["--backup", "--suffix"], BACKUP), "--target-directory": WP },
  operands: WP,
  order: "strict",
};
/**
 * R28: cp options that copy symbolic links as links (recursive copies keep nested links, `-P`/`-d`/
 * `--no-dereference` keep them, `-s` creates them) unless `-L`/`--dereference` follows every link.
 */
export const CP_LINK_PRESERVING_SHORT = "rRadPs";
export const CP_LINK_PRESERVING_LONG: readonly string[] = ["--recursive", "--archive", "--no-dereference", "--symbolic-link"];
/** R32: cp options that copy a directory tree (with -L/--dereference they copy every link's target too). */
export const CP_RECURSIVE_SHORT = "rRa";
export const CP_RECURSIVE_LONG: readonly string[] = ["--recursive", "--archive"];
export const CP_DEREFERENCE_SHORT = "L";
export const CP_DEREFERENCE_LONG: readonly string[] = ["--dereference"];
export const RM_GRAMMAR: Grammar = {
  short: each("rRfivd", F),
  long: all(["--recursive", "--force", "--verbose", "--dir", "--one-file-system", "--preserve-root", "--no-preserve-root"], F),
  operands: WP,
  order: "strict",
};
export const RMDIR_GRAMMAR: Grammar = { short: each("pv", F), long: all(["--parents", "--verbose", "--ignore-fail-on-non-empty"], F), operands: WP, order: "strict" };
/** sed is allowlisted only as `sed -i` with a single plain `s/re/repl/flags` script (no `e`, `w`, `r`). */
export const SED_GRAMMAR: Grammar = { short: { ...each("Er", F), e: O }, long: all(["--regexp-extended"], F), operands: WP, order: "strict" };
export const SED_SUBSTITUTION_FLAGS = /^[gIi0-9]*$/;

// --- destructive ---

export const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set(["dd", "shred", "chown", "truncate"]);
export const DESTRUCTIVE_PREFIXES: readonly string[] = ["mkfs"];

// --- remote-mutating ---

export const REMOTE_ALWAYS: ReadonlySet<string> = new Set(["ssh", "scp", "vercel"]);
/** Cloud CLIs: remote-mutating except their version probe. */
export const CLOUD_CLIS: ReadonlySet<string> = new Set(["aws", "gcloud", "az"]);
/** Any of these arguments makes the command remote-mutating; otherwise `unknown`. */
export const REMOTE_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  docker: ["push"],
  kubectl: [
    "apply", "delete", "create", "patch", "replace", "edit", "scale", "set", "label", "annotate", "expose", "run",
    "drain", "cordon", "uncordon", "taint", "autoscale", "rollout",
  ],
  terraform: ["apply", "destroy"],
  netlify: ["deploy"],
  fly: ["deploy"],
  flyctl: ["deploy"],
};
export const GH_REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set(["pr", "issue", "release", "repo"]);

/**
 * R42: the minimal GET-style grammar of curl/wget, with each option's effect. Unlisted options → `unknown` (config
 * files `-K`, `--netrc`, cookie jars, traces, ...). Any `@`-prefixed value of a `safe` option is `unknown` (curl reads
 * the named file: headers, write-out templates that can write files). Mutating options are remote-mutating; their
 * `@file`/`<file` references and uploaded files are reported as reads.
 */
export type NetEffect =
  | "safe"
  /** `-b`/`--cookie`: inline `name=value` data only; a file name is `unknown`. */
  | "cookie"
  /** Sends inline data (no file). */
  | "mutate"
  /** Sends data that may reference a file (`@file`, `name=@file`, `name=<file`). */
  | "mutate-data"
  /** Uploads the named file. */
  | "mutate-file"
  | "method"
  | "output"
  | "output-cwd"
  | "output-dir"
  | "write-file";
export interface NetSpec {
  short: Readonly<Record<string, { value: boolean; effect: NetEffect }>>;
  long: Readonly<Record<string, { value: boolean; effect: NetEffect }>>;
}

const b = (effect: NetEffect) => ({ value: false, effect });
const v = (effect: NetEffect) => ({ value: true, effect });

export const CURL_SPEC: NetSpec = {
  short: {
    s: b("safe"), S: b("safe"), L: b("safe"), f: b("safe"), i: b("safe"), I: b("safe"), v: b("safe"), k: b("safe"),
    G: b("safe"), N: b("safe"),
    H: v("safe"), A: v("safe"), e: v("safe"), m: v("safe"), w: v("safe"), u: v("safe"), x: v("safe"), r: v("safe"),
    b: v("cookie"),
    d: v("mutate-data"), F: v("mutate-data"), T: v("mutate-file"),
    X: v("method"),
    o: v("output"), O: b("output-cwd"), J: b("output-cwd"),
  },
  long: {
    "--silent": b("safe"), "--show-error": b("safe"), "--location": b("safe"), "--fail": b("safe"),
    "--fail-with-body": b("safe"), "--include": b("safe"), "--head": b("safe"), "--verbose": b("safe"),
    "--insecure": b("safe"), "--compressed": b("safe"), "--get": b("safe"), "--no-buffer": b("safe"), "--create-dirs": b("safe"),
    "--header": v("safe"), "--user-agent": v("safe"), "--referer": v("safe"), "--max-time": v("safe"),
    "--connect-timeout": v("safe"), "--retry": v("safe"), "--write-out": v("safe"), "--user": v("safe"),
    "--proxy": v("safe"), "--range": v("safe"), "--url": v("safe"),
    "--cookie": v("cookie"),
    "--data": v("mutate-data"), "--data-ascii": v("mutate-data"), "--data-binary": v("mutate-data"),
    "--data-urlencode": v("mutate-data"), "--json": v("mutate-data"), "--form": v("mutate-data"),
    "--data-raw": v("mutate"), "--form-string": v("mutate"),
    "--upload-file": v("mutate-file"), "--post301": b("mutate"), "--post302": b("mutate"), "--post303": b("mutate"),
    "--request": v("method"),
    "--output": v("output"), "--remote-name": b("output-cwd"), "--remote-name-all": b("output-cwd"),
    "--remote-header-name": b("output-cwd"), "--output-dir": v("output-dir"),
  },
};

export const WGET_SPEC: NetSpec = {
  short: {
    q: b("safe"), S: b("safe"), c: b("safe"), v: b("safe"),
    U: v("safe"), T: v("safe"), t: v("safe"),
    O: v("output"), P: v("output-dir"),
    o: v("write-file"), a: v("write-file"),
  },
  long: {
    "--quiet": b("safe"), "--no-verbose": b("safe"), "--server-response": b("safe"), "--continue": b("safe"),
    "--verbose": b("safe"), "--spider": b("safe"), "--no-check-certificate": b("safe"),
    "--header": v("safe"), "--user-agent": v("safe"), "--timeout": v("safe"), "--tries": v("safe"),
    "--referer": v("safe"), "--user": v("safe"),
    "--post-data": v("mutate"), "--body-data": v("mutate"), "--post-file": v("mutate-file"), "--body-file": v("mutate-file"),
    "--method": v("method"),
    "--output-document": v("output"), "--directory-prefix": v("output-dir"),
    "--output-file": v("write-file"), "--append-output": v("write-file"),
  },
};

/** HTTP methods for `-X`/`--request`/`--method`. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Allowed URL schemes for curl/wget positionals. */
export const NET_URL = /^https?:\/\//i;

/** Redirection targets that write nothing. */
export const NULL_TARGETS: ReadonlySet<string> = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
/** Redirection targets that bash turns into network sockets: remote-mutating. */
export const NETWORK_TARGET_PREFIXES: readonly string[] = ["/dev/tcp/", "/dev/udp/"];
