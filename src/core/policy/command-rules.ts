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

/** Simple read-only commands with the arguments that disqualify them. */
export interface ReadOnlyRule {
  /** Long options that disqualify, alone or as `--opt=value`. */
  denyLong?: readonly string[];
  /** Short option letters that disqualify anywhere in a `-abc` cluster. */
  denyShort?: string;
  /** Maximum number of non-option arguments (`uniq in out` writes `out`). */
  maxPositionals?: number;
}

export const READ_ONLY_COMMANDS: Readonly<Record<string, ReadOnlyRule>> = {
  ls: {},
  cat: {},
  head: {},
  tail: {},
  wc: {},
  sort: { denyShort: "o", denyLong: ["--output", "--compress-program"] },
  uniq: { maxPositionals: 1 },
  cut: {},
  tr: {},
  grep: {},
  rg: { denyLong: ["--pre", "--pre-glob"] },
  fd: { denyShort: "xX", denyLong: ["--exec", "--exec-batch"] },
  tree: { denyShort: "oR" },
  pwd: {},
  which: {},
  whereis: {},
  type: {},
  file: { denyShort: "C", denyLong: ["--compile"] },
  stat: {},
  du: {},
  df: {},
  echo: {},
  printf: { denyShort: "v" },
  true: {},
  false: {},
  test: {},
  basename: {},
  dirname: {},
  realpath: {},
  readlink: {},
  date: { denyShort: "s", denyLong: ["--set"] },
  sleep: {},
  diff: {},
  cmp: {},
  jq: { denyShort: "i", denyLong: ["--in-place"] },
};

/** `find` predicates that execute or write (`unknown`) or delete (`destructive`). */
export const FIND_UNKNOWN_PREDICATES: ReadonlySet<string> = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
]);
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

/** Global options accepted before the subcommand. */
export const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks"]);
/** Options that inject configuration or redirect the repository: always `unknown`. */
export const GIT_INJECTION_LONG: readonly string[] = ["--config-env", "--exec-path", "--git-dir", "--work-tree"];
/** Read-only subcommands that accept any argument except the listed long options. */
export const GIT_READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  status: [],
  log: ["--output", "--ext-diff"],
  diff: ["--output", "--ext-diff"],
  show: ["--output", "--ext-diff"],
  "rev-parse": [],
  "ls-files": [],
  blame: [],
  describe: [],
  fetch: ["--upload-pack"],
};
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

// --- package managers and runners (ruling 18) ---

export const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Exact argument vectors after the package manager that are allowlisted. */
export const PACKAGE_MANAGER_ALLOWLIST: readonly (readonly string[])[] = [
  ["test"],
  ["run", "test"],
  ["run", "build"],
  ["run", "lint"],
  ["run", "typecheck"],
  ["ci"],
  ["install", "--frozen-lockfile"],
  ["install", "--immutable"],
];
/** Any of these arguments makes a package-manager invocation remote-mutating. */
export const PACKAGE_MANAGER_REMOTE: Readonly<Record<string, readonly string[]>> = {
  npm: ["publish", "unpublish", "deprecate", "dist-tag"],
  pnpm: ["publish"],
  yarn: ["publish"],
  bun: ["publish"],
};
/** Binaries reachable through `npx --no-install <bin>` / `npm exec --no -- <bin>`. */
export const NPX_BINS: ReadonlySet<string> = new Set(["vitest", "jest", "tsc", "eslint", "prettier"]);
/** Runners allowlisted with any arguments. */
export const ANY_ARGS_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "tsc", "eslint", "pytest"]);
/** prettier is allowlisted only with one of these options. */
export const PRETTIER_REQUIRED: readonly string[] = ["--check", "-c", "--write", "-w"];
export const UV_ALLOWLIST_PREFIX: readonly string[] = ["run", "pytest"];
export const UV_ALLOWLIST_EXACT: readonly (readonly string[])[] = [["sync", "--frozen"]];
export const GO_SUBCOMMANDS: ReadonlySet<string> = new Set(["test", "build", "vet"]);
/** go options that run another program: `unknown`. */
export const GO_DENY: readonly string[] = ["-exec", "-toolexec", "-vettool"];
export const CARGO_SUBCOMMANDS: ReadonlySet<string> = new Set(["test", "build", "check", "clippy", "fmt"]);
/** cargo options that inject configuration: `unknown`. */
export const CARGO_DENY: readonly string[] = ["--config", "-Z"];
export const MAKE_TARGETS: ReadonlySet<string> = new Set(["test", "build", "lint"]);

// --- local writes with path arguments ---

/** Option grammar for commands whose path arguments are reported (ruling 2). Unlisted options → `unknown`. */
export interface OptionSpec {
  shortBool: string;
  shortValue: string;
  longBool: readonly string[];
  longValue: readonly string[];
}

