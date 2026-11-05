// Per-document schema migrations (ruling 11). A document's integer `schema` changes only on a breaking
// change; each migration moves one document from one schema to a strictly greater one.
import { STATE_DOCS } from "../release/manifest.ts";
import type { StateDoc } from "./schema.ts";

export interface Migration {
  id: string;
  doc: StateDoc;
  from: number;
  to: number;
  up(doc: unknown): unknown;
}

/** Registered migrations. Empty in 0.1.0: every document is at schema 1. */
export const MIGRATIONS: Migration[] = [];

export class NoMigrationPath extends Error {
  readonly doc: StateDoc;
  readonly from: number;
  readonly to: number;
  constructor(doc: StateDoc, from: number, to: number) {
    super(`No migration path for ${doc} from schema ${from} to schema ${to}.`);
    this.name = "NoMigrationPath";
    this.doc = doc;
    this.from = from;
    this.to = to;
  }
}

export class InvalidMigration extends Error {
  readonly id: string;
  constructor(id: string, reason: string) {
    super(`Invalid migration ${id}: ${reason}`);
    this.name = "InvalidMigration";
    this.id = id;
  }
}

function validateRegistry(registry: readonly Migration[]): void {
  const ids = new Set<string>();
  for (const m of registry) {
    if (ids.has(m.id)) throw new InvalidMigration(m.id, "duplicate id");
    ids.add(m.id);
    if (!Number.isInteger(m.from) || !Number.isInteger(m.to)) throw new InvalidMigration(m.id, "schemas must be integers");
    if (m.to <= m.from) throw new InvalidMigration(m.id, `to (${m.to}) must be greater than from (${m.from})`);
  }
}

/** Shortest chain of `doc` migrations from `from` to exactly `to` that never passes `to`; undefined if none. */
function findPath(doc: StateDoc, from: number, to: number, registry: readonly Migration[]): Migration[] | undefined {
  const steps = registry.filter((m) => m.doc === doc && m.to <= to);
  const via = new Map<number, Migration[]>([[from, []]]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift() as number;
    const path = via.get(at) as Migration[];
    if (at === to) return path;
    for (const m of steps) {
      if (m.from !== at || via.has(m.to)) continue;
      via.set(m.to, [...path, m]);
      queue.push(m.to);
    }
  }
  return undefined;
}

/**
 * The migrations that bring each present document to its target schema, grouped per document in
 * STATE_DOCS order and in application order within a document. Absent documents and documents already
 * at their target need none. A document newer than its target has no forward path (that is a rollback).
 */
export function planMigrations(
  current: Partial<Record<StateDoc, number>>,
  registry: readonly Migration[],
  targets: Record<StateDoc, number>,
): Migration[] {
  validateRegistry(registry);
  const plan: Migration[] = [];
  for (const doc of STATE_DOCS) {
    const from = current[doc];
    const to = targets[doc];
    if (from === undefined || from === to) continue;
    const path = from < to ? findPath(doc, from, to, registry) : undefined;
    if (path === undefined) throw new NoMigrationPath(doc, from, to);
    plan.push(...path);
  }
  return plan;
}
