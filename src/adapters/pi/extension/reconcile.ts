// Answer-route runner reconciliation (Phase 2 Task 11, M §3.1, ruling 5, R38, R39). Before an allowlisted runner
// runs on the answer route, `takeSnapshot` records the work tree; at that call's `tool_result`, `reconcileAfter`
// reverts what changed. Data-safety rule: nothing is deleted or overwritten without a copy (the pre-revert state goes
// to `<backupDir>/after/`), and no git object or ref is created in the user's repository (only read-only git commands
// run; the index file is the only `.git` file written, and only after it is backed up). Reconciliation never follows
// a symlink: entries are examined with lstat, links are copied as links, and a restore below a parent directory that
// became a symlink is refused (R39). Git-ignored outputs are left alone. `<backupDir>/manifest.json` holds everything
// needed to finish the job after an interruption (Task 13: `loadSnapshot` + `reconcileAfter`); it holds hashes and
// metadata, never file contents.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { RunEvent } from "../../../core/ledger/events.ts";
import { gitFailureText } from "./facts.ts";
import { withSafeGit, type Git, type GitBytes } from "./task-state.ts";

/** R38: pre-existing untracked non-ignored files are backed up; beyond these limits the runner is refused. */
export interface SnapshotLimits {
  maxUntrackedFiles: number;
  maxUntrackedBytes: number;
}
export const UNTRACKED_LIMITS: SnapshotLimits = { maxUntrackedFiles: 2000, maxUntrackedBytes: 50 * 1024 * 1024 };
export const MANIFEST_FILE = "manifest.json";
/** The note names at most this many paths per list; the ledger event and the manifest name all of them. */
export const NOTE_MAX_PATHS = 100;
/** Bound for git listings and for one blob read back from the object database. */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const isWin = process.platform === "win32";
/** O_NOFOLLOW where the platform has it (not on Windows: there the lstat checks are the guard, best effort). */
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** A snapshot cannot be taken safely: the runner call is denied (fail closed). */
export class ReconcileRefusal extends Error {}

export type EntryState =
  | { kind: "file"; sha256: string; mode: number; size: number }
  | { kind: "symlink"; target: string }
  | { kind: "dir" }
  | { kind: "missing" }
  | { kind: "other" }
  /** A parent directory is a symlink, a file or something else: the entry is never read through it. */
  | { kind: "blocked"; by: string; reason: "symlink" | "file" | "other" };

export interface TrackedEntry {
  /** Repository-relative, `/`-separated (git's form). */
  path: string;
  /** The index entry's object id in the backed-up index; "" for a conflicted path (no stage-0 entry). */
  oid: string;
  state: EntryState;
  /** True when the working-tree content was copied to `before/<path>` (it differs from the index, HEAD or the object is missing). */
  backup: boolean;
}

export interface UntrackedEntry {
  path: string;
  /** Files and symlinks; always copied to `before/<path>` (R38). */
  state: EntryState;
}

export interface ReconcileResult {
  /** Paths restored to their snapshot state (the replaced content is under `after/`). */
  reverted: string[];
  /** New untracked non-ignored entries moved to `after/`. */
  moved: string[];
  /** Paths that could not be restored, each with the reason; their current state and the copies are kept. */
  notRestored: string[];
  /** Gitlinks, nested repositories and entries below a symlink at snapshot time: never reconciled. */
  skipped: string[];
  /** The index was restored from `<backupDir>/index` (the replaced index is `after/index`). */
  indexRestored: boolean;
  backupDir: string;
  /** Absolute copy locations that are not `after/<path>` (a collision inside `after/`). */
  elsewhere?: Record<string, string>;
  /** True when nothing changed and the backup directory was removed. */
  backupRemoved?: boolean;
}

/** The manifest (`<backupDir>/manifest.json`) and the in-memory snapshot are the same object. */
export interface Snapshot {
  v: 1;
  /** `pending` from the snapshot until `reconcileAfter` finishes; then `done` with `result`. */
  status: "pending" | "done";
  createdAt: string;
  /** Realpath of the work tree top. */
  root: string;
  backupDir: string;
  /** Absolute path of the work tree's index (`git rev-parse --git-path index`). */
  indexFile: string;
  /** False when the repository had no index file yet (a later index is moved to `after/index`). */
  indexExisted: boolean;
  tracked: TrackedEntry[];
  untracked: UntrackedEntry[];
  skipped: string[];
  result?: ReconcileResult;
}

// --- Filesystem helpers (never follow a symlink) ----------------------------------------------------------------

type Kind = "dir" | "file" | "symlink" | "missing" | "other";

function kindOf(abs: string): Kind {
  try {
    const st = lstatSync(abs);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw e;
  }
}

const abs = (root: string, rel: string) => path.join(root, ...rel.split("/"));

