// Per-key ownership of Pi settings: the factory only ever changes a key it wrote itself and that the user
// has not touched since. Pure: callers supply the current settings and persist the results.
import { z } from "zod";

export const ManagedRecord = z.looseObject({
  schema: z.literal(1),
  keys: z.record(
    z.string(),
    z.looseObject({ value: z.unknown(), writtenAt: z.string(), factoryVersion: z.string() }),
  ),
});
export type ManagedRecord = z.infer<typeof ManagedRecord>;

export const DESIRED_PI_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
  enableInstallTelemetry: false,
  transport: "sse",
});

export type SettingAction = "set" | "updated" | "unchanged" | "kept-user-value" | "kept-foreign-value" | "released";
export interface SettingChange {
  key: string;
  action: SettingAction;
}

export interface PlanContext {
  now: string;
  factoryVersion: string;
}

/** Structural equality for JSON values (object key order is irrelevant). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k]));
}

export function planManagedSettings(
  current: Readonly<Record<string, unknown>>,
  record: ManagedRecord,
  desired: Readonly<Record<string, unknown>>,
  ctx: PlanContext,
): { next: Record<string, unknown>; record: ManagedRecord; changes: SettingChange[] } {
  const next: Record<string, unknown> = { ...current };
  const keys: ManagedRecord["keys"] = { ...record.keys };
  const changes: SettingChange[] = [];
  const stamp = (key: string, value: unknown) => ({
    ...(Object.hasOwn(record.keys, key) ? record.keys[key] : {}),
    value,
    writtenAt: ctx.now,
    factoryVersion: ctx.factoryVersion,
  });

  const all = new Set([...Object.keys(desired), ...Object.keys(record.keys)]);
  for (const key of all) {
    const recorded = Object.hasOwn(record.keys, key) ? record.keys[key] : undefined;
    const present = Object.hasOwn(current, key);
    const wanted = Object.hasOwn(desired, key);

    if (!recorded) {
      if (!wanted) continue;
      if (present) {
        changes.push({ key, action: "kept-foreign-value" });
      } else {
        next[key] = desired[key];
        keys[key] = stamp(key, desired[key]);
        changes.push({ key, action: "set" });
      }
      continue;
    }

    const untouched = present && jsonEqual(current[key], recorded.value);
    if (!untouched) {
      changes.push({ key, action: "kept-user-value" });
    } else if (!wanted) {
      delete next[key];
      delete keys[key];
      changes.push({ key, action: "released" });
    } else if (jsonEqual(desired[key], recorded.value)) {
      changes.push({ key, action: "unchanged" });
    } else {
      next[key] = desired[key];
      keys[key] = stamp(key, desired[key]);
      changes.push({ key, action: "updated" });
    }
  }
  return { next, record: { ...record, keys }, changes };
}
