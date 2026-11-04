// Answer-route runner reconciliation (Phase 2 Task 11, M §3.1, ruling 5, R38, R39). Before an allowlisted runner
// runs on the answer route, `takeSnapshot` records the work tree; at that call's `tool_result`, `reconcileAfter`
// reverts what changed. Data-safety rule: nothing is deleted or overwritten without a copy (the pre-revert state goes
// to `<backupDir>/after/`), and no git object or ref is created in the user's repository (only read-only git commands
// run; the index file is the only `.git` file written, and only after it is backed up). Reconciliation never follows
// a symlink: entries are examined with lstat, links are copied as links, and a restore below a parent directory that
// became a symlink is refused (R39). Git-ignored outputs are left alone. `<backupDir>/manifest.json` holds everything
// needed to finish the job after an interruption (Task 13: `loadSnapshot` + `reconcileAfter`), and `journal.jsonl`
// the operations a reconcile completed, so a replay never discards preserved `after*` content; both hold hashes, paths
// and metadata, never file contents.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
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
  /** Proven unused but kept (`removeUnused: false`): the caller removes it once the result is audited. */
  unused?: boolean;
  /**
   * Entries that were set aside (their content is in `after*`) but whose backup could not be finished: R39 modes
   * not applied, or a multiply-linked file not replaced by an independent copy. Each names the copy and the reason.
   */
  warnings?: string[];
}

/** The manifest (`<backupDir>/manifest.json`) and the in-memory snapshot are the same object. */
export interface Snapshot {
  v: 1;
  /**
   * `pending` from the snapshot; `reconciling` once `reconcileAfter` started (operations so far are in
   * `journal.jsonl`); `done` with `result` when it finished.
   */
  status: "pending" | "reconciling" | "done";
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
  /** Fix round 1 (Task 13): the call this snapshot belongs to (audited on a replay instead of the directory name). */
  toolCallId?: string;
  /** The running call the snapshotted call was nested in (`ctx.executeTool`), when it was nested. */
  parentToolCallId?: string;
  /**
   * Snapshot order within the run (1, 2, ...): a nested call is always snapshotted after its parent, so a replay in
   * descending order reconciles innermost first. Manifests written before this field fall back to `createdAt`.
   */
  seq?: number;
}

/** What `takeSnapshot` records about the call besides the work tree (fix round 1, Task 13). */
export interface SnapshotMeta {
  toolCallId?: string;
  parentToolCallId?: string;
  seq?: number;
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
export function takeSnapshot(root: string, backupDir: string, limits: SnapshotLimits = UNTRACKED_LIMITS, meta: SnapshotMeta = {}): Snapshot {
  let top: string;
  try {
    top = realpathSync.native(root);
  } catch (e) {
    throw new ReconcileRefusal(`${root} cannot be resolved: ${(e as Error).message}`);
  }
  createBackupDir(backupDir);
  try {
    return withSafeGit((git, gitBytes) => snapshotIn(git, gitBytes, top, backupDir, limits, meta));
  } catch (e) {
    rmSync(backupDir, { recursive: true, force: true });
    if (e instanceof ReconcileRefusal) throw e;
    throw new ReconcileRefusal(`the snapshot failed: ${(e as Error).message}`);
  }
}

function snapshotIn(git: Git, gitBytes: GitBytes, top: string, backupDir: string, limits: SnapshotLimits, meta: SnapshotMeta): Snapshot {
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
    ...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
    ...(meta.parentToolCallId !== undefined ? { parentToolCallId: meta.parentToolCallId } : {}),
    ...(meta.seq !== undefined ? { seq: meta.seq } : {}),
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

/** `<backupDir>/journal.jsonl`: one line per completed operation, so a replay reports and never discards them. */
export const JOURNAL_FILE = "journal.jsonl";

/** One completed reconcile operation (journal line). `aside`: an entry copied or moved into `after*`. */
export interface JournalOp {
  op: "aside" | "moved" | "reverted" | "index";
  path: string;
  /** Absolute location of the copy for `aside` and `moved`. */
  copy?: string;
}

export interface ReconcileOptions {
  /**
   * Default true: a backup directory proven unused (nothing changed, no journal, no `after*` content) is removed.
   * The Reconciler passes false and removes it only once the `reconciled` event is in the ledger.
   */
  removeUnused?: boolean;
  /** Test seam: called after every journaled operation; a throw simulates a crash at that point. */
  onOperation?: (op: JournalOp) => void;
}

/** A throw from `onOperation`: it propagates past every per-entry error handler, like a crash. */
class Interrupted extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super("interrupted");
    this.original = original;
  }
}