function sha256Of(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

interface Hashed {
  sha256: string;
  size: number;
  mode: number;
  /** The git blob id of the content (sha1 or sha256 object format). */
  oid: string;
}

/**
 * Reads a regular file without following a final symlink (O_NOFOLLOW; the caller has checked the parents), hashing
 * it and optionally copying it to `copyTo` (exclusive create, 0600).
 */
function readRegular(file: string, objectFormat: "sha1" | "sha256", copyTo?: string): Hashed {
  const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
  let out: number | undefined;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    const sha = createHash("sha256");
    // The blob header needs the size up front: a file that grows or shrinks while it is read gets no blob id.
    const git = createHash(objectFormat).update(`blob ${st.size}\0`);
    let size = 0;
    if (copyTo !== undefined) out = openSync(copyTo, "wx", FILE_MODE);
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const part = buf.subarray(0, n);
      sha.update(part);
      git.update(part);
      if (out !== undefined) writeAll(out, part);
      size += n;
    }
    const oid = git.digest("hex");
    return { sha256: sha.digest("hex"), size, mode: st.mode & 0o777, oid: size === st.size ? oid : "" };
  } finally {
    closeSync(fd);
    if (out !== undefined) closeSync(out);
  }
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** Creates `dir` and every missing parent below `base` with mode 0700 (best effort on Windows). */
function mkdirsPrivate(base: string, dir: string): void {
  const rel = path.relative(base, dir);
  if (rel === "") return;
  let cur = base;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    const k = kindOf(cur);
    if (k === "dir") continue;
    if (k !== "missing") throw new Error(`${cur} exists and is not a directory`);
    mkdirSync(cur, { mode: DIR_MODE });
    chmodSync(cur, DIR_MODE);
  }
}

/** The fresh backup directory (and its parents) with mode 0700; an existing one is an error. */
function createBackupDir(backupDir: string): void {
  mkdirSync(path.dirname(backupDir), { recursive: true, mode: DIR_MODE });
  mkdirSync(backupDir, { mode: DIR_MODE });
  chmodSync(backupDir, DIR_MODE);
}

function writePrivateAtomic(file: string, text: string | Buffer): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: FILE_MODE });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Not created, or already renamed.
    }
    throw e;
  }
}

function saveManifest(s: Snapshot): void {
  writePrivateAtomic(path.join(s.backupDir, MANIFEST_FILE), `${JSON.stringify(s, null, 1)}\n`);
}

/** Copies a symlink as a symlink; false when the platform refuses (Windows without the privilege). */
function copyLink(target: string, dst: string): boolean {
  try {
    symlinkSync(target, dst);
    return true;
  } catch {
    return false;
  }
}

// --- State of a work tree entry ---------------------------------------------------------------------------------

/**
 * The lstat-based state of `rel` below `root`. Every parent is checked first: a parent that is a symlink, a file or
 * anything but a directory blocks the entry (it is never read through it). `cache` holds parent kinds for one pass.
 */
function stateOf(root: string, rel: string, objectFormat: "sha1" | "sha256", cache?: Map<string, Kind>, withOid?: { oid?: string }): EntryState {
  const parts = rel.split("/");
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur === "" ? parts[i]! : `${cur}/${parts[i]!}`;
    let k = cache?.get(cur);
    if (k === undefined) {
      k = kindOf(abs(root, cur));
      cache?.set(cur, k);
    }
    if (k === "dir") continue;
    if (k === "missing") return { kind: "missing" };
    return { kind: "blocked", by: cur, reason: k === "symlink" ? "symlink" : k === "file" ? "file" : "other" };
  }
  const file = abs(root, rel);
  const k = kindOf(file);
  if (k === "missing") return { kind: "missing" };
  if (k === "dir") return { kind: "dir" };
  if (k === "other") return { kind: "other" };
  if (k === "symlink") {
    const target = readlinkSync(file);
    if (withOid) withOid.oid = createHash(objectFormat).update(`blob ${Buffer.byteLength(target)}\0`).update(target).digest("hex");
    return { kind: "symlink", target };
  }
  const h = readRegular(file, objectFormat);
  if (withOid) withOid.oid = h.oid;
  return { kind: "file", sha256: h.sha256, mode: h.mode, size: h.size };
}

/** The first parent of `rel` that is not a real directory (a symlink, a file, ...), or undefined. */
function blockingParent(root: string, rel: string): string | undefined {
  const parts = rel.split("/");
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur === "" ? parts[i]! : `${cur}/${parts[i]!}`;
    const k = kindOf(abs(root, cur));
    if (k === "missing") return undefined;
    if (k !== "dir") return cur;
  }
  return undefined;
}

function sameState(a: EntryState, b: EntryState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.sha256 === b.sha256 && (isWin || a.mode === b.mode);
  if (a.kind === "symlink" && b.kind === "symlink") return a.target === b.target;
  if (a.kind === "blocked" && b.kind === "blocked") return a.by === b.by && a.reason === b.reason;
  return true;
}

// --- Git (read-only) --------------------------------------------------------------------------------------------

