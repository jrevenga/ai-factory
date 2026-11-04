// `factory rollback`: returns to an earlier release. This (newer) CLI snapshots and restores state first,
// then installs the older CLI and lets it apply itself, so older releases need no rollback knowledge
// (ruling 10). Only documents whose schema is newer than the target supports are restored (ruling 11).
//
// Recovery mode: a journal left by an unfinished update/rollback is recovered exactly — target is the
// version it left, and every restorable file of its snapshot is restored (ruling 12). That snapshot is
// never written to: a new rollback snapshot of the current (half-applied) state is taken first, labelled
// as leaving the version the unfinished transaction was moving to (`txn.to`), which is also recorded as
// `from` in history; it is never labelled as leaving `txn.from`, because it may hold newer-schema documents.
import { join } from "node:path";
import { MalformedJson, readJson } from "../../adapters/platform/json-file.ts";
import type { FactoryPaths } from "../../adapters/platform/paths.ts";
import { createSnapshot, listSnapshots, RESTORABLE, restoreSnapshot, snapshotDir } from "../../adapters/store/snapshots.ts";
import { inspectStateDocs, readState } from "../../adapters/store/state-store.ts";
import { beginTxn, clearTxn, readTxn } from "../../adapters/store/transaction.ts";
import { effectiveSource, STATE_DOCS } from "../../core/release/manifest.ts";
import { compareSemver } from "../../core/release/semver.ts";
import { planRollback } from "../../core/state/rollback-plan.ts";
import { schemaOf, type FactoryState, type SnapshotInfo, type StateDoc, type TxnRecord } from "../../core/state/schema.ts";
import { fetchRelease, installAndApply, invalidDocsMessage, msg, parseVersion, releaseDeps, withTxnLock, type ReleaseContext } from "./release-txn.ts";

export interface RollbackOptions {
  /** Target release (`v1.2.3` or `1.2.3`); default the most recent history version other than the installed one. */
  version?: string;
  yes: boolean;
}

interface Plan {
  target: string;
  /** The journal being recovered (restore every file of its snapshot), or undefined in normal mode. */
  recovery: TxnRecord | undefined;
}

/** The `schema` of a document's copy in a snapshot; undefined when unreadable or without one. */
async function copySchema(paths: FactoryPaths, id: string, doc: StateDoc): Promise<number | undefined> {
  try {
    return schemaOf(await readJson(join(snapshotDir(paths, id), doc)));
  } catch (e) {
    if (e instanceof MalformedJson) return undefined;
    throw e;
  }
}

/**
 * For each state document, the newest snapshot taken when leaving `target` whose copy the target can read
 * (copy `schema` ≤ the target's). Snapshots are trusted by content, not by label: an incompatible copy is
 * skipped in favour of an older matching snapshot.
 */
async function compatibleCopies(
  paths: FactoryPaths,
  snapshots: SnapshotInfo[],
  target: string,
  targetSchemas: Record<StateDoc, number>,
): Promise<Partial<Record<StateDoc, string>>> {
  const candidates = snapshots.filter((s) => s.from === target); // newest first
  const out: Partial<Record<StateDoc, string>> = {};
  for (const doc of STATE_DOCS) {
    for (const snap of candidates) {
      if (!snap.files.includes(doc)) continue;
      const schema = await copySchema(paths, snap.id, doc);
      if (schema !== undefined && schema <= targetSchemas[doc]) {
        out[doc] = snap.id;
        break;
      }
    }
  }
  return out;
}

