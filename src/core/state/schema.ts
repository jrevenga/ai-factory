// Persisted factory documents (ruling 11): readers use z.looseObject so additive fields from newer
// versions are accepted and preserved when a document is rewritten. Enum-like fields accept values a
// newer release may add (ruling R13); writers still use the known values.
import { z } from "zod";
import { STATE_DOCS } from "../release/manifest.ts";

export type StateDoc = (typeof STATE_DOCS)[number];

export const HISTORY_REASONS = ["install", "update", "rollback"] as const;
export const HistoryReason = z.enum(HISTORY_REASONS);

/** Known values first (for editors), any other string accepted (R13). */
const openEnum = <T extends readonly [string, ...string[]]>(values: T) => z.union([z.enum(values), z.string()]);

/** `~/.factory/state.json`, written by `_apply-release` as the last step of a transaction. */
export const FactoryState = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  installedAt: z.string(),
  source: z.string(),
  piVersion: z.string(),
  piCli: z.string(),
  history: z.array(z.looseObject({ version: z.string(), at: z.string(), reason: openEnum(HISTORY_REASONS) })),
});
export type FactoryState = z.infer<typeof FactoryState>;

export const TXN_KINDS = ["update", "rollback"] as const;
export const TxnKind = z.enum(TXN_KINDS);
/** The kinds this release writes; readers accept any string (a journal of an unknown kind still needs recovery). */
export type TxnKind = z.infer<typeof TxnKind>;

/** `backups/<id>/snapshot.json` (ruling 12). `files` lists the file names stored next to it. */
export const SnapshotInfo = z.looseObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: openEnum(TXN_KINDS),
  at: z.string(),
  files: z.array(z.string()),
});
export type SnapshotInfo = z.infer<typeof SnapshotInfo>;

/** `~/.factory/txn.json`, the journal of the transaction in progress (ruling 12). */
export const TxnRecord = z.looseObject({
  id: z.string(),
  kind: openEnum(TXN_KINDS),
  from: z.string(),
  to: z.string(),
  snapshot: z.string(),
  startedAt: z.string(),
});
export type TxnRecord = z.infer<typeof TxnRecord>;

/** The integer `schema` field of a persisted document, or undefined when it has none. */
export function schemaOf(doc: unknown): number | undefined {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const s = (doc as { schema?: unknown }).schema;
  return typeof s === "number" && Number.isInteger(s) ? s : undefined;
}
