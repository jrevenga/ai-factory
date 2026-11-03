// Facts the extension gathers for core (Phase 2 Task 6): resolved paths, repository root, git dirs and
// worktree state. Core decides; this module only observes the filesystem and git (node builtins only).
//
// Two path semantics are reproduced:
// - tool paths (`read`, `write`, `edit`, `grep`, `find`, `ls`) follow Pi 1.4.0's `resolveToCwd`
//   (dist/core/tools/path-utils.js + dist/utils/paths.js): unicode spaces become spaces, a leading `@` is
//   stripped, Git Bash drive paths are converted on win32, `~` / `~/` (and `~\` on win32) expand, `file://`
//   URLs convert, then the path is resolved lexically (`..` collapses before the filesystem is consulted);
// - command arguments (bash) follow the OS: only a leading `~/` expands (the lexer admits no other `~`) and
//   `..` is resolved physically, after the symlinks before it.
// Either way the result is the realpath of the nearest existing ancestor plus the missing tail, following
// dangling symlinks to their target (a write through one creates the target).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PathFacts, PathPlatform } from "../../../core/policy/paths.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
const MAX_SYMLINK_HOPS = 40;
const GIT_TIMEOUT_MS = 10_000;
/** Inherited location variables would point git at another repository than the cwd's. */
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"];

export function hostPlatform(): PathPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