function rethrowInterrupt(e: unknown): void {
  if (e instanceof Interrupted) throw e;
}

function readJournal(backupDir: string): JournalOp[] {
  let text: string;
  try {
    text = readFileSync(path.join(backupDir, JOURNAL_FILE), "utf8");
  } catch {
    return [];
  }
  const ops: JournalOp[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      ops.push(JSON.parse(line) as JournalOp);
    } catch {
      // A torn last line from a crash mid-append: the operation is redone or found done.
    }
  }
  return ops;
}

/** True when any `after` or `after-<n>` entry exists in the backup directory (preserved content). */
function hasAfterContent(backupDir: string): boolean {
  try {
    return readdirSync(backupDir).some((n) => n === "after" || /^after-\d+$/.test(n));
  } catch {
    return false;
  }
}

/**
 * R39 for entries moved into `after*` (a rename keeps their modes): directories 0700 and files 0600, descendants
 * included. Symlinks are skipped, never followed. A file whose inode has other hard links (an ignored or external
 * file the runner linked) is never chmodded, which would change that other file too: it is replaced in the backup by
 * an independent 0600 copy (written beside it, renamed over the moved link). Best effort on Windows.
 */
function privatizeTree(p: string): void {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodBestEffort(p, DIR_MODE);
    for (const name of readdirSync(p)) privatizeTree(path.join(p, name));
    return;
  }
  if (!st.isFile()) {
    // A fifo or socket: no content to copy; never chmod a shared inode.
    if (st.nlink <= 1) chmodBestEffort(p, FILE_MODE);
    return;
  }
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    // An owner-unreadable file (EACCES/EPERM) can still have its mode set by path; lstat said it is a regular file.
    // A multiply-linked one is left as it is: it cannot be copied, and chmod would change the other links too.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw e;
    if (st.nlink > 1) throw new Error(`${p} is unreadable and has other hard links: its mode was left unchanged`, { cause: e });
    chmodBestEffort(p, FILE_MODE);
    return;
  }
  let shared: boolean;
  try {
    const now = fstatSync(fd);
    if (!now.isFile()) throw new Error(`${p} changed while its backup mode was set`);
    shared = now.nlink > 1;
    if (!shared) {
      try {
        fchmodSync(fd, FILE_MODE);
      } catch (e) {
        if (!isWin) throw e;
      }
    }
  } finally {
    closeSync(fd);
  }
  if (!shared) return;
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.factory-copy-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    readRegular(p, "sha1", tmp);
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Not created, or already renamed.
    }
    throw e;
  }
}

function chmodBestEffort(p: string, mode: number): void {
  try {
    chmodSync(p, mode);
  } catch (e) {
    if (!isWin) throw e;
  }
}

class Restorer {
  readonly result: ReconcileResult;
  private readonly elsewhere: Record<string, string> = {};
  readonly warnings: string[] = [];
  private readonly s: Snapshot;
  private readonly gitBytes: GitBytes;
  private readonly onOperation: ((op: JournalOp) => void) | undefined;
  journaled = 0;

  constructor(s: Snapshot, gitBytes: GitBytes, onOperation?: (op: JournalOp) => void) {
    this.s = s;
    this.gitBytes = gitBytes;
    this.onOperation = onOperation;
    this.result = { reverted: [], moved: [], notRestored: [], skipped: [...s.skipped], indexRestored: false, backupDir: s.backupDir };
  }

  get elsewhereMap(): Record<string, string> {
    return this.elsewhere;
  }

  /** Appends a completed operation to the journal (before anything else happens). */
  record(op: JournalOp): void {
    writeFileSync(path.join(this.s.backupDir, JOURNAL_FILE), `${JSON.stringify(op)}\n`, { flag: "a", mode: FILE_MODE });
    this.journaled++;
    if (this.onOperation !== undefined) {
      try {
        this.onOperation(op);
      } catch (e) {
        throw new Interrupted(e);
      }
    }
  }