export const MKDIR_SPEC: OptionSpec = { shortBool: "pv", shortValue: "m", longBool: ["--parents", "--verbose"], longValue: ["--mode"] };
export const TOUCH_SPEC: OptionSpec = { shortBool: "acm", shortValue: "", longBool: ["--no-create"], longValue: [] };
export const TEE_SPEC: OptionSpec = { shortBool: "aip", shortValue: "", longBool: ["--append", "--ignore-interrupts"], longValue: [] };
export const CP_SPEC: OptionSpec = {
  shortBool: "rRafinpvuLPTHxls",
  shortValue: "tS",
  longBool: [
    "--recursive", "--archive", "--force", "--interactive", "--no-clobber", "--preserve", "--verbose", "--update",
    "--parents", "--no-target-directory", "--dereference", "--no-dereference",
  ],
  longValue: ["--target-directory", "--suffix"],
};
export const MV_SPEC: OptionSpec = {
  shortBool: "finvuT",
  shortValue: "tS",
  longBool: ["--force", "--interactive", "--no-clobber", "--verbose", "--update", "--no-target-directory"],
  longValue: ["--target-directory", "--suffix"],
};
/** Options of cp/mv whose value is a path. */
export const TARGET_DIRECTORY_OPTIONS: ReadonlySet<string> = new Set(["-t", "--target-directory"]);
export const RM_SPEC: OptionSpec = {
  shortBool: "rRfivd",
  shortValue: "",
  longBool: ["--recursive", "--force", "--verbose", "--dir", "--one-file-system", "--preserve-root", "--no-preserve-root"],
  longValue: [],
};
export const RMDIR_SPEC: OptionSpec = {
  shortBool: "pv",
  shortValue: "",
  longBool: ["--parents", "--verbose", "--ignore-fail-on-non-empty"],
  longValue: [],
};
/** sed is allowlisted only as `sed -i` with a single plain `s/re/repl/flags` script (no `e`, `w`, `r`). */
export const SED_SPEC: OptionSpec = { shortBool: "Er", shortValue: "e", longBool: ["--regexp-extended"], longValue: [] };
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

/** Option grammar of curl/wget with each option's effect. Unlisted options → `unknown`. */
export type NetEffect = "safe" | "mutate" | "config" | "method" | "output" | "output-cwd" | "output-dir" | "write-file";
export interface NetSpec {
  short: Readonly<Record<string, { value: boolean; effect: NetEffect }>>;
  long: Readonly<Record<string, { value: boolean; effect: NetEffect }>>;
}

const b = (effect: NetEffect) => ({ value: false, effect });
const v = (effect: NetEffect) => ({ value: true, effect });

export const CURL_SPEC: NetSpec = {
  short: {
    s: b("safe"), S: b("safe"), L: b("safe"), f: b("safe"), i: b("safe"), I: b("safe"), v: b("safe"), k: b("safe"),
    G: b("safe"), N: b("safe"), q: b("safe"),
    H: v("safe"), A: v("safe"), e: v("safe"), m: v("safe"), w: v("safe"), u: v("safe"), x: v("safe"), b: v("safe"),
    r: v("safe"),
    d: v("mutate"), F: v("mutate"), T: v("mutate"),
    K: v("config"),
    X: v("method"),
    o: v("output"), O: b("output-cwd"), J: b("output-cwd"),
    D: v("write-file"), c: v("write-file"),
  },
  long: {
    "--silent": b("safe"), "--show-error": b("safe"), "--location": b("safe"), "--fail": b("safe"),
    "--fail-with-body": b("safe"), "--include": b("safe"), "--head": b("safe"), "--verbose": b("safe"),
    "--insecure": b("safe"), "--compressed": b("safe"), "--get": b("safe"), "--no-buffer": b("safe"),
    "--header": v("safe"), "--user-agent": v("safe"), "--referer": v("safe"), "--max-time": v("safe"),
    "--connect-timeout": v("safe"), "--retry": v("safe"), "--write-out": v("safe"), "--user": v("safe"),
    "--proxy": v("safe"), "--cookie": v("safe"), "--range": v("safe"), "--url": v("safe"),
    "--data": v("mutate"), "--data-ascii": v("mutate"), "--data-binary": v("mutate"), "--data-raw": v("mutate"),
    "--data-urlencode": v("mutate"), "--json": v("mutate"), "--form": v("mutate"), "--form-string": v("mutate"),
    "--upload-file": v("mutate"), "--post301": b("mutate"), "--post302": b("mutate"), "--post303": b("mutate"),
    "--config": v("config"),
    "--request": v("method"),
    "--output": v("output"), "--remote-name": b("output-cwd"), "--remote-name-all": b("output-cwd"),
    "--remote-header-name": b("output-cwd"), "--output-dir": v("output-dir"), "--create-dirs": b("safe"),
    "--dump-header": v("write-file"), "--cookie-jar": v("write-file"), "--trace": v("write-file"),
    "--trace-ascii": v("write-file"), "--stderr": v("write-file"),
  },
};

export const WGET_SPEC: NetSpec = {
  short: {
    q: b("safe"), S: b("safe"), c: b("safe"), v: b("safe"),
    U: v("safe"), T: v("safe"), t: v("safe"),
    e: v("config"),
    O: v("output"), P: v("output-dir"),
    o: v("write-file"), a: v("write-file"),
  },
  long: {
    "--quiet": b("safe"), "--no-verbose": b("safe"), "--server-response": b("safe"), "--continue": b("safe"),
    "--verbose": b("safe"), "--spider": b("safe"), "--no-check-certificate": b("safe"),
    "--header": v("safe"), "--user-agent": v("safe"), "--timeout": v("safe"), "--tries": v("safe"),
    "--referer": v("safe"), "--user": v("safe"),
    "--post-data": v("mutate"), "--post-file": v("mutate"), "--body-data": v("mutate"), "--body-file": v("mutate"),
    "--execute": v("config"), "--config": v("config"),
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
