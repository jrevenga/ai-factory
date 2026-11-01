// Immutable per-transaction snapshots `backups/<id>/` (ruling 12). A directory is created exclusively
// (non-recursive mkdir of the final path), so an existing snapshot is never reused or overwritten.
// `snapshot.json` is written last: a directory without it is an incomplete snapshot and is not listed.
import { randomBytes } from "node:crypto";
import { copyFile, constants, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DOCS } from "../../core/release/manifest.ts";
import { SnapshotInfo, type StateDoc, type TxnKind } from "../../core/state/schema.ts";
import { withPiSettingsLock } from "../pi/settings-file.ts";
import { MalformedJson, readJson, renameWithRetry, writeJsonAtomic } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";
import { stateDocPath } from "./state-store.ts";

export const SNAPSHOT_FILE = "snapshot.json";
export const MEMORY_DB_FILE = "memory.db";
/** `{ packages?: unknown }`: Pi settings `packages` at snapshot time; no key means Pi had none. */
export const PI_PACKAGES_FILE = "pi-packages.json";

export class SnapshotExists extends Error {
  readonly id: string;
  readonly dir: string;
  constructor(id: string, dir: string) {
    super(`Snapshot ${id} already exists at ${dir}; snapshots are never overwritten. Retry in a second.`);
    this.name = "SnapshotExists";
    this.id = id;
    this.dir = dir;
  }
}

export class SnapshotNotFound extends Error {
  readonly id: string;
  constructor(id: string, dir: string) {
    super(`Snapshot ${id} not found or incomplete (no ${SNAPSHOT_FILE} in ${dir}).`);
    this.name = "SnapshotNotFound";
    this.id = id;
  }
}

function isSafeComponent(s: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(s) && !s.includes("..");
}

/** `<UTC yyyymmddThhmmssZ>-<from>-to-<to>`. Versions must be safe single path components. */
export function snapshotId(now: Date, from: string, to: string): string {
  for (const v of [from, to]) {
    if (!isSafeComponent(v)) throw new Error(`Version ${JSON.stringify(v)} cannot be used in a snapshot directory name.`);
  }
  const stamp = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  return `${stamp}-${from}-to-${to}`;
}