function gitOk(git: Git, cwd: string, args: string[], what: string, env?: Record<string, string>, input?: string): string {
  const r = git(cwd, args, input, env);
  if (r.status !== 0) throw new ReconcileRefusal(gitFailureText(what, r));
  return r.stdout;
}

function gitBytesOk(gitBytes: GitBytes, cwd: string, args: string[], what: string, env?: Record<string, string>, input?: string): Buffer {
  const r = gitBytes(cwd, args, GIT_MAX_BUFFER, env, input);
  if (r.status !== 0) throw new ReconcileRefusal(gitFailureText(what, r));
  return r.stdout;
}

/** `git rev-parse --git-path <name>` as an absolute path (works in linked worktrees). */
function gitPathOf(git: Git, top: string, name: string): string {
  let r = git(top, ["rev-parse", "--path-format=absolute", "--git-path", name]);
  let out = r.stdout.trim();
  if (r.status !== 0 || out.includes("\n") || out.startsWith("-")) {
    r = git(top, ["rev-parse", "--git-path", name]);
    out = r.stdout.trim();
    if (r.status !== 0 || out === "") throw new ReconcileRefusal(gitFailureText(`git rev-parse --git-path ${name}`, r));
  }
  return path.resolve(top, out);
}

function objectFormatOf(git: Git, top: string): "sha1" | "sha256" {
  const r = git(top, ["rev-parse", "--show-object-format"]);
  return r.status === 0 && r.stdout.trim() === "sha256" ? "sha256" : "sha1";
}

const nulSplit = (b: Buffer) =>
  b
    .toString("utf8")
    .split("\0")
    .filter((s) => s !== "");

interface IndexEntry {
  oid: string;
  mode: string;
  conflicted: boolean;
}

/** `git ls-files -s -z` of the backed-up index: path → stage-0 entry (or conflicted). */
function indexEntries(gitBytes: GitBytes, top: string, env: Record<string, string>): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  for (const rec of nulSplit(gitBytesOk(gitBytes, top, ["ls-files", "-s", "-z"], "git ls-files -s", env))) {
    const tab = rec.indexOf("\t");
    const [mode, oid, stage] = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    const prev = out.get(p);
    if (stage !== "0") out.set(p, { oid: "", mode: prev?.mode ?? mode!, conflicted: true });
    else out.set(p, { oid: oid!, mode: mode!, conflicted: prev?.conflicted ?? false });
  }
  return out;
}

/** Untracked non-ignored paths relative to the backed-up index (a nested repository ends with `/`). */
function untrackedPaths(gitBytes: GitBytes, top: string, env: Record<string, string>): string[] {
  return nulSplit(gitBytesOk(gitBytes, top, ["ls-files", "--others", "--exclude-standard", "-z"], "git ls-files --others", env));
}

// --- Snapshot ---------------------------------------------------------------------------------------------------