  /** `after/<rel>`, or `after-<n>/<rel>` when that place is taken (the location is recorded). */
  private afterPath(rel: string): string {
    for (let n = 1; n < 1000; n++) {
      const base = path.join(this.s.backupDir, n === 1 ? "after" : `after-${n}`);
      const dst = abs(base, rel);
      let parentsOk = true;
      for (let cur = path.dirname(dst); cur.length > base.length; cur = path.dirname(cur)) {
        const k = kindOf(cur);
        if (k !== "dir" && k !== "missing") {
          parentsOk = false;
          break;
        }
      }
      if (parentsOk && kindOf(dst) === "missing") {
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
    this.record({ op: "aside", path: rel, copy: dst });
  }

  /**
   * Moves the entry at `rel` (file, symlink, directory or other) to `after/`: a rename, or across filesystems a
   * copy (links as links) followed by the removal of the original; either way the moved entries get the R39 modes.
   * An empty directory whose place in `after/` is already a directory (its content was moved there first) is
   * removed. Returns the copy location (undefined when nothing was there or the empty directory was removed).
   */
  moveAside(rel: string, record = true): string | undefined {
    const src = abs(this.s.root, rel);
    const k = kindOf(src);
    if (k === "missing") return undefined;
    if (k === "dir" && readdirSync(src).length === 0) {
      const dst = abs(path.join(this.s.backupDir, "after"), rel);
      if (kindOf(dst) === "dir") {
        rmdirSync(src);
        return undefined;
      }
    }
    const dst = this.afterPath(rel);
    let renamed = false;
    try {
      renameSync(src, dst);
      renamed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    }
    if (renamed) {
      // The entry is in `after*` now, whatever happens next: it is journaled and reported as set aside, with a
      // warning when its backup modes could not be applied (Task 11 minor, carry-forward Task 13).
      try {
        privatizeTree(dst);
      } catch (e) {
        this.warnings.push(`${rel} (set aside to ${dst}, but its backup could not be finished: ${(e as Error).message})`);
      }
    } else {
      copyTree(src, dst);
      rmSync(src, { recursive: true, force: false });
    }
    if (record) this.record({ op: "aside", path: rel, copy: dst });
    return dst;
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
      if (sameState(now, want)) {
        this.result.reverted.push(rel);
        this.record({ op: "reverted", path: rel });
      } else this.result.notRestored.push(`${rel} (it does not match the snapshot after the restore)`);
    } catch (e) {
      rethrowInterrupt(e);
      this.result.notRestored.push(`${rel} (${(e as Error).message})`);
    }
  }

  /** `after/index`, or `after/index-<n>` when a replay already put an index there. */
  private indexAside(): string {
    const dir = path.join(this.s.backupDir, "after");
    mkdirsPrivate(this.s.backupDir, dir);
    for (let n = 1; ; n++) {
      const dst = path.join(dir, n === 1 ? "index" : `index-${n}`);
      if (kindOf(dst) === "missing") return dst;
    }
  }

  /**
   * Restores the index file from `backupDir/index` under `index.lock` (git's own lock protocol), which is taken
   * before the current index is inspected and held through its copy into `after/` and its replacement or removal.
   * A concurrent git command holding the lock wins: the index is then neither inspected nor touched, and reported.
   */
  restoreIndex(): void {
    const s = this.s;
    const lock = `${s.indexFile}.lock`;
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o644);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.result.notRestored.push(
        code === "EEXIST"
          ? `(index) (index not checked: ${lock} exists, held by another git command or left by an interrupted one; the index was neither checked nor restored and the lock was left in place)`
          : `(index) (${(e as Error).message})`,
      );
      return;
    }
    let open = true;
    let renamed = false;
    try {
      const curKind = kindOf(s.indexFile);
      if (curKind !== "missing" && curKind !== "file") throw new Error(`${s.indexFile} is not a regular file`);
      if (!s.indexExisted) {
        if (curKind === "file") {
          const dst = this.indexAside();
          readRegular(s.indexFile, "sha1", dst);
          this.record({ op: "aside", path: "(index)", copy: dst });
          unlinkSync(s.indexFile);
          this.result.indexRestored = true;
          this.record({ op: "index", path: "(index)" });
        }
        return;
      }
      const want = readFileSync(path.join(s.backupDir, "index"));
      if (curKind === "file" && readFileSync(s.indexFile).equals(want)) return;
      if (curKind === "file") {
        const dst = this.indexAside();
        readRegular(s.indexFile, "sha1", dst);
        this.record({ op: "aside", path: "(index)", copy: dst });
      }
      writeAll(fd, want);
      closeSync(fd);
      open = false;
      renameSync(lock, s.indexFile);
      renamed = true;
      this.result.indexRestored = true;
      this.record({ op: "index", path: "(index)" });
    } catch (e) {
      rethrowInterrupt(e);
      this.result.notRestored.push(`(index) (${(e as Error).message})`);
    } finally {
      if (open) {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
      }
      if (!renamed) {
        try {
          unlinkSync(lock);
        } catch {
          // Gone already.
        }
      }
    }
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

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Reverts what changed since `snapshot` in its work tree (`root` must be the snapshot's root): the index is restored
 * under `index.lock`; new untracked non-ignored entries are moved to `after/`; tracked files and pre-existing
 * untracked files whose state changed are copied (or moved) to `after/` and restored from `before/` or from their
 * index blob, each verified against its snapshot hash before it is written and after. A concurrent user edit cannot be
 * told apart from the command's: it is reverted too, with its content kept in `after/`.
 *
 * Replay-safe (Task 13): the manifest says `reconciling` while this runs and every completed operation is journaled
 * (`journal.jsonl`); a replay redoes what is left, reports the journaled operations too, and never removes `after*`
 * content. The backup directory is removed only when it is proven unused (nothing changed in this run, no journal
 * and no `after*` entry) and `removeUnused` is not false. Otherwise the manifest records the result (`done`).
 */
export function reconcileAfter(root: string, snapshot: Snapshot, opts: ReconcileOptions = {}): ReconcileResult {
  const s = snapshot;
  const top = realpathSync.native(root);
  if (top !== s.root) throw new Error(`reconcile root ${top} is not the snapshot root ${s.root}`);
  if (kindOf(s.root) !== "dir") throw new Error(`${s.root} is no longer a directory`);
  const prior = readJournal(s.backupDir);
  s.status = "reconciling";
  saveManifest(s);
  let journaled = 0;
  let result: ReconcileResult;
  try {
    result = withSafeGit((_git, gitBytes) => {
      const r = new Restorer(s, gitBytes, opts.onOperation);
      try {
        reconcilePhases(r, s, gitBytes);
      } finally {
        journaled = r.journaled;
      }
      const elsewhere = r.elsewhereMap;
      return {
        ...r.result,
        ...(Object.keys(elsewhere).length > 0 ? { elsewhere } : {}),
        ...(r.warnings.length > 0 ? { warnings: [...r.warnings] } : {}),
      };
    });
  } catch (e) {
    if (e instanceof Interrupted) throw e.original;
    throw e;
  }

  // Operations completed by an interrupted earlier run are part of this call's result.
  result.reverted = union(prior.filter((o) => o.op === "reverted").map((o) => o.path), result.reverted);
  result.moved = union(prior.filter((o) => o.op === "moved").map((o) => o.path), result.moved);
  if (prior.some((o) => o.op === "index")) result.indexRestored = true;

  const nothing = result.reverted.length === 0 && result.moved.length === 0 && result.notRestored.length === 0 && !result.indexRestored;
  const unused = nothing && prior.length === 0 && journaled === 0 && !hasAfterContent(s.backupDir);
  if (unused && opts.removeUnused !== false) {
    // Every original is in place and unchanged and nothing was ever set aside: the copies are redundant.
    rmSync(s.backupDir, { recursive: true, force: true });
    return { ...result, backupRemoved: true };
  }
  if (unused) result.unused = true;
  s.status = "done";
  s.result = result;
  saveManifest(s);
  return result;
}

function reconcilePhases(r: Restorer, s: Snapshot, gitBytes: GitBytes): void {
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
      const copy = r.moveAside(rel, false);
      r.result.moved.push(rel);
      r.record({ op: "moved", path: rel, ...(copy !== undefined ? { copy } : {}) });
    } catch (e) {
      rethrowInterrupt(e);
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
      rethrowInterrupt(e);
      r.result.notRestored.push(`${t.path} (${(e as Error).message})`);
    }
  }

