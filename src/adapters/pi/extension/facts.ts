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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSecretPath, type PathFacts, type PathPlatform } from "../../../core/policy/paths.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
const MAX_SYMLINK_HOPS = 40;
const GIT_TIMEOUT_MS = 10_000;
/** Inherited location variables would point git at another repository than the cwd's. */
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"];
/** Inherited pathspec modes would change how factory pathspecs (`:(literal)…`, `:(exclude,literal)…`) are read. */
const GIT_PATHSPEC_VARS = ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"];

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
  return { input, resolved: "", platform, exists: false };
}

/** R28: whether the resolved target exists now (a dangling symlink counts as existing: lstat). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** R37: a directory at hook time, following links (a missing or unreadable target is not one). */
function isDirectoryNow(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolvedFact(input: string, resolved: string, platform: PathPlatform, lexical?: string): PathFacts {
  return { input, resolved, platform, exists: lexists(resolved), directory: isDirectoryNow(resolved), ...(lexical !== undefined ? { lexical } : {}) };
}

/**
 * R57: the normalised absolute spelling of `abs` with symbolic links kept as they are. A part that is `cwd`
 * itself is anchored on cwd's real path, so it compares with the (realpathed) roots.
 */
function lexicalPath(abs: string, cwd: string, platform: PathPlatform): string | undefined {
  try {
    const a = platform === "win32" ? path.win32 : path.posix;
    const norm = a.normalize(abs);
    if (!a.isAbsolute(norm)) return undefined;
    const fold = (x: string) => (platform === "win32" ? x.toLowerCase() : x);
    const rel = a.relative(fold(cwd), fold(norm));
    if (rel === "" || (!rel.startsWith("..") && !a.isAbsolute(rel))) {
      return a.join(realTarget(a.normalize(cwd)), norm.slice(norm.length - rel.length));
    }
    return norm;
  } catch {
    return undefined;
  }
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
    return resolvedFact(p, realTarget(lexical), platform, lexicalPath(lexical, cwd, platform));
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
      return resolvedFact(arg, realTarget(abs), platform, lexicalPath(abs, cwd, platform));
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

// --- Programs on PATH (decision 4, M2) --------------------------------------------------------------------------

export interface ProgramSearch {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** POSIX: an executable regular file; Windows: a regular file. */
  isFile(p: string): boolean;
  /** Directories whose programs are never picked up through PATH (the project, the write root). */
  excludeRoots: readonly string[];
  /** Realpath for the containment check (default: the native realpath, undefined when missing). */
  real?: (p: string) => string | undefined;
}

const envValue = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];

function insideAny(p: string, roots: readonly string[], platform: NodeJS.Platform): boolean {
  const a = platform === "win32" ? path.win32 : path.posix;
  const fold = (x: string) => (platform === "win32" ? x.toLowerCase() : x);
  return roots.some((r) => {
    const rel = a.relative(fold(r), fold(p));
    return rel === "" || (!rel.startsWith("..") && !a.isAbsolute(rel));
  });
}

/**
 * M2: the PATH entries a factory spawn may search: absolute, non-empty and outside every `excludeRoots` entry (also
 * after following links), so neither a relative entry (`node_modules/.bin`, `.`, an empty one) nor a directory in the
 * project can supply the program.
 */
export function safePathEntries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  excludeRoots: readonly string[],
  real: (p: string) => string | undefined = realOrUndefined,
): string[] {
  const a = platform === "win32" ? path.win32 : path.posix;
  const roots = excludeRoots.flatMap((r) => [r, real(r) ?? r]);
  return (envValue(env, "PATH") ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((d) => (platform === "win32" ? d.trim().replace(/^"(.*)"$/, "$1") : d))
    .filter((d) => d !== "" && a.isAbsolute(d) && !insideAny(d, roots, platform) && !insideAny(real(d) ?? d, roots, platform));
}

/** The env with PATH reduced to `safePathEntries`, under its original variable name. */
export function withSafePath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, excludeRoots: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const key = Object.keys(out).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  for (const k of Object.keys(out)) if (k.toUpperCase() === "PATH") delete out[k];
  out[key] = safePathEntries(env, platform, excludeRoots).join(platform === "win32" ? ";" : ":");
  return out;
}

function executableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The host's program search, excluding `excludeRoots`. */
export function hostProgramSearch(excludeRoots: readonly string[], env: NodeJS.ProcessEnv = process.env): ProgramSearch {
  return { platform: process.platform, env, isFile: executableFile, excludeRoots };
}

/**
 * The absolute file a factory spawn starts for `argv0` (always `shell: false`), searched in `safePathEntries` only,
 * never the current directory. A path-qualified `argv0` (only a declared command reaches here with one) is taken as
 * named, relative to `cwd`. Windows: PATHEXT applies; a `.cmd`/`.bat` is refused, because Node refuses to spawn one
 * without a shell (EINVAL since the fix for CVE-2024-27980) and Phase 2 adds no shell; only `.exe`/`.com` run.
 */
export function resolveProgram(argv0: string, cwd: string, deps: ProgramSearch): { ok: true; file: string } | { ok: false; error: string } {
  const win = deps.platform === "win32";
  const a = win ? path.win32 : path.posix;
  const withDir = win ? /[\\/]/.test(argv0) || /^[A-Za-z]:/.test(argv0) : argv0.includes("/");
  const ignored = "relative, empty and in-project PATH entries are ignored";
  if (!win) {
    if (withDir) return { ok: true, file: a.resolve(cwd, argv0) };
    for (const d of safePathEntries(deps.env, deps.platform, deps.excludeRoots, deps.real ?? realOrUndefined)) {
      const candidate = a.join(d, argv0);
      if (deps.isFile(candidate)) return { ok: true, file: candidate };
    }
    return { ok: false, error: `${argv0} was not found on PATH (${ignored})` };
  }
  const dirs = withDir ? [cwd] : safePathEntries(deps.env, deps.platform, deps.excludeRoots, deps.real ?? realOrUndefined);
  const exts = (envValue(deps.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.startsWith("."));
  const names = a.extname(argv0) !== "" ? [argv0, ...exts.map((e) => `${argv0}${e}`)] : exts.map((e) => `${argv0}${e}`);
  for (const d of dirs) {
    for (const n of names) {
      const candidate = a.resolve(d, n);
      if (!deps.isFile(candidate)) continue;
      const ext = a.extname(candidate).toLowerCase();
      if (ext === ".cmd" || ext === ".bat") {
        return {
          ok: false,
          error: `${argv0} resolves to the batch file ${candidate}; run_check starts programs without a shell and Node refuses .cmd/.bat files without one (Phase 2 adds no shell). Run the program it wraps instead (for example node with the script path) and declare that command in .factory/config.json`,
        };
      }
      if (ext !== ".exe" && ext !== ".com") return { ok: false, error: `${argv0} resolves to ${candidate}, which run_check cannot start without a shell (only .exe and .com)` };
      return { ok: true, file: candidate };
    }
  }
  return { ok: false, error: `${argv0} was not found on PATH (PATHEXT ${exts.join(";")}; ${ignored})` };
}

// --- Factory git ------------------------------------------------------------------------------------------------

const GIT_NOT_FOUND =
  "git was not found on PATH outside the project (relative, empty and in-project PATH entries are ignored); factory git commands cannot run";

/**
 * The repository roots around `cwd`, found without running git: the nearest ancestor holding `.git`, and for a linked
 * worktree (`.git` is a file naming `<main>/.git/worktrees/<name>`) the main work tree too.
 */
function repoRootsAround(cwd: string): string[] {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let isFile: boolean | undefined;
    try {
      isFile = lstatSync(dotGit).isFile();
    } catch {
      isFile = undefined;
    }
    if (isFile !== undefined) {
      const roots = [dir];
      if (isFile) {
        try {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
          const gitdir = m ? path.resolve(dir, m[1]!) : undefined;
          const idx = gitdir === undefined ? -1 : gitdir.replaceAll("\\", "/").lastIndexOf("/.git/worktrees/");
          if (gitdir !== undefined && idx > 0) roots.push(gitdir.slice(0, idx));
        } catch {
          // Unreadable: the worktree itself stays excluded.
        }
      }
      return roots;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

const gitCache = new Map<string, string | undefined>();

/**
 * M2: the absolute git every factory git spawn uses, resolved once per PATH and repository (cached). It is searched
 * only in `safePathEntries`: never the cwd (Windows libuv would look there first for a bare `git`), never a PATH entry
 * inside the cwd or the repository around it. Undefined when none is found (callers fail closed).
 */
export function gitExecutable(cwd: string): string | undefined {
  const roots = [path.resolve(cwd), ...repoRootsAround(cwd)];
  const key = [process.platform, envValue(process.env, "PATH") ?? "", envValue(process.env, "PATHEXT") ?? "", ...roots].join("\0");
  if (gitCache.has(key)) return gitCache.get(key);
  const r = resolveProgram("git", cwd, hostProgramSearch(roots));
  const file = r.ok ? r.file : undefined;
  gitCache.set(key, file);
  return file;
}

/**
 * The process env for git: no prompts, and no inherited location variables. `extra` is applied after the stripping
 * (e.g. a factory-owned `GIT_INDEX_FILE` for the fingerprint's temporary index).
 */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    if (GIT_LOCATION_VARS.includes(u) || GIT_PATHSPEC_VARS.includes(u)) delete env[k];
  }
  return { ...env, ...extra };
}

/**
 * M8: one formatter for a failed factory git command: what failed, the exit status (or that git could not run or
 * timed out), and the last lines of its stderr (at most 500 characters).
 */
export function gitFailureText(what: string, r: { status: number | null; stderr: string }): string {
  const detail = r.stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 500);
  return `${what} failed${r.status === null ? " (git could not run or timed out)" : ` (exit ${r.status})`}${detail !== "" ? `: ${detail}` : ""}`;
}

