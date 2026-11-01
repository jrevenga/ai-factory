// `factory rollback`: returns to an earlier release. This (newer) CLI snapshots and restores state first,
// then installs the older CLI and lets it apply itself, so older releases need no rollback knowledge
// (ruling 10). Only documents whose schema is newer than the target supports are restored (ruling 11).
//
// Recovery mode: a journal left by an unfinished update/rollback is recovered exactly — target is the
// version it left, and every restorable file of its snapshot is restored (ruling 12). That snapshot is
// never written to: a new rollback snapshot of the current (half-applied) state is taken first.
import { createSnapshot, listSnapshots, RESTORABLE, restoreSnapshot } from "../../adapters/store/snapshots.ts";
import { docSchemas, readState } from "../../adapters/store/state-store.ts";
import { beginTxn, clearTxn, readTxn } from "../../adapters/store/transaction.ts";
import { effectiveSource } from "../../core/release/manifest.ts";
import { compareSemver } from "../../core/release/semver.ts";
import { planRollback } from "../../core/state/rollback-plan.ts";
import type { SnapshotInfo, StateDoc, TxnRecord } from "../../core/state/schema.ts";
import { fetchRelease, installAndApply, msg, parseVersion, releaseDeps, withTxnLock, type ReleaseContext } from "./release-txn.ts";

export interface RollbackOptions {
  /** Target release (`v1.2.3` or `1.2.3`); default the most recent history version other than the installed one. */
  version?: string;
  yes: boolean;
}

/** What to roll back to and which files of which snapshot to restore. */
interface Plan {
  target: string;
  /** Snapshot to restore from; undefined when no snapshot was taken when leaving the target. */
  snapshot: SnapshotInfo | undefined;
  /** The journal being recovered (restore every file of its snapshot), or undefined in normal mode. */
  recovery: TxnRecord | undefined;
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
      const txn = await readTxn(paths);
      const state = await readState(paths);
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
        plan = { target: txn.from, snapshot, recovery: txn };
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
        // A snapshot taken when leaving the target holds the target's state, whatever release it went to.
        plan = { target, snapshot: snapshots.find((s) => s.from === target), recovery: undefined };
      }
      const current = state?.version ?? txn?.to;
      if (current === undefined) throw new Error("no installed version is recorded");

      const release = await fetchRelease(ctx, deps, effectiveSource(ctx.manifest, env), plan.target);

      let restore: string[];
      if (plan.recovery !== undefined) {
        restore = (plan.snapshot?.files ?? []).filter((f) => RESTORABLE.includes(f));
      } else {
        const files = plan.snapshot?.files ?? [];
        const decision = planRollback({
          current: await docSchemas(paths),
          target: release.manifest.stateSchemas,
          snapshotHas: Object.fromEntries(files.map((f) => [f, true])) as Partial<Record<StateDoc, boolean>>,
        });
        if (decision.refuse.length > 0) {
          io.err(`Cannot roll back ${decision.refuse.join(", ")}: no snapshot holds a compatible copy. Nothing was changed.`);
          return 1;
        }
        restore = decision.restore;
        if (restore.length > 0) {
          io.out(`Rolling back loses changes in: ${restore.join(", ")}`);
          if (!opts.yes && !(await io.confirm(`Roll back factory ${current} → ${plan.target}?`))) {
            io.err("Rollback cancelled. Nothing was changed.");
            return 1;
          }
        }
      }

      held.live();
      const snap = await createSnapshot(paths, { from: current, to: plan.target, kind: "rollback", now: ctx.now() });
      rollbackSnapshot = snap.id;
      if (plan.recovery === undefined) {
        held.live();
        await beginTxn(paths, { id: snap.id, kind: "rollback", from: current, to: plan.target, snapshot: snap.id, now: ctx.now() });
      }
      mutating = true;
      if (restore.length > 0 && plan.snapshot !== undefined) {
        held.live();
        await restoreSnapshot(paths, plan.snapshot.id, restore);
      }

      const code = await installAndApply(ctx, deps, held, release.manifest, { reason: "rollback", from: current });
      if (code !== 0) {
        io.err(failedMessage(plan, rollbackSnapshot));
        return code;
      }
      // The target's `_apply-release` clears the journal after writing state.json; make sure it is gone
      // (still under our lock), but only if state.json really records the target.
      if ((await readState(paths))?.version === plan.target) {
        held.live();
        await clearTxn(paths);
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
