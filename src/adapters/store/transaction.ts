// The transaction journal `<home>/txn.json` (ruling 12): written before any mutation of an update or
// rollback, removed by `_apply-release` only after `state.json` is written. Its presence means a
// transaction did not finish and must be recovered from its snapshot.
import { mkdir, open, rm } from "node:fs/promises";
import { TxnRecord, type TxnKind } from "../../core/state/schema.ts";
import { MalformedJson, readJson } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";

export class TxnPending extends Error {
  readonly path: string;
  /** The pending journal, or undefined if it could not be read. */
  readonly existing: TxnRecord | undefined;
  constructor(path: string, existing: TxnRecord | undefined) {
    super(
      existing
        ? `An unfinished ${existing.kind} ${existing.from} → ${existing.to} is recorded in ${path}. Run \`factory rollback\` to recover it first.`
        : `An unfinished transaction is recorded in ${path}. Run \`factory rollback\` to recover it first.`,
    );
    this.name = "TxnPending";
    this.path = path;
    this.existing = existing;
  }
}

export interface BeginTxn {
  id: string;
  kind: TxnKind;
  from: string;
  to: string;
  snapshot: string;
  now?: Date;
}

export async function readTxn(paths: FactoryPaths): Promise<TxnRecord | undefined> {
  const raw = await readJson(paths.txn);
  if (raw === undefined) return undefined;
  const parsed = TxnRecord.safeParse(raw);
  if (!parsed.success) throw new MalformedJson(paths.txn, new Error(parsed.error.message));
  return parsed.data;
}

/** Creates the journal exclusively (`wx`) and flushes it; throws TxnPending if one already exists. */
export async function beginTxn(paths: FactoryPaths, t: BeginTxn): Promise<void> {
  const record = TxnRecord.parse({
    id: t.id,
    kind: t.kind,
    from: t.from,
    to: t.to,
    snapshot: t.snapshot,
    startedAt: (t.now ?? new Date()).toISOString(),
  });
  await mkdir(paths.home, { recursive: true });
  let handle;
  try {
    handle = await open(paths.txn, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let existing: TxnRecord | undefined;
    try {
      existing = await readTxn(paths);
    } catch {
      existing = undefined;
    }
    throw new TxnPending(paths.txn, existing);
  }
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (e) {
    await handle.close();
    await rm(paths.txn, { force: true });
    throw e;
  }
  await handle.close();
}

/** The journal belongs to another transaction than the one trying to clear it (R17). */
export class TxnMismatch extends Error {
  readonly path: string;
  constructor(path: string, expected: string, found: string) {
    super(`The journal ${path} records transaction ${found}, not ${expected}; it belongs to another factory process and was left in place`);
    this.name = "TxnMismatch";
    this.path = path;
  }
}

/**
 * Removes the journal of transaction `id` (the one this process started or adopted). An absent journal
 * is fine; a journal of another transaction is never removed (TxnMismatch).
 */
export async function clearTxn(paths: FactoryPaths, id: string): Promise<void> {
  const current = await readTxn(paths);
  if (current === undefined) return;
  if (current.id !== id) throw new TxnMismatch(paths.txn, id, current.id);
  await rm(paths.txn, { force: true });
}