  // 3. Pre-existing untracked files (R38).
  for (const u of s.untracked) {
    try {
      const cur = stateOf(s.root, u.path, "sha1");
      if (!sameState(cur, u.state)) r.restore(u.path, u.state, cur, true, "");
    } catch (e) {
      rethrowInterrupt(e);
      r.result.notRestored.push(`${u.path} (${(e as Error).message})`);
    }
  }
}

// --- Note and enforce wiring ------------------------------------------------------------------------------------

/** Paths per content block when a result names many files (every path is named; there is no cap). */
export const NOTE_PATHS_PER_BLOCK = 500;

/**
 * The note appended to the tool result, as one or more text blocks; empty when there is nothing to tell. Every
 * affected path is named: a short result is one block, a long one a summary block followed by blocks of at most
 * `NOTE_PATHS_PER_BLOCK` paths.
 */
export function reconcileNotes(r: ReconcileResult): string[] {
  const sections: Array<[string, string[]]> = [];
  if (r.reverted.length > 0) sections.push(["reverted", r.reverted]);
  if (r.moved.length > 0) sections.push(["moved aside (new files)", r.moved]);
  if (r.notRestored.length > 0) sections.push(["not restored (check these before continuing):", r.notRestored]);
  if (r.skipped.length > 0) sections.push(["not reconciled (skipped):", r.skipped]);
  if (r.warnings !== undefined && r.warnings.length > 0) sections.push(["set aside with an incomplete backup:", r.warnings]);
  const flags = r.indexRestored ? ["index restored"] : [];
  if (sections.length === 0 && flags.length === 0) return [];
  const removed = r.backupRemoved === true;
  const head = removed ? "Answer-route reconciliation: nothing to revert" : `Reverted on the answer route (copies in ${r.backupDir})`;
  const sep = removed ? "; " : ": ";
  const total = sections.reduce((n, [, ps]) => n + ps.length, 0);
  if (total <= NOTE_PATHS_PER_BLOCK) {
    return [`${head}${sep}${[...sections.map(([label, ps]) => `${label} ${ps.join(", ")}`), ...flags].join("; ")}`];
  }
  const blocks = [`${head}${sep}${[...sections.map(([label, ps]) => `${label} ${ps.length} path(s)`), ...flags].join("; ")}; every path follows`];
  for (const [label, ps] of sections) {
    for (let i = 0; i < ps.length; i += NOTE_PATHS_PER_BLOCK) {
      blocks.push(`${label}${i > 0 ? " (continued)" : ""} ${ps.slice(i, i + NOTE_PATHS_PER_BLOCK).join(", ")}`);
    }
  }
  return blocks;
}

