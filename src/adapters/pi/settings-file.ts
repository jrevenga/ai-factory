// Host-side access to Pi's settings.json under Pi's own lock protocol (proper-lockfile on the file path,
// realpath: false, as Pi 1.4.0's settings-manager does), so factory writes never race Pi's own.
import lockfile from "proper-lockfile";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { MalformedJson, readJson, writeJsonAtomic } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";
import {
  DESIRED_PI_SETTINGS,
  ManagedRecord,
  planManagedSettings,
  type SettingChange,
} from "../../core/settings/managed.ts";

export class SettingsLocked extends Error {
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    super(`Pi settings file ${path} is locked by another process. Close other Pi sessions or commands and retry.`, { cause });
    this.name = "SettingsLocked";
    this.path = path;
  }
}

function asObject(path: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedJson(path, new Error("expected a JSON object"));
  }
  return value as Record<string, unknown>;
}

export async function readPiSettings(path: string): Promise<Record<string, unknown>> {
  return asObject(path, await readJson(path));
}

/** Creates `{}` if missing; exclusive so a concurrent creator (Pi) is never overwritten. */
async function ensureFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const h = await open(path, "wx");
    try {
      await h.writeFile("{}\n", "utf8");
    } finally {
      await h.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

export interface LockDeps {
  lock: (path: string, options: lockfile.LockOptions) => Promise<() => Promise<void>>;
}

export async function withPiSettingsLock<T>(
  settingsPath: string,
  fn: (current: Record<string, unknown>) => Promise<{ next?: Record<string, unknown>; result: T }>,
  deps: LockDeps = { lock: lockfile.lock },
): Promise<T> {
  await ensureFile(settingsPath);
  let release: () => Promise<void>;
  try {
    release = await deps.lock(settingsPath, {
      realpath: false,
      retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOCKED") throw new SettingsLocked(settingsPath, e);
    throw e;
  }
  let result: T;
  try {
    const current = await readPiSettings(settingsPath);
    const out = await fn(current);
    if (out.next !== undefined) await writeJsonAtomic(settingsPath, out.next);
    result = out.result;
  } catch (opError) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError([opError, releaseError], "Pi settings operation failed and the lock could not be released");
    }
    throw opError;
  }
  await release();
  return result;
}

async function readRecord(path: string): Promise<ManagedRecord> {
  const raw = await readJson(path);
  if (raw === undefined) return { schema: 1, keys: {} };
  const parsed = ManagedRecord.safeParse(raw);
  if (!parsed.success) throw new MalformedJson(path, new Error(parsed.error.message));
  return parsed.data;
}

/**
 * Applies DESIRED_PI_SETTINGS per key. Reading the ownership record, writing Pi's settings and then the
 * record all happen inside one Pi lock critical section, so concurrent callers cannot lose ownership.
 */
export async function applyManagedPiSettings(paths: FactoryPaths, factoryVersion: string): Promise<SettingChange[]> {
  return withPiSettingsLock(paths.piSettings, async (current) => {
    const record = await readRecord(paths.managedSettings);
    const plan = planManagedSettings(current, record, DESIRED_PI_SETTINGS, {
      now: new Date().toISOString(),
      factoryVersion,
    });
    const changed = plan.changes.some((c) => c.action === "set" || c.action === "updated" || c.action === "released");
    // Settings first, then the record: a failure in between leaves keys unrecorded (foreign), never clobbered.
    if (changed) await writeJsonAtomic(paths.piSettings, plan.next);
    await mkdir(dirname(paths.managedSettings), { recursive: true });
    await writeJsonAtomic(paths.managedSettings, plan.record);
    return { result: plan.changes };
  });
}
