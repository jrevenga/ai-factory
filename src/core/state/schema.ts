// Persisted factory documents (ruling 11): readers use z.looseObject so additive fields from newer
// versions are accepted and preserved when a document is rewritten.
import { z } from "zod";
import { STATE_DOCS } from "../release/manifest.ts";

export type StateDoc = (typeof STATE_DOCS)[number];

export const HistoryReason = z.enum(["install", "update", "rollback"]);

/** `~/.factory/state.json`, written by `_apply-release` as the last step of a transaction. */
export const FactoryState = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  installedAt: z.string(),
  source: z.string(),
  piVersion: z.string(),
  piCli: z.string(),
  history: z.array(z.looseObject({ version: z.string(), at: z.string(), reason: HistoryReason })),
});
export type FactoryState = z.infer<typeof FactoryState>;

export const TxnKind = z.enum(["update", "rollback"]);
export type TxnKind = z.infer<typeof TxnKind>;

/** `backups/<id>/snapshot.json` (ruling 12). `files` lists the file names stored next to it. */
export const SnapshotInfo = z.looseObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: TxnKind,
  at: z.string(),
  files: z.array(z.string()),
});
export type SnapshotInfo = z.infer<typeof SnapshotInfo>;

/** `~/.factory/txn.json`, the journal of the transaction in progress (ruling 12). */
export const TxnRecord = z.looseObject({
  id: z.string(),
  kind: TxnKind,
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