export async function rollback(ctx: ReleaseContext, opts: RollbackOptions): Promise<number> {
  const { io, paths, env } = ctx;
  const deps = releaseDeps(ctx);
  let requested: string | undefined;
  if (opts.version !== undefined) {
    requested = parseVersion(opts.version);
    if (requested === undefined) {
      io.err(`"${opts.version}" is not a release version; use the form 1.2.3.`);
      return 1;
    }
  }

  return withTxnLock(ctx, deps, async (held) => {
    /** Set once a mutation may have happened: from then on a failure needs `factory rollback`. */
    let mutating = false;
    let plan: Plan | undefined;
    let rollbackSnapshot: string | undefined;
    try {
      let txn: TxnRecord | undefined;
      try {
        txn = await readTxn(paths);
      } catch (e) {
        if (!(e instanceof MalformedJson)) throw e;
        io.err(
          `The transaction journal ${paths.txn} is unreadable: ${msg(e.cause)}. Nothing was changed.\n` +
            `  fix: It records an unfinished update or rollback. Its snapshot is the newest directory in ${paths.backups} (snapshot.json names the transaction); ` +
            `repair the journal from it, or remove ${paths.txn} if no transaction was running, then run "factory rollback" again.`,
        );
        return 1;
      }
      // Recovery never reads the current documents (they belong to the half-applied transaction and are
      // replaced from its snapshot); a normal rollback checks every one of them before any change (I1).
      let state: FactoryState | undefined;
      let currentSchemas: Partial<Record<StateDoc, number>> = {};
      if (txn === undefined) {
        const inspected = await inspectStateDocs(paths, ctx.manifest.stateSchemas);
        if (inspected.problems.length > 0) {
          io.err(invalidDocsMessage(inspected.problems, "factory rollback"));
          return 1;
        }
        currentSchemas = inspected.schemas;
        state = await readState(paths);
      }
      const snapshots = await listSnapshots(paths);

      if (txn !== undefined) {
        if (requested !== undefined && requested !== txn.from) {
          io.err(`An unfinished ${txn.kind} ${txn.from} → ${txn.to} must be recovered first. Run "factory rollback" without a version.`);
          return 1;
        }
        const snapshot = snapshots.find((s) => s.id === txn.snapshot);
        if (snapshot === undefined) {
          io.err(`The unfinished ${txn.kind} ${txn.from} → ${txn.to} names snapshot ${txn.snapshot}, which is missing or incomplete in ${paths.backups}. It cannot be recovered automatically.`);
          return 1;
        }
        plan = { target: txn.from, recovery: txn };
        io.out(`Recovering the unfinished ${txn.kind} ${txn.from} → ${txn.to} from snapshot ${snapshot.id}.`);
      } else {
        if (state === undefined) {
          io.err(`The factory is not installed (no ${paths.state}). Nothing to roll back.`);
          return 1;
        }
        const target = requested ?? [...state.history].reverse().find((h) => h.version !== state.version)?.version;
        if (target === undefined) {
          io.err(`No earlier version is recorded in ${paths.state}. Name one: "factory rollback <version>".`);
          return 1;
        }
        const order = compareSemver(target, state.version);
        if (order === 0) {
          io.out(`factory ${target} is already installed. Nothing to roll back.`);
          return 0;
        }
        if (order > 0) {
          io.err(`${target} is newer than the installed ${state.version}. Use "factory update --to ${target}" instead.`);
          return 1;
        }
        plan = { target, recovery: undefined };
      }
      // Recovery: the half-applied state belongs to the version the transaction was moving to.
      const current = txn?.to ?? state?.version;
      if (current === undefined) throw new Error("no installed version is recorded");

      const release = await fetchRelease(ctx, deps, effectiveSource(ctx.manifest, env), plan.target);

      /** Snapshot id → files to restore from it. */
      const restore = new Map<string, string[]>();
      const recovering = plan.recovery;
      if (recovering !== undefined) {
        const snapshot = snapshots.find((s) => s.id === recovering.snapshot);
        restore.set(recovering.snapshot, (snapshot?.files ?? []).filter((f) => RESTORABLE.includes(f)));
      } else {
        // A snapshot taken when leaving the target holds the target's state, whatever release it went to.
        const copies = await compatibleCopies(paths, snapshots, plan.target, release.manifest.stateSchemas);
        const decision = planRollback({
          current: currentSchemas,
          target: release.manifest.stateSchemas,
          snapshotHas: Object.fromEntries(Object.keys(copies).map((d) => [d, true])) as Partial<Record<StateDoc, boolean>>,
        });
        if (decision.refuse.length > 0) {
          io.err(`Cannot roll back ${decision.refuse.join(", ")}: no snapshot holds a compatible copy. Nothing was changed.`);
          return 1;
        }
        for (const doc of decision.restore) {
          const id = copies[doc] as string;
          restore.set(id, [...(restore.get(id) ?? []), doc]);
        }
        if (decision.restore.length > 0) {
          io.out(`Rolling back loses changes in: ${decision.restore.join(", ")}`);
          if (!opts.yes && !(await io.confirm(`Roll back factory ${current} → ${plan.target}?`))) {
            io.err("Rollback cancelled. Nothing was changed.");
            return 1;
          }
        }
      }

      held.live();
      const snap = await createSnapshot(paths, { from: current, to: plan.target, kind: "rollback", now: ctx.now() });
      rollbackSnapshot = snap.id;
      /** The journal this rollback finishes: the one it recovers, or the one it starts now. */
      const txnId = plan.recovery?.id ?? snap.id;
      if (plan.recovery === undefined) {
        held.live();
        await beginTxn(paths, { id: snap.id, kind: "rollback", from: current, to: plan.target, snapshot: snap.id, now: ctx.now() });
      }
      mutating = true;
      for (const [id, files] of restore) {
        if (files.length === 0) continue;
        held.live();
        // A journal's snapshot is restored as it is (I1); normal-mode copies were chosen by content.
        await restoreSnapshot(paths, id, files, { verbatim: plan.recovery !== undefined });
      }

      const code = await installAndApply(ctx, deps, held, release.manifest, { reason: "rollback", from: current });
      if (code !== 0) {
        io.err(failedMessage(plan, rollbackSnapshot));
        return code;
      }
      // The target's `_apply-release` clears the journal after writing state.json; make sure it is gone
      // (still under our lock), but only if state.json really records the target.
      if ((await readState(paths))?.version === plan.target) {
        await held.lock.verify();
        await clearTxn(paths, txnId);
      } else {
        io.err(`factory ${plan.target} reported success but ${paths.state} does not record it. ${failedMessage(plan, rollbackSnapshot)}`);
        return 1;
      }
      return 0;
    } catch (e) {
      if (!mutating || plan === undefined) io.err(`Rollback did not start: ${msg(e)}. Nothing was changed.`);
      else io.err(`${msg(e)}\n${failedMessage(plan, rollbackSnapshot)}`);
      return 1;
    }
  });
}

function failedMessage(plan: Plan, rollbackSnapshot: string | undefined): string {
  if (plan.recovery !== undefined) {
    return `Recovery did not complete. Run "factory rollback" again to retry; snapshot ${plan.recovery.snapshot} is untouched.`;
  }
  return `Rollback failed. Your state before the rollback is in snapshot ${rollbackSnapshot}. Run "factory rollback" to restore it.`;
}