/** Read-only git against the backed-up index, never writing an optional lock or a refreshed index. */
function readEnv(backupDir: string): Record<string, string> {
  return { GIT_INDEX_FILE: path.join(backupDir, "index"), GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * Records the work tree of `root` (its top) in `backupDir` (`<runDir>/reconcile/<toolCallId>`, created here, 0700):
 * the index file (`backupDir/index`), the content of every tracked file that differs from the index or HEAD (or
 * whose object is missing) and of every untracked non-ignored file (`backupDir/before/<path>`, R38), the sha256 of
 * every tracked file, and the manifest. Throws `ReconcileRefusal` (and removes `backupDir`) on any failure or over
 * the untracked limits: the runner must not run without a valid snapshot.
 */
export function takeSnapshot(root: string, backupDir: string, limits: SnapshotLimits = UNTRACKED_LIMITS): Snapshot {
  let top: string;
  try {
    top = realpathSync.native(root);
  } catch (e) {
    throw new ReconcileRefusal(`${root} cannot be resolved: ${(e as Error).message}`);
  }
  createBackupDir(backupDir);
  try {
    return withSafeGit((git, gitBytes) => snapshotIn(git, gitBytes, top, backupDir, limits));
  } catch (e) {
    rmSync(backupDir, { recursive: true, force: true });
    if (e instanceof ReconcileRefusal) throw e;
    throw new ReconcileRefusal(`the snapshot failed: ${(e as Error).message}`);
  }
}

function snapshotIn(git: Git, gitBytes: GitBytes, top: string, backupDir: string, limits: SnapshotLimits): Snapshot {
  const show = git(top, ["rev-parse", "--show-toplevel"]);
  if (show.status !== 0 || show.stdout.trim() === "") throw new ReconcileRefusal(`${top} is not a git work tree: answer-route runners are reconciled with git`);
  const repoTop = realpathSync.native(path.resolve(top, show.stdout.trim()));
  if (repoTop !== top) throw new ReconcileRefusal(`${top} is not the top of its git work tree (${repoTop})`);
  const indexFile = gitPathOf(git, top, "index");
  const objectFormat = objectFormatOf(git, top);

  // The index first, before any other git command could refresh it.
  const indexKind = kindOf(indexFile);
  if (indexKind !== "missing" && indexKind !== "file") throw new ReconcileRefusal(`the index ${indexFile} is not a regular file`);
  const indexExisted = indexKind === "file";
  if (indexExisted) readRegular(indexFile, objectFormat, path.join(backupDir, "index"));
  const env = readEnv(backupDir);

  // Untracked non-ignored files: counted and sized before anything is read (R38 cap).
  const skipped: string[] = [];
  const untrackedList: string[] = [];
  for (const p of untrackedPaths(gitBytes, top, env)) {
    if (p.endsWith("/")) skipped.push(`${p.slice(0, -1)} (nested repository)`);
    else untrackedList.push(p);
  }
  let bytes = 0;
  for (const p of untrackedList) {
    try {
      const st = lstatSync(abs(top, p));
      if (st.isFile()) bytes += st.size;
    } catch {
      // Gone already: it is recorded as missing below.
    }
  }
  if (untrackedList.length > limits.maxUntrackedFiles || bytes > limits.maxUntrackedBytes) {
    throw new ReconcileRefusal(
      `too many untracked files to reconcile safely (${untrackedList.length} files, ${bytes} bytes; the limit is ${limits.maxUntrackedFiles} files and ${limits.maxUntrackedBytes} bytes): declare a change route with set_route`,
    );
  }

  // Tracked files: hash all of them; back up those the index cannot give back byte for byte.
  const entries = indexEntries(gitBytes, top, env);
  const head = git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const stagedVsHead = new Set(
    head.status === 0 ? nulSplit(gitBytesOk(gitBytes, top, ["diff-index", "--cached", "--name-only", "-z", "--no-renames", "HEAD"], "git diff-index --cached", env)) : [...entries.keys()],
  );
  const oids = [...new Set([...entries.values()].map((e) => e.oid).filter((o) => o !== ""))];
  const present = new Set<string>();
  if (oids.length > 0) {
    const check = gitBytesOk(gitBytes, top, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], "git cat-file --batch-check", env, `${oids.join("\n")}\n`);
    for (const line of check.toString("utf8").split("\n")) {
      const [oid, type] = line.split(" ");
      if (oid !== undefined && type === "blob") present.add(oid);
    }
  }
  const cache = new Map<string, Kind>();
  const tracked: TrackedEntry[] = [];
  for (const [p, e] of entries) {
    if (e.mode === "160000") {
      skipped.push(`${p} (gitlink)`);
      continue;
    }
    const seen: { oid?: string } = {};
    const state = stateOf(top, p, objectFormat, cache, seen);
    if (state.kind === "blocked") {
      skipped.push(`${p} (below ${state.reason === "symlink" ? "a symlink" : "a non-directory"}: ${state.by})`);
      continue;
    }
    const clean = !e.conflicted && seen.oid === e.oid && !stagedVsHead.has(p) && present.has(e.oid);
    const backup = !clean && (state.kind === "file" || state.kind === "symlink");
    tracked.push({ path: p, oid: e.oid, state, backup });
  }
  for (const t of tracked) if (t.backup) backupEntry(top, backupDir, t.path, t.state, objectFormat);

  const untracked: UntrackedEntry[] = [];
  for (const p of untrackedList) {
    const state = stateOf(top, p, objectFormat, cache);
    if (state.kind === "blocked") {
      skipped.push(`${p} (below ${state.reason === "symlink" ? "a symlink" : "a non-directory"}: ${state.by})`);
      continue;
    }
    if (state.kind === "file" || state.kind === "symlink") backupEntry(top, backupDir, p, state, objectFormat);
    if (state.kind !== "missing") untracked.push({ path: p, state });
  }

  const snapshot: Snapshot = {
    v: 1,
    status: "pending",
    createdAt: new Date().toISOString(),
    root: top,
    backupDir,
    indexFile,
    indexExisted,
    tracked,
    untracked,
    skipped,
  };
  saveManifest(snapshot);
  return snapshot;
}

/** Copies one file (verified against its snapshot hash) or symlink (as a link, best effort) to `before/<rel>`. */
function backupEntry(top: string, backupDir: string, rel: string, state: EntryState, objectFormat: "sha1" | "sha256"): void {
  const dst = abs(path.join(backupDir, "before"), rel);
  mkdirsPrivate(backupDir, path.dirname(dst));
  if (state.kind === "symlink") {
    // The target is also in the manifest, which is what a restore uses.
    copyLink(state.target, dst);
    return;
  }
  if (state.kind !== "file") return;
  const h = readRegular(abs(top, rel), objectFormat, dst);
  if (h.sha256 !== state.sha256) throw new ReconcileRefusal(`${rel} changed while the snapshot was taken`);
}

/** The snapshot persisted in `backupDir/manifest.json` (Task 13 finishes an interrupted call with it). */
export function loadSnapshot(backupDir: string): Snapshot {
  const s = JSON.parse(readFileSync(path.join(backupDir, MANIFEST_FILE), "utf8")) as Snapshot;
  if (s.v !== 1 || typeof s.root !== "string" || !Array.isArray(s.tracked) || !Array.isArray(s.untracked)) {
    throw new Error(`${path.join(backupDir, MANIFEST_FILE)} is not a reconcile manifest`);
  }
  return { ...s, backupDir };
}

// --- Reconcile --------------------------------------------------------------------------------------------------

class Restorer {
  readonly result: ReconcileResult;
  private readonly elsewhere: Record<string, string> = {};

  private readonly s: Snapshot;
  private readonly gitBytes: GitBytes;

  constructor(s: Snapshot, gitBytes: GitBytes) {
    this.s = s;
    this.gitBytes = gitBytes;
    this.result = { reverted: [], moved: [], notRestored: [], skipped: [...s.skipped], indexRestored: false, backupDir: s.backupDir };
  }

  get elsewhereMap(): Record<string, string> {
    return this.elsewhere;
  }

  /** `after/<rel>`, or `after-<n>/<rel>` when that place is taken (the location is recorded). */
  private afterPath(rel: string, allowExistingDir = false): string {
    for (let n = 1; n < 1000; n++) {
      const base = path.join(this.s.backupDir, n === 1 ? "after" : `after-${n}`);
      const dst = abs(base, rel);
      const parentsOk = (() => {
        let cur = path.dirname(dst);
        while (cur.length > base.length) {
          const k = kindOf(cur);
          if (k !== "dir" && k !== "missing") return false;
          cur = path.dirname(cur);
        }
        return true;
      })();
      const k = kindOf(dst);
      if (parentsOk && (k === "missing" || (allowExistingDir && k === "dir"))) {
        mkdirsPrivate(this.s.backupDir, path.dirname(dst));
        if (n > 1) this.elsewhere[rel] = dst;
        return dst;
      }
    }
    throw new Error(`no free place under ${this.s.backupDir} for ${rel}`);
  }

  /** Copies the current regular file at `rel` to `after/` (the file itself stays until it is replaced). */
  private copyAside(rel: string): void {
    const dst = this.afterPath(rel);
    readRegular(abs(this.s.root, rel), "sha1", dst);
  }

  /**
   * Moves the entry at `rel` (file, symlink, directory or other) to `after/`: a rename, or across filesystems a
   * copy (links as links) followed by the removal of the original. An empty directory whose place in `after/` is
   * already a directory (its content was moved there first) is removed.
   */
  moveAside(rel: string): void {
    const src = abs(this.s.root, rel);
    const k = kindOf(src);
    if (k === "missing") return;
    if (k === "dir" && readdirSync(src).length === 0) {
      const dst = abs(path.join(this.s.backupDir, "after"), rel);
      if (kindOf(dst) === "dir") {
        rmdirSync(src);
        return;
      }
    }
    const dst = this.afterPath(rel);
    try {
      renameSync(src, dst);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    }
    copyTree(src, dst);
    rmSync(src, { recursive: true, force: false });
  }

  /**
   * Makes every parent of `rel` a real directory: a missing one is created, a file (or other non-directory) in the
   * way is moved aside first. A parent that is a symlink is never written through (R39): the reason is returned.
   */
  private ensureParents(rel: string): string | undefined {
    const parts = rel.split("/");
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur === "" ? parts[i]! : `${cur}/${parts[i]!}`;
      const k = kindOf(abs(this.s.root, cur));
      if (k === "dir") continue;
      if (k === "symlink") return `a parent directory became a symlink (${cur}): not written through it`;
      if (k !== "missing") this.moveAside(cur);
      mkdirSync(abs(this.s.root, cur));
    }
    return undefined;
  }

  /** The content to restore for a file state, verified against the snapshot hash before anything is written. */
  private source(rel: string, state: Extract<EntryState, { kind: "file" }>, fromBackup: boolean, oid: string): Buffer {
    let data: Buffer;
    if (fromBackup) {
      const file = abs(path.join(this.s.backupDir, "before"), rel);
      if (kindOf(file) !== "file") throw new Error("its backup copy is missing");
      data = readFileSync(file);
    } else {
      if (oid === "") throw new Error("no index entry to restore it from");
      data = gitBytesOk(this.gitBytes, this.s.root, ["cat-file", "blob", oid], `git cat-file blob ${oid}`, readEnv(this.s.backupDir));
    }
    if (sha256Of(data) !== state.sha256) throw new Error(`the restore source does not match the snapshot (${fromBackup ? "backup copy" : "index blob"} changed)`);
    return data;
  }

  /** Atomic replace: a temporary entry in the same directory renamed over `rel` (links as links). */
  private put(rel: string, state: EntryState, data?: Buffer): void {
    const dst = abs(this.s.root, rel);
    const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.factory-reconcile-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      if (state.kind === "file") {
        writeFileSync(tmp, data!, { flag: "wx", mode: state.mode });
        chmodSync(tmp, state.mode);
      } else if (state.kind === "symlink") {
        symlinkSync(state.target, tmp);
      } else {
        throw new Error(`cannot restore a ${state.kind}`);
      }
      renameSync(tmp, dst);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // Not created, or already renamed.
      }
      throw e;
    }
  }

  /** Brings `rel` back to `want` (its snapshot state), keeping whatever is there now under `after/`. */
  restore(rel: string, want: EntryState, cur: EntryState, fromBackup: boolean, oid: string): void {
    if (cur.kind === "blocked" && cur.reason === "symlink") {
      this.result.notRestored.push(`${rel} (a parent directory became a symlink (${cur.by}): not written through it)`);
      return;
    }
    if (want.kind === "blocked" || want.kind === "other") {
      this.result.notRestored.push(`${rel} (its snapshot state cannot be restored)`);
      return;
    }
    try {
      // Read and verify the source first: an unusable source leaves the current entry untouched.
      const data = want.kind === "file" ? this.source(rel, want, fromBackup, oid) : undefined;
      // A file that is replaced stays in place until the atomic rename; anything else is moved aside first.
      if (cur.kind === "file" && (want.kind === "file" || want.kind === "symlink")) this.copyAside(rel);
      else if (cur.kind !== "missing" && cur.kind !== "blocked") this.moveAside(rel);
      if (want.kind !== "missing") {
        const refused = this.ensureParents(rel);
        if (refused !== undefined) {
          this.result.notRestored.push(`${rel} (${refused})`);
          return;
        }
        if (want.kind === "dir") {
          if (kindOf(abs(this.s.root, rel)) !== "dir") mkdirSync(abs(this.s.root, rel));
        } else {
          this.put(rel, want, data);
        }
      }
      const now = stateOf(this.s.root, rel, "sha1");
      if (sameState(now, want)) this.result.reverted.push(rel);
      else this.result.notRestored.push(`${rel} (it does not match the snapshot after the restore)`);
    } catch (e) {
      this.result.notRestored.push(`${rel} (${(e as Error).message})`);
    }
  }

  /**
   * Restores the index file from `backupDir/index` through `index.lock` (git's own lock protocol: a concurrent git
   * command holding the lock wins and the index is reported as not restored). Runs first, so the replaced index is
   * always `after/index`.
   */
  restoreIndex(): void {
    const s = this.s;
    const curKind = kindOf(s.indexFile);
    const aside = path.join(s.backupDir, "after", "index");
    if (curKind !== "missing" && curKind !== "file") {
      this.result.notRestored.push(`(index) (${s.indexFile} is not a regular file)`);
      return;
    }
    if (!s.indexExisted) {
      if (curKind === "missing") return;
      try {
        this.copyFileTo(s.indexFile, aside);
        unlinkSync(s.indexFile);
        this.result.indexRestored = true;
      } catch (e) {
        this.result.notRestored.push(`(index) (${(e as Error).message})`);
      }
      return;
    }
    const want = readFileSync(path.join(s.backupDir, "index"));
    if (curKind === "file" && readFileSync(s.indexFile).equals(want)) return;
    const lock = `${s.indexFile}.lock`;
    let fd: number;
    try {
      if (curKind === "file") this.copyFileTo(s.indexFile, aside);
      fd = openSync(lock, "wx", 0o644);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.result.notRestored.push(code === "EEXIST" ? `(index) (${lock} exists: another git command holds the index; it was not restored)` : `(index) (${(e as Error).message})`);
      return;
    }
    try {
      writeAll(fd, want);
      closeSync(fd);
      renameSync(lock, s.indexFile);
      this.result.indexRestored = true;
    } catch (e) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
      try {
        unlinkSync(lock);
      } catch {
        // Already renamed or gone.
      }
      this.result.notRestored.push(`(index) (${(e as Error).message})`);
    }
  }

  private copyFileTo(src: string, dst: string): void {
    mkdirsPrivate(this.s.backupDir, path.dirname(dst));
    readRegular(src, "sha1", dst);
  }
}