/** The note as one string (blocks joined by newlines); undefined when there is nothing to tell. */
export function reconcileNote(r: ReconcileResult): string | undefined {
  const blocks = reconcileNotes(r);
  return blocks.length === 0 ? undefined : blocks.join("\n");
}

interface Sink {
  append(e: RunEvent): void;
}

/** Where a reconcile problem the model also sees is reported to the person (UI notification or stderr). */
export type Diagnose = (message: string) => void;

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
  /** Snapshot order of this run, persisted in each manifest (`seq`) for a startup replay. */
  private seq = 0;

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
    const snapshot = takeSnapshot(root, this.dirFor(toolCallId), UNTRACKED_LIMITS, {
      toolCallId,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      seq: ++this.seq,
    });
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

  /** Reconciles the call (after its nested calls) and appends the note blocks to its result; undefined when there is nothing to add. */
  finish(ev: ResultLike, ledger: Sink, runId: string, diagnose?: Diagnose): { content: Content; structuredContent?: ToolResultEvent["structuredContent"] } | undefined {
    const notes = this.finishTree(ev.toolCallId, ledger, runId, diagnose);
    if (notes.length === 0) return undefined;
    const content: Content = [...ev.content, ...notes.map((n) => ({ type: "text" as const, text: `\n[factory] ${n}` }))];
    return { content, ...(ev.structuredContent !== undefined ? { structuredContent: ev.structuredContent } : {}) };
  }

  /** Reconciles a call that ended without a result the extension can amend (problems go to `diagnose`). */
  finishId(toolCallId: string, ledger: Sink, runId: string, diagnose?: Diagnose): void {
    this.finishTree(toolCallId, ledger, runId, diagnose);
  }

  /** Backstop: every pending call, latest first. */
  finishAll(ledger: Sink, runId: string, diagnose?: Diagnose): void {
    for (const id of [...this.pending.keys()].reverse()) this.finishTree(id, ledger, runId, diagnose);
  }

  private finishTree(toolCallId: string, ledger: Sink, runId: string, diagnose: Diagnose | undefined): string[] {
    const notes: string[] = [];
    const children = [...this.pending.entries()].filter(([, p]) => p.parent === toolCallId).map(([id]) => id);
    for (const id of children.reverse()) notes.push(...this.finishTree(id, ledger, runId, diagnose));
    const p = this.pending.get(toolCallId);
    if (p === undefined) return notes;
    this.pending.delete(toolCallId);
    notes.push(...reconcileAudited(toolCallId, p.snapshot, ledger, runId, diagnose));
    return notes;
  }
}

