// Immutable per-transaction snapshots `backups/<id>/` (ruling 12). A directory is created exclusively
// (non-recursive mkdir of the final path), so an existing snapshot is never reused or overwritten.
// `snapshot.json` is written last: a directory without it is an incomplete snapshot and is not listed.
import { randomBytes } from "node:crypto";
import { copyFile, constants, mkdir, open, readdir, rm, stat } from "node:fs/promises";
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

const RESTORABLE = new Set<string>([...STATE_DOCS, MEMORY_DB_FILE, PI_PACKAGES_FILE]);

function targetOf(paths: FactoryPaths, file: string): string {
  return file === MEMORY_DB_FILE ? paths.memoryDb : stateDocPath(paths, file as StateDoc);
}

async function restoreFile(src: string, target: string): Promise<void> {
  const tmp = `${target}.restore-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await copyFile(src, tmp, constants.COPYFILE_EXCL);
    await syncFile(tmp);
    await renameWithRetry(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function restorePiPackages(paths: FactoryPaths, src: string): Promise<void> {
  const saved = await readJson(src);
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    throw new MalformedJson(src, new Error("expected a JSON object"));
  }
  const has = "packages" in saved;
  if (!has && !(await exists(paths.piSettings))) return;
  await withPiSettingsLock(paths.piSettings, async (current) => {
    const next = { ...current };
    if (has) next.packages = (saved as { packages: unknown }).packages;
    else delete next.packages;
    return { next, result: undefined };
  });
}

/**
 * Restores `files` of snapshot `id` byte-for-byte (atomically per file); `pi-packages.json` is written
 * back into Pi settings `packages` under Pi's lock. Every requested file is checked against the
 * snapshot before anything is written.
 */
export async function restoreSnapshot(paths: FactoryPaths, id: string, files: string[]): Promise<void> {
  const dir = snapshotDir(paths, id);
  const info = await readInfo(dir);
  if (info === undefined || info.id !== id) throw new SnapshotNotFound(id, dir);
  for (const file of files) {
    if (!RESTORABLE.has(file)) throw new Error(`${file} is not a restorable snapshot file.`);
    if (!info.files.includes(file)) throw new Error(`Snapshot ${id} has no copy of ${file}.`);
  }
  await mkdir(paths.home, { recursive: true });
  for (const file of files) {
    const src = join(dir, file);
    if (file === PI_PACKAGES_FILE) await restorePiPackages(paths, src);
    else await restoreFile(src, targetOf(paths, file));
  }
}