/** Copies a tree without following symlinks (links as links, files 0600, directories 0700). */
function copyTree(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    const target = readlinkSync(src);
    if (!copyLink(target, dst)) writeFileSync(`${dst}.symlink-target`, target, { flag: "wx", mode: FILE_MODE });
  } else if (st.isDirectory()) {
    mkdirSync(dst, { mode: DIR_MODE });
    chmodSync(dst, DIR_MODE);
    for (const name of readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
  } else if (st.isFile()) {
    readRegular(src, "sha1", dst);
  } else {
    throw new Error(`${src} is neither a file, a directory nor a symlink and cannot be copied`);
  }
}

/**
 * Reverts what changed since `snapshot` in its work tree (`root` must be the snapshot's root): new untracked
 * non-ignored entries are moved to `after/`; tracked files and pre-existing untracked files whose state changed are
 * copied (or moved) to `after/` and restored from `before/` or from their index blob, each verified against its
 * snapshot hash before it is written and after; the index is copied to `after/index` and restored. A concurrent user
 * edit cannot be told apart from the command's: it is reverted too, with its content kept in `after/`. When nothing
 * changed the backup directory is removed. The manifest records the result (`status: "done"`).
 */
export function reconcileAfter(root: string, snapshot: Snapshot): ReconcileResult {
  const s = snapshot;
  const top = realpathSync.native(root);
  if (top !== s.root) throw new Error(`reconcile root ${top} is not the snapshot root ${s.root}`);
  if (kindOf(s.root) !== "dir") throw new Error(`${s.root} is no longer a directory`);
  const result = withSafeGit((_git, gitBytes) => {
    const r = new Restorer(s, gitBytes);
    const env = readEnv(s.backupDir);

    // 0. The index (the listings below read the snapshot's copy, so the order does not change them).
    r.restoreIndex();
    const trackedPaths = new Set(s.tracked.map((t) => t.path));
    const known = new Set(s.untracked.map((u) => u.path));
    const skippedNested = new Set(s.skipped.filter((x) => x.endsWith(" (nested repository)")).map((x) => x.slice(0, -" (nested repository)".length)));

    // 1. New untracked non-ignored entries (relative to the snapshot's index) are moved aside first: this also frees
    //    paths where the command put a file, a directory or a symlink in place of a tracked file's parent.
    for (const p of untrackedPaths(gitBytes, s.root, env)) {
      const rel = p.endsWith("/") ? p.slice(0, -1) : p;
      if (known.has(rel) || trackedPaths.has(rel) || skippedNested.has(rel)) continue;
      try {
        const blocker = blockingParent(s.root, rel);
        if (blocker !== undefined) {
          r.result.notRestored.push(`${rel} (below ${blocker}, which is not a directory: left in place)`);
          continue;
        }
        r.moveAside(rel);
        r.result.moved.push(rel);
      } catch (e) {
        r.result.notRestored.push(`${rel} (could not be moved aside: ${(e as Error).message})`);
      }
    }

    // 2. Tracked files. Each entry fails on its own: an unreadable file is reported, the others are still restored.
    const cache = new Map<string, Kind>();
    const changed: TrackedEntry[] = [];
    for (const t of s.tracked) {
      try {
        if (!sameState(stateOf(s.root, t.path, "sha1", cache), t.state)) changed.push(t);
      } catch (e) {
        r.result.notRestored.push(`${t.path} (its current state cannot be read: ${(e as Error).message})`);
      }
    }
    for (const t of changed) {
      try {
        // Fresh state: an earlier restore may have moved a blocker.
        r.restore(t.path, t.state, stateOf(s.root, t.path, "sha1"), t.backup, t.oid);
      } catch (e) {
        r.result.notRestored.push(`${t.path} (${(e as Error).message})`);
      }
    }

    // 3. Pre-existing untracked files (R38).
    for (const u of s.untracked) {
      try {
        const cur = stateOf(s.root, u.path, "sha1");
        if (!sameState(cur, u.state)) r.restore(u.path, u.state, cur, true, "");
      } catch (e) {
        r.result.notRestored.push(`${u.path} (${(e as Error).message})`);
      }
    }
    const elsewhere = r.elsewhereMap;
    return Object.keys(elsewhere).length > 0 ? { ...r.result, elsewhere } : r.result;
  });

  const nothing = result.reverted.length === 0 && result.moved.length === 0 && result.notRestored.length === 0 && !result.indexRestored;
  if (nothing) {
    // Every original is in place and unchanged: the copies are redundant.
    rmSync(s.backupDir, { recursive: true, force: true });
    return { ...result, backupRemoved: true };
  }
  s.status = "done";
  s.result = result;
  saveManifest(s);
  return result;
}