/**
 * Reconciles `snapshot` (kept on disk: `removeUnused: false`), audits the result as a `reconciled` event and returns
 * the note blocks. A backup proven unused is removed only once that event is in the ledger; a failed reconcile or
 * audit keeps everything and is reported (notes and `diagnose`).
 */
function reconcileAudited(toolCallId: string, snapshot: Snapshot, ledger: Sink, runId: string, diagnose: Diagnose | undefined): string[] {
  const notes: string[] = [];
  const backupDir = snapshot.backupDir;
  const auditFailed = (what: string, error: string) => {
    const message = `the ${what} for answer-route call ${toolCallId} could not be written to the run ledger (${error}); the snapshot, manifest and copies are kept in ${backupDir}`;
    notes.push(message);
    diagnose?.(`factory: ${message}`);
  };
  let r: ReconcileResult;
  try {
    r = reconcileAfter(snapshot.root, snapshot, { removeUnused: false });
  } catch (e) {
    const message = `reconciliation of answer-route call ${toolCallId} failed (${(e as Error).message}); the snapshot and copies are in ${backupDir}: check the working tree before continuing`;
    notes.push(message);
    diagnose?.(`factory: ${message}`);
    const err = append(ledger, { v: 1, ts: new Date().toISOString(), runId, type: "error", where: "reconcile", message });
    if (err !== undefined) auditFailed("error event", err);
    return notes;
  }
  const remove = r.unused === true;
  const err = append(ledger, {
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
    ...(r.warnings !== undefined && r.warnings.length > 0 ? { warnings: r.warnings } : {}),
    ...(r.indexRestored ? { indexRestored: true } : {}),
    ...(remove ? { backupRemoved: true } : {}),
  });
  if (err === undefined && remove) {
    // The audit says the backup was redundant; only now is it removed.
    rmSync(backupDir, { recursive: true, force: true });
    r = { ...r, backupRemoved: true };
  }
  notes.push(...reconcileNotes(r));
  if (err !== undefined) auditFailed("reconciled event", err);
  return notes;
}

/** What a startup replay did with one `reconcile/<name>` directory of an interrupted run. */
export interface ReplayOutcome {
  dir: string;
  /** `replayed`: a pending or reconciling manifest was finished; `removed`: an interrupted snapshot without manifest. */
  kind: "replayed" | "removed" | "kept";
  notes: string[];
}