export function snapshotDir(paths: FactoryPaths, id: string): string {
  if (!isSafeComponent(id)) throw new Error(`Invalid snapshot id ${JSON.stringify(id)}.`);
  return join(paths.backups, id);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function syncFile(path: string): Promise<void> {
  const h = await open(path, "r+");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

/** Copies `src` into a new file `dst` and flushes it; false when `src` does not exist. */
async function copyIfPresent(src: string, dst: string): Promise<boolean> {
  try {
    await copyFile(src, dst, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !(await exists(src))) return false;
    throw e;
  }
  await syncFile(dst);
  return true;
}

async function readPiPackages(paths: FactoryPaths): Promise<{ packages?: unknown }> {
  if (!(await exists(paths.piSettings))) return {};
  const settings = await withPiSettingsLock(paths.piSettings, async (current) => ({ result: current }));
  return "packages" in settings ? { packages: settings.packages } : {};
}

export interface CreateSnapshotInput {
  from: string;
  to: string;
  kind: TxnKind;
  now: Date;
}

export async function createSnapshot(paths: FactoryPaths, input: CreateSnapshotInput): Promise<SnapshotInfo> {
  const id = snapshotId(input.now, input.from, input.to);
  const dir = join(paths.backups, id);
  await mkdir(paths.backups, { recursive: true });
  try {
    await mkdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SnapshotExists(id, dir);
    throw e;
  }
  try {
    const files: string[] = [];
    for (const doc of STATE_DOCS) {
      if (await copyIfPresent(stateDocPath(paths, doc), join(dir, doc))) files.push(doc);
    }
    if (await copyIfPresent(paths.memoryDb, join(dir, MEMORY_DB_FILE))) files.push(MEMORY_DB_FILE);
    await writeJsonAtomic(join(dir, PI_PACKAGES_FILE), await readPiPackages(paths));
    files.push(PI_PACKAGES_FILE);
    const info: SnapshotInfo = { id, from: input.from, to: input.to, kind: input.kind, at: input.now.toISOString(), files };
    await writeJsonAtomic(join(dir, SNAPSHOT_FILE), info);
    return info;
  } catch (e) {
    await rm(dir, { recursive: true, force: true }); // ours, just created and incomplete
    throw e;
  }
}

async function readInfo(dir: string): Promise<SnapshotInfo | undefined> {
  let raw: unknown;
  try {
    raw = await readJson(join(dir, SNAPSHOT_FILE));
  } catch (e) {
    if (e instanceof MalformedJson) return undefined;
    throw e;
  }
  const parsed = SnapshotInfo.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Complete snapshots, newest first. Directories without a valid `snapshot.json` are skipped. */
export async function listSnapshots(paths: FactoryPaths): Promise<SnapshotInfo[]> {
  let entries;
  try {
    entries = await readdir(paths.backups, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SnapshotInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await readInfo(join(paths.backups, entry.name));
    if (info !== undefined && info.id === entry.name) out.push(info);
  }
  return out.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at < a.at ? -1 : 1));
}

/** Files restoreSnapshot accepts. `pi-packages.json` is snapshotted but never restored: the target
 * release's `_apply-release` reinstalls its own package (ruling 10). */
export const RESTORABLE: readonly string[] = [...STATE_DOCS, MEMORY_DB_FILE];

function targetOf(paths: FactoryPaths, file: string): string {
  return file === MEMORY_DB_FILE ? paths.memoryDb : stateDocPath(paths, file as StateDoc);
}

export class SnapshotFileMissing extends Error {
  readonly id: string;
  readonly file: string;
  constructor(id: string, file: string, detail: string) {
    super(`Snapshot ${id} cannot restore ${file}: ${detail}`);
    this.name = "SnapshotFileMissing";
    this.id = id;
    this.file = file;
  }
}

/** Copies `src` next to `target` as a flushed temporary file and returns its path; validates JSON documents unless `verbatim`. */
async function stage(id: string, file: string, src: string, target: string, verbatim: boolean): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(src);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new SnapshotFileMissing(id, file, `${src} is missing`);
    throw e;
  }
  if (!verbatim && file !== MEMORY_DB_FILE) {
    const text = bytes.toString("utf8");
    try {
      JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (e) {
      throw new MalformedJson(src, e);
    }
  }
  const tmp = `${target}.restore-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(tmp, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (e) {
    await handle.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await handle.close();
  return tmp;
}

/**
 * Restores `files` of snapshot `id` byte-for-byte. All-or-nothing up front: every requested file is
 * checked against the snapshot, read, validated (JSON documents must parse, unless `verbatim`) and
 * staged as a flushed temporary file next to its destination before any destination is replaced; only
 * then is each staged file renamed over its destination. Accepts only RESTORABLE files.
 *
 * `verbatim` is for recovering a journal: the snapshot is exactly what existed before the transaction,
 * so it is restored as it is, even a document no reader accepts (validation belongs in the preflight).
 */
export async function restoreSnapshot(paths: FactoryPaths, id: string, files: string[], opts: { verbatim?: boolean } = {}): Promise<void> {
  const dir = snapshotDir(paths, id);
  const info = await readInfo(dir);
  if (info === undefined || info.id !== id) throw new SnapshotNotFound(id, dir);
  for (const file of files) {
    if (!RESTORABLE.includes(file)) throw new Error(`${file} is not a restorable snapshot file.`);
    if (!info.files.includes(file)) throw new SnapshotFileMissing(id, file, "the snapshot has no copy of it");
  }
  await mkdir(paths.home, { recursive: true });
  const staged: { tmp: string; target: string }[] = [];
  try {
    for (const file of files) {
      const target = targetOf(paths, file);
      staged.push({ tmp: await stage(id, file, join(dir, file), target, opts.verbatim === true), target });
    }
    while (staged.length > 0) {
      const next = staged[0] as { tmp: string; target: string };
      await renameWithRetry(next.tmp, next.target);
      staged.shift();
    }
  } finally {
    for (const s of staged) await rm(s.tmp, { force: true });
  }
}