export interface GitRun {
  /** Exit status; null when git could not be started or was killed (timeout). */
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Non-interactive git with its output and status (factory tools that change git state): no shell, bounded. `input`
 * is written to git's stdin (e.g. `--pathspec-from-file=-`); without it stdin is closed. `env` adds variables after
 * the inherited git location and pathspec variables are stripped.
 */
export function gitRun(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS, input?: string, env?: Record<string, string>): GitRun {
  const git = gitExecutable(cwd);
  if (git === undefined) return { status: null, stdout: "", stderr: GIT_NOT_FOUND };
  const r = spawnSync(git, args, {
    cwd,
    env: gitEnv(env),
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stderr = r.error !== undefined ? `${r.stderr ?? ""}${r.error.message}` : (r.stderr ?? "");
  return { status: r.error !== undefined ? null : r.status, stdout: r.stdout ?? "", stderr };
}

export interface GitRunBytes {
  /** Exit status; null when git could not be started, was killed (timeout) or its output exceeded `maxBuffer`. */
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * `gitRun` with stdout as raw bytes and a caller-chosen output bound (Task 11: blob contents, which may be binary, and
 * NUL-separated listings of large repositories). Same resolution, environment and stdin rules as `gitRun`.
 */
export function gitRunBytes(cwd: string, args: string[], timeoutMs: number, maxBuffer: number, env?: Record<string, string>, input?: string): GitRunBytes {
  const git = gitExecutable(cwd);
  if (git === undefined) return { status: null, stdout: Buffer.alloc(0), stderr: GIT_NOT_FOUND };
  const r = spawnSync(git, args, {
    cwd,
    env: gitEnv(env),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  });
  const errText = r.stderr === null || r.stderr === undefined ? "" : r.stderr.toString("utf8");
  const stderr = r.error !== undefined ? `${errText}${r.error.message}` : errText;
  return { status: r.error !== undefined ? null : r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr };
}

/** Non-interactive git: no shell, no prompts, bounded. Undefined on any failure (not a repo, git missing, timeout). */
function gitOut(cwd: string, args: string[]): string | undefined {
  const env = gitEnv();
  const git = gitExecutable(cwd);
  if (git === undefined) return undefined;
  try {
    return execFileSync(git, args, {
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

/** `git rev-parse --verify HEAD` of the work tree at `dir` (ruling 10 `base`); undefined outside a repo or before the first commit. */
export function headCommit(dir: string): string | undefined {
  if (!isDir(dir)) return undefined;
  const out = gitOut(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return out !== undefined && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(out) ? out : undefined;
}

const FALSE_OR_TRUE = /^(?:true|false|yes|no|on|off|[-+]?\d*)$/i;

/**
 * R58: configured programs that a read-only git command run in `cwd` could execute: `diff.external`,
 * `diff.<driver>.textconv|command` and `GIT_EXTERNAL_DIFF` (diff), and a non-boolean `core.fsmonitor`. Filter
 * drivers (`filter.*`) are a documented residual. Fails closed: when the config query fails, everything counts as
 * configured.
 */
export function gitHelpersFact(cwd: string, env: NodeJS.ProcessEnv = process.env): { diff: boolean; fsmonitor: boolean } {
  const envDiff = (env.GIT_EXTERNAL_DIFF ?? "") !== "";
  const r = gitRunBytes(cwd, ["config", "--get-regexp", "^(diff\\.external|diff\\..*\\.(textconv|command)|core\\.fsmonitor)$"], GIT_TIMEOUT_MS, 1024 * 1024);
  if (r.status === 1 && r.stdout.length === 0) return { diff: envDiff, fsmonitor: false };
  if (r.status !== 0) return { diff: true, fsmonitor: true };
  let diff = envDiff;
  let fsmonitor = false;
  for (const line of r.stdout.toString("utf8").split("\n")) {
    if (line === "") continue;
    const space = line.search(/\s/);
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const value = space < 0 ? "" : line.slice(space + 1).trim();
    if (key === "core.fsmonitor") {
      if (space >= 0 && !FALSE_OR_TRUE.test(value)) fsmonitor = true;
    } else {
      diff = true;
    }
  }
  return { diff, fsmonitor };
}

/** Bound for the `git ls-files -z` listing of a large repository. */
const LS_FILES_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * R41: whether the repository around `cwd` tracks a secret path (`git ls-files -z` at the top level through the safe
 * git wrapper, each path checked with `isSecretPath`). Undefined when it cannot be determined (not a work tree, git
 * missing or failing, unusable home): the gate then asks. Content-printing git commands (diff, show, blame, log with
 * patches) print tracked files wherever they run in the work tree, hence the top level.
 */
export function trackedSecretFact(cwd: string, home: string, piAgentDir: string): boolean | undefined {
  const top = repoRoot(cwd);
  if (top === undefined) return undefined;
  let ctx: { home: string; piAgentDir: string; platform: PathPlatform };
  try {
    ctx = { home: canonicalDir(home), piAgentDir: canonicalDir(piAgentDir), platform: hostPlatform() };
  } catch {
    return undefined;
  }
  const r = gitRunBytes(top, ["ls-files", "-z"], GIT_TIMEOUT_MS, LS_FILES_MAX_BUFFER);
  if (r.status !== 0) return undefined;
  for (const rel of r.stdout.toString("utf8").split("\0")) {
    if (rel !== "" && isSecretPath(path.join(top, rel), ctx)) return true;
  }
  return false;
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Carry-forward N1: `base` names a commit of the repository at `dir` that is an ancestor of HEAD (`rev-parse
 * --verify <base>^{commit}`, `merge-base --is-ancestor`). Only a full hex object id is passed to git.
 */
export function baseIsAncestor(dir: string, base: string): boolean {
  if (!COMMIT_ID.test(base) || !isDir(dir)) return false;
  if (gitOut(dir, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === undefined) return false;
  return gitRun(dir, ["merge-base", "--is-ancestor", base, "HEAD"]).status === 0;
}