/**
 * Task 13: finishes the answer-route reconciliations an interrupted run (SIGKILL, crash) left in `<runDir>/reconcile/`.
 * A manifest with status `pending` (the runner may have run; nothing was reverted yet) or `reconciling` (a reconcile
 * was cut short; `journal.jsonl` holds its completed operations, which the result includes) is finished with
 * `loadSnapshot` + `reconcileAfter` and audited in `ledger` under `runId` (the run that replays it). `after*` content
 * is never removed. A directory without a manifest is a snapshot that never completed, so its runner never ran: it is
 * removed, unless it holds a journal or `after*` content (then it is kept and reported). `done` manifests are left.
 * A stale `index.lock` (from a git command, or from a reconcile killed while it held the lock) is reported as "index
 * not checked" and never removed.
 *
 * Fix round 1: the manifests are replayed in reverse snapshot order (`seq`, descending), which is innermost first as in
 * `Reconciler.finishTree`; directory names never decide the order. Manifests written before `seq` existed are ordered
 * by `createdAt` (then the manifest's mtime), newest first. Only a missing `reconcile/` directory means "nothing to
 * do": any other failure to list it or an entry is reported (notes, `diagnose`, a ledger `error` event) and the
 * content is left for a retry. Call it only while holding the run's replay claim (`ledger.claimReplay`).
 */
export function replayInterrupted(runDir: string, ledger: Sink, runId: string, diagnose?: Diagnose): ReplayOutcome[] {
  const base = path.join(runDir, "reconcile");
  const out: ReplayOutcome[] = [];
  const failed = (dir: string, message: string): void => {
    diagnose?.(`factory: ${message}`);
    const err = append(ledger, { v: 1, ts: new Date().toISOString(), runId, type: "error", where: "reconcile-replay", message });
    out.push({ dir, kind: "kept", notes: [err === undefined ? message : `${message} (the error could not be written to the run ledger: ${err})`] });
  };
  let names: string[];
  try {
    names = readdirSync(base).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    failed(base, `the reconcile directory ${base} cannot be read (${(e as Error).message}): its answer-route reconciles were kept for a retry at a later startup; check the working tree before continuing`);
    return out;
  }
  const pending: Array<{ name: string; snapshot: Snapshot; mtime: number }> = [];
  for (const name of names) {
    const dir = path.join(base, name);
    try {
      if (kindOf(dir) !== "dir") continue;
      const manifest = path.join(dir, MANIFEST_FILE);
      if (kindOf(manifest) === "missing") {
        if (kindOf(path.join(dir, JOURNAL_FILE)) === "missing" && !hasAfterContent(dir)) {
          rmSync(dir, { recursive: true, force: true });
          out.push({ dir, kind: "removed", notes: [] });
        } else {
          const message = `${dir} holds reconcile copies but no manifest: it was kept; check it before continuing`;
          diagnose?.(`factory: ${message}`);
          out.push({ dir, kind: "kept", notes: [message] });
        }
        continue;
      }
      let snapshot: Snapshot;
      try {
        snapshot = loadSnapshot(dir);
      } catch (e) {
        failed(dir, `the reconcile manifest in ${dir} cannot be read (${(e as Error).message}): it was kept; check the working tree before continuing`);
        continue;
      }
      if (snapshot.status !== "pending" && snapshot.status !== "reconciling") continue;
      pending.push({ name, snapshot, mtime: lstatSync(manifest).mtimeMs });
    } catch (e) {
      failed(dir, `${dir} cannot be examined (${(e as Error).message}): it was kept for a retry at a later startup; check the working tree before continuing`);
    }
  }
  pending.sort(replayOrder);
  for (const p of pending) {
    out.push({ dir: p.snapshot.backupDir, kind: "replayed", notes: reconcileAudited(p.snapshot.toolCallId ?? p.name, p.snapshot, ledger, runId, diagnose) });
  }
  return out;
}

/** Reverse snapshot order: `seq` when both have one, else `createdAt` (then manifest mtime, then name), newest first. */
function replayOrder(a: { name: string; snapshot: Snapshot; mtime: number }, b: { name: string; snapshot: Snapshot; mtime: number }): number {
  const sa = a.snapshot.seq;
  const sb = b.snapshot.seq;
  if (typeof sa === "number" && typeof sb === "number" && sa !== sb) return sb - sa;
  const time = (x: typeof a) => {
    const t = Date.parse(x.snapshot.createdAt);
    return Number.isNaN(t) ? x.mtime : t;
  };
  const ta = time(a);
  const tb = time(b);
  if (ta !== tb) return tb - ta;
  if (a.mtime !== b.mtime) return b.mtime - a.mtime;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/** Appends the event; the error message when the ledger refused it. */
function append(ledger: Sink, e: RunEvent): string | undefined {
  try {
    ledger.append(e);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}