// --- Note and enforce wiring ------------------------------------------------------------------------------------

function list(paths: string[], backupDir: string): string {
  if (paths.length <= NOTE_MAX_PATHS) return paths.join(", ");
  return `${paths.slice(0, NOTE_MAX_PATHS).join(", ")} and ${paths.length - NOTE_MAX_PATHS} more (all listed in ${path.join(backupDir, MANIFEST_FILE)})`;
}

/** The note appended to the tool result; undefined when there is nothing to tell. */
export function reconcileNote(r: ReconcileResult): string | undefined {
  const parts: string[] = [];
  if (r.reverted.length > 0) parts.push(`reverted ${list(r.reverted, r.backupDir)}`);
  if (r.moved.length > 0) parts.push(`moved aside (new files) ${list(r.moved, r.backupDir)}`);
  if (r.indexRestored) parts.push("index restored");
  if (r.notRestored.length > 0) parts.push(`not restored (check these before continuing): ${list(r.notRestored, r.backupDir)}`);
  if (r.skipped.length > 0) parts.push(`not reconciled (skipped): ${list(r.skipped, r.backupDir)}`);
  if (parts.length === 0) return undefined;
  if (r.backupRemoved === true) return `Answer-route reconciliation: nothing to revert; ${parts.join("; ")}`;
  return `Reverted on the answer route (copies in ${r.backupDir}): ${parts.join("; ")}`;
}