function api(platform: PathPlatform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Pi's `normalizeWindowsShellPath` (dist/utils/paths.js), verbatim. */
function normalizeWindowsShellPath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const match = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return p;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Pi's `normalizePath` for the given platform; `tool` adds the `resolveToCwd` options. Throws on a bad file URL. */
function piNormalize(input: string, home: string, platform: PathPlatform, tool: boolean): string {
  let p = input;
  if (tool) {
    p = p.replace(UNICODE_SPACES, " ");
    if (p.startsWith("@")) p = p.slice(1);
  }
  if (platform === "win32") p = normalizeWindowsShellPath(p);
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return api(platform).join(home, p.slice(2));
  if (/^file:\/\//.test(p)) return fileURLToPath(p, { windows: platform === "win32" });
  return p;
}

/**
 * Pi's `resolveToCwd(input, cwd)`. On the host platform it is Pi's code path exactly (`isAbsolute ? resolve(n) :
 * resolve(base, n)`, so a drive-less rooted win32 path takes `process.cwd()`'s drive as in Pi). For the other
 * platform (cross-platform tests) a rooted path takes `cwd`'s drive. `home` must be the value Pi expands `~`
 * with (`os.homedir()`), unmodified: `~/..` is collapsed lexically against it before any symlink is followed.
 * Throws on an invalid `file://` URL, as Pi does.
 */
export function resolveToolPath(input: string, cwd: string, home: string, platform: PathPlatform = hostPlatform()): string {
  const base = piNormalize(cwd, home, platform, false);
  const n = piNormalize(input, home, platform, true);
  if (platform === hostPlatform()) return path.isAbsolute(n) ? path.resolve(n) : path.resolve(base, n);
  return api(platform).resolve(base, n);
}

/**
 * win32 and darwin: the native realpath returns the on-disk spelling (8.3 names, junctions, case on
 * case-insensitive volumes); JS `realpathSync` keeps the input's case there.
 */
function realpathNative(p: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? realpathSync.native(p) : realpathSync(p);
}

function exists(p: string): boolean {
  try {
    accessSync(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Realpath of `abs` with physical `..`: walks the segments, realpathing each existing prefix (so a `..` after
 * a symlink goes to the target's parent), following dangling symlinks, and keeping the missing tail as
 * spelled. Throws on a symlink loop. `abs` must be absolute for the host.
 */
function realTarget(abs: string): string {
  const a = path;
  const split = (p: string) => p.split(process.platform === "win32" ? /[\\/]+/ : /\/+/).filter((x) => x !== "");
  const root = a.parse(abs).root;
  const queue = split(abs.slice(root.length));
  let cur = safeRealpath(root) ?? root;
  let present = true;
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift()!;
    if (seg === ".") continue;
    if (seg === "..") {
      cur = a.dirname(cur);
      // `mkdir -p missing/../link/x` creates `missing` and then follows `link`: back on existing ground, resolve again.
      if (!present) {
        const real = safeRealpath(cur);
        if (real !== undefined) {
          cur = real;
          present = true;
        }
      }
      continue;
    }
    const next = a.join(cur, seg);
    if (!present) {
      cur = next;
      continue;
    }
    const real = safeRealpath(next);
    if (real !== undefined) {
      cur = real;
      continue;
    }
    let link: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {
      // Missing (or unreadable): the rest is a tail as spelled.
    }
    if (link === undefined) {
      present = false;
      cur = next;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) throw new Error(`too many symbolic links resolving ${abs}`);
    const linkRoot = a.parse(link).root;
    if (linkRoot !== "") cur = safeRealpath(linkRoot) ?? linkRoot;
    queue.unshift(...split(link.slice(linkRoot.length)));
  }
  return cur;
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathNative(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw e;
    return undefined;
  }
}

/** A fact core treats as secret and outside every root (empty `resolved` is not an absolute path). */
function unresolvable(input: string, platform: PathPlatform): PathFacts {
  return { input, resolved: "", platform };
}

/** Pi's `resolveReadPath` fallbacks for a missing path (macOS screenshot names, NFD, curly quotes). */
function readVariant(resolved: string): string {
  if (exists(resolved)) return resolved;
  const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
  const nfd = resolved.normalize("NFD");
  const curly = resolved.replace(/'/g, "\u2019");
  const nfdCurly = nfd.replace(/'/g, "\u2019");
  for (const v of [amPm, nfd, curly, nfdCurly]) if (v !== resolved && exists(v)) return v;
  return resolved;
}

export interface PathFactsOptions {
  /** The `read` tool: apply Pi's `resolveReadPath` variants when the path does not exist. */
  read?: boolean;
}

/**
 * Facts for a tool path argument. `home` must be exactly the value Pi expands `~` with (`os.homedir()`), NOT
 * realpathed: Pi collapses `~/..` lexically against it, and only then does the filesystem follow symlinks.
 * An unresolvable path (invalid file URL, symlink loop, non-absolute home) yields `resolved: ""`, which core
 * treats as secret and outside (fail closed).
 */
export function pathFacts(p: string, cwd: string, home: string, opts: PathFactsOptions = {}): PathFacts {
  const platform = hostPlatform();
  if (!path.isAbsolute(home)) return unresolvable(p, platform);
  try {
    let lexical = resolveToolPath(p, cwd, home, platform);
    if (opts.read) lexical = readVariant(lexical);
    return { input: p, resolved: realTarget(lexical), platform };
  } catch {
    return unresolvable(p, platform);
  }
}

/**
 * Absolute spellings (`.`/`..` kept, for physical resolution) of a bash path argument. On win32 a leading
 * `/` has two readings: Git Bash's (a `/c/...` drive path; any other POSIX absolute path is an MSYS mount
 * whose Windows location is unknown, given as `""`) and a native Windows program's (rooted on cwd's drive).
 */
export function commandCandidates(arg: string, cwd: string, home: string, platform: PathPlatform = hostPlatform()): string[] {
  const sep = platform === "win32" ? "\\" : "/";
  let p = arg;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = `${home.replace(/[\\/]+$/, "")}${sep}${p.slice(2)}`;
  if (platform === "posix") return [p.startsWith("/") ? p : `${cwd.replace(/\/+$/, "")}/${p}`];
  if (/^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)) return [p];
  if (p.startsWith("/") || p.startsWith("\\")) {
    const drive = path.win32.parse(cwd).root.replace(/[\\/]+$/, "");
    const gitBash = normalizeWindowsShellPath(p);
    return [gitBash !== p ? gitBash : "", `${drive}${p}`];
  }
  // Drive-relative (`D:x`): resolvable only on cwd's own drive.
  if (/^[A-Za-z]:/.test(p)) {
    return [p.slice(0, 2).toLowerCase() === cwd.slice(0, 2).toLowerCase() ? `${cwd.replace(/[\\/]+$/, "")}\\${p.slice(2)}` : ""];
  }
  return [`${cwd.replace(/[\\/]+$/, "")}\\${p}`];
}

/**
 * Facts for a bash path argument (a pathArg, inputPath or readArg of `classifyCommandLine`). On win32 one fact
 * per reading, all with the same `input`: the gate then treats the argument as secret if any reading is
 * secret and as inside a root only if every reading is.
 */
export function commandPathFacts(arg: string, cwd: string, home: string): PathFacts[] {
  const platform = hostPlatform();
  let realHome: string;
  try {
    realHome = canonicalDir(home);
  } catch {
    return [unresolvable(arg, platform)];
  }
  return commandCandidates(arg, cwd, realHome, platform).map((abs) => {
    if (abs === "") return unresolvable(arg, platform);
    try {
      return { input: arg, resolved: realTarget(abs), platform };
    } catch {
      return unresolvable(arg, platform);
    }
  });
}

/**
 * Realpath of an absolute directory (home, Pi agent dir, project root, worktree, tmp root) or of its nearest
 * existing ancestor plus the missing tail; core compares realpathed paths only. Throws on empty or relative input.
 */
export function canonicalDir(p: string): string {
  if (p === "" || !path.isAbsolute(p)) throw new Error(`expected an absolute path, got ${JSON.stringify(p)}`);
  return realTarget(path.resolve(p));
}

/** Non-interactive git: no shell, no prompts, bounded. Undefined on any failure (not a repo, git missing, timeout). */
function gitOut(cwd: string, args: string[]): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  for (const k of Object.keys(env)) if (GIT_LOCATION_VARS.includes(k.toUpperCase())) delete env[k];
  try {
    return execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }).replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Realpath, or undefined on any error (including a symlink loop). */
function realOrUndefined(p: string): string | undefined {
  try {
    return realpathNative(p);
  } catch {
    return undefined;
  }
}

/**
 * `git rev-parse --path-format=absolute <flag>` (git >= 2.31), else the plain form resolved against `cwd`. An
 * older git echoes the unknown option as an extra line instead of failing, hence the single-line check.
 */
function gitPath(cwd: string, flag: "--show-toplevel" | "--git-dir" | "--git-common-dir"): string | undefined {
  let out = gitOut(cwd, ["rev-parse", "--path-format=absolute", flag]);
  if (out === undefined || out.includes("\n") || out.startsWith("-")) out = gitOut(cwd, ["rev-parse", flag]);
  if (out === undefined || out === "") return undefined;
  return realOrUndefined(path.resolve(cwd, out));
}

/** Realpathed `git rev-parse --show-toplevel` of `cwd`, or undefined outside a work tree. Never throws. */
export function repoRoot(cwd: string): string | undefined {
  if (!isDir(cwd)) return undefined;
  return gitPath(cwd, "--show-toplevel");
}

/**
 * Ruling R21: the git dir and the common dir of the repository at `cwd` (`git rev-parse --git-dir` /
 * `--git-common-dir`), absolute, realpathed and deduplicated; empty outside a repository.
 */
export function gitDirs(cwd: string): string[] {
  if (!isDir(cwd)) return [];
  const dirs: string[] = [];
  for (const d of [gitPath(cwd, "--git-dir"), gitPath(cwd, "--git-common-dir")]) {
    if (d !== undefined && !dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

export interface WorktreeFacts {
  exists: boolean;
  /** `p` is the toplevel of a work tree whose common git dir is the project's. A subdirectory is not. */
  sameRepo: boolean;
  /** `git branch --show-current`; absent when detached. */
  branch?: string;
}

/** Facts `validateSetRoute` needs for a feature/project worktree (ruling 6). */
export function worktreeFacts(p: string, projectRoot: string): WorktreeFacts {
  if (!path.isAbsolute(p) || !isDir(p)) return { exists: false, sameRepo: false };
  const real = realOrUndefined(p);
  const top = repoRoot(p);
  const common = gitPath(p, "--git-common-dir");
  const projectCommon = isDir(projectRoot) ? gitPath(projectRoot, "--git-common-dir") : undefined;
  const sameRepo = real !== undefined && top === real && common !== undefined && common === projectCommon;
  const branch = top === undefined ? undefined : gitOut(p, ["branch", "--show-current"]);
  return { exists: true, sameRepo, ...(branch ? { branch } : {}) };
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