interface Sink {
  append(e: RunEvent): void;
}

type Content = ToolResultEvent["content"];

export interface ResultLike {
  toolCallId: string;
  content: Content;
  isError: boolean;
  structuredContent?: ToolResultEvent["structuredContent"];
}

/**
 * Snapshots of the allowed answer-route runner calls, by toolCallId, until their `tool_result` (or
 * `tool_execution_end` for a call another extension blocked, or the `agent_settled` / `session_shutdown` backstop).
 * A nested call's snapshot is reconciled no later than its parent's result, innermost first.
 */
export class Reconciler {
  private readonly pending = new Map<string, { snapshot: Snapshot; parent?: string }>();

  private readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  get size(): number {
    return this.pending.size;
  }

  private dirFor(toolCallId: string): string {
    let name = toolCallId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    if (name === "" || /^\.+$/.test(name)) name = "call";
    const base = path.join(this.runDir, "reconcile");
    for (let n = 1; ; n++) {
      const dir = path.join(base, n === 1 ? name : `${name}-${n}`);
      if (kindOf(dir) === "missing") return dir;
    }
  }

  /** Takes the snapshot for `toolCallId`; throws `ReconcileRefusal` when the runner must not run. Returns the backup dir. */
  begin(toolCallId: string, parentToolCallId: string | undefined, root: string): string {
    const snapshot = takeSnapshot(root, this.dirFor(toolCallId));
    this.pending.set(toolCallId, { snapshot, ...(parentToolCallId !== undefined ? { parent: parentToolCallId } : {}) });
    return snapshot.backupDir;
  }

  /** The call never ran (its gate event could not be written): its snapshot and backup are dropped. */
  discard(toolCallId: string): void {
    const p = this.pending.get(toolCallId);
    if (p === undefined) return;
    this.pending.delete(toolCallId);
    rmSync(p.snapshot.backupDir, { recursive: true, force: true });
  }

  /** Reconciles the call (after its nested calls) and appends the note to its result; undefined when there is nothing to add. */
  finish(ev: ResultLike, ledger: Sink, runId: string): { content: Content; structuredContent?: ToolResultEvent["structuredContent"] } | undefined {
    const notes = this.finishTree(ev.toolCallId, ledger, runId);
    if (notes.length === 0) return undefined;
    const content: Content = [...ev.content, ...notes.map((n) => ({ type: "text" as const, text: `\n[factory] ${n}` }))];
    return { content, ...(ev.structuredContent !== undefined ? { structuredContent: ev.structuredContent } : {}) };
  }

  /** Reconciles a call that ended without a result the extension can amend. */
  finishId(toolCallId: string, ledger: Sink, runId: string): void {
    this.finishTree(toolCallId, ledger, runId);
  }

  /** Backstop: every pending call, latest first. */
  finishAll(ledger: Sink, runId: string): void {
    for (const id of [...this.pending.keys()].reverse()) this.finishTree(id, ledger, runId);
  }

  private finishTree(toolCallId: string, ledger: Sink, runId: string): string[] {
    const notes: string[] = [];
    const children = [...this.pending.entries()].filter(([, p]) => p.parent === toolCallId).map(([id]) => id);
    for (const id of children.reverse()) notes.push(...this.finishTree(id, ledger, runId));
    const p = this.pending.get(toolCallId);
    if (p === undefined) return notes;
    this.pending.delete(toolCallId);
    const backupDir = p.snapshot.backupDir;
    try {
      const r = reconcileAfter(p.snapshot.root, p.snapshot);
      append(ledger, {
        v: 1,
        ts: new Date().toISOString(),
        runId,
        type: "reconciled",
        toolCallId,
        reverted: r.reverted,
        moved: r.moved,
        backupDir,
        ...(r.notRestored.length > 0 ? { notRestored: r.notRestored } : {}),
        ...(r.skipped.length > 0 ? { skipped: r.skipped } : {}),
        ...(r.indexRestored ? { indexRestored: true } : {}),
        ...(r.backupRemoved === true ? { backupRemoved: true } : {}),
      });
      const note = reconcileNote(r);
      if (note !== undefined) notes.push(note);
    } catch (e) {
      const message = `reconciliation of answer-route call ${toolCallId} failed (${(e as Error).message}); the snapshot and copies are in ${backupDir}: check the working tree before continuing`;
      append(ledger, { v: 1, ts: new Date().toISOString(), runId, type: "error", where: "reconcile", message });
      notes.push(message);
    }
    return notes;
  }
}

function append(ledger: Sink, e: RunEvent): void {
  try {
    ledger.append(e);
  } catch {
    // The note still reaches the model; a ledger failure itself cannot be audited.
  }
}
