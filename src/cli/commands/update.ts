// `factory update`: moves the installation to a newer release. Everything that can fail cheaply (tag
// resolution, clone, Node requirement, confirmation) happens before the first mutation; then an immutable
// snapshot and the journal are written (ruling 12) and the new release's CLI applies itself (ruling 10).
import { existsSync } from "node:fs";
import { createSnapshot } from "../../adapters/store/snapshots.ts";
import { inspectStateDocs, readState, stateDocPath, type StateDocProblem } from "../../adapters/store/state-store.ts";
import { beginTxn } from "../../adapters/store/transaction.ts";
import { changelogBetween } from "../../core/release/changelog.ts";
import { effectiveSource, STATE_DOCS, tagFor } from "../../core/release/manifest.ts";
import { compareSemver } from "../../core/release/semver.ts";
import { TXN_PENDING_MESSAGE } from "./apply-release.ts";
import { fetchRelease, installAndApply, invalidDocsMessage, msg, parseVersion, releaseDeps, withTxnLock, type ReleaseContext } from "./release-txn.ts";

export interface UpdateOptions {
  /** Target release (`v1.2.3` or `1.2.3`); default the highest `v*` tag above the installed version. */
  to?: string;
  yes: boolean;
}

const failedMessage = (snapshot: string): string => `Update failed. Your previous state is in snapshot ${snapshot}. Run "factory rollback".`;

export async function update(ctx: ReleaseContext, opts: UpdateOptions): Promise<number> {
  const { io, paths, env } = ctx;
  const deps = releaseDeps(ctx);

  if (existsSync(paths.txn)) {
    io.err(TXN_PENDING_MESSAGE);
    return 1;
  }
  let requested: string | undefined;
  if (opts.to !== undefined) {
    requested = parseVersion(opts.to);
    if (requested === undefined) {
      io.err(`"${opts.to}" is not a release version; use the form v1.2.3.`);
      return 1;
    }
  }

  return withTxnLock(ctx, deps, async (held) => {
    /** Set once the journal exists: from then on a failure needs `factory rollback`. */
    let snapshotId: string | undefined;
    try {
      // Re-checked under the lock: a transaction may have started since the check above.
      if (existsSync(paths.txn)) {
        io.err(TXN_PENDING_MESSAGE);
        return 1;
      }
      // Preflight (I1): every state document must be readable by this release, or a failed update
      // could never be recovered (the snapshot would hold a document nothing can read).
      const inspected = await inspectStateDocs(paths, ctx.manifest.stateSchemas);
      const problems: StateDocProblem[] = [...inspected.problems];
      for (const doc of STATE_DOCS) {
        const schema = inspected.schemas[doc];
        const readable = ctx.manifest.stateSchemas[doc];
        if (schema !== undefined && schema !== readable && !problems.some((p) => p.doc === doc)) {
          problems.push({ doc, path: stateDocPath(paths, doc), detail: `it has schema ${schema}, but factory ${ctx.manifest.factory} reads schema ${readable}` });
        }
      }
      if (problems.length > 0) {
        io.err(invalidDocsMessage(problems, "factory update"));
        return 1;
      }
      const state = await readState(paths);
      if (state === undefined) {
        io.err(`The factory is not installed (no ${paths.state}). Run "factory install" first.`);
        return 1;
      }
      const current = state.version;
      const source = effectiveSource(ctx.manifest, env);

      const versions = (await deps.lsRemoteTags(source, { env }))
        .map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t)?.[1])
        .filter((v): v is string => v !== undefined);
      let target: string;
      if (requested !== undefined) {
        if (!versions.includes(requested)) {
          io.err(`Release ${tagFor(requested)} was not found at ${source}. Nothing was changed.`);
          return 1;
        }
        const order = compareSemver(requested, current);
        if (order === 0) {
          io.out(`Already up to date (factory ${current}).`);
          return 0;
        }
        if (order < 0) {
          io.err(`${tagFor(requested)} is older than the installed ${current}. Use "factory rollback ${requested}" instead.`);
          return 1;
        }
        target = requested;
      } else {
        const newer = versions.filter((v) => compareSemver(v, current) > 0).sort(compareSemver);
        const highest = newer[newer.length - 1];
        if (highest === undefined) {
          io.out(`Already up to date (factory ${current}).`);
          return 0;
        }
        target = highest;
      }

      const release = await fetchRelease(ctx, deps, source, target);
      if (release.changelog !== undefined) {
        const notes = changelogBetween(release.changelog, current, target);
        if (notes !== "") io.out(notes);
      }
      const nodeMin = release.manifest.node.min;
      if (compareSemver(deps.nodeVersion, nodeMin) < 0) {
        io.err(
          `factory ${target} needs Node.js ${nodeMin} or newer; this is Node.js ${deps.nodeVersion}. Nothing was changed.\n` +
            `  fix: Install Node.js ${nodeMin} or newer (user-level, e.g. via nvm or fnm), then run "factory update" again.`,
        );
        return 1;
      }
      if (!opts.yes && !(await io.confirm(`Update factory ${current} → ${target}?`))) {
        io.err("Update cancelled. Nothing was changed.");
        return 1;
      }

      held.live();
      const snapshot = await createSnapshot(paths, { from: current, to: target, kind: "update", now: ctx.now() });
      held.live();
      await beginTxn(paths, { id: snapshot.id, kind: "update", from: current, to: target, snapshot: snapshot.id, now: ctx.now() });
      snapshotId = snapshot.id;

      // The new CLI's `_apply-release` removes the journal once it has written state.json.
      const code = await installAndApply(ctx, deps, held, release.manifest, { reason: "update", from: current });
      if (code !== 0) {
        io.err(failedMessage(snapshotId));
        return code;
      }
      // Trust but verify the child's contract: state.json records the target and the journal is gone.
      const recorded = (await readState(paths))?.version;
      if (recorded !== target) {
        io.err(`factory ${target} reported success but ${paths.state} does not record it (it records ${recorded ?? "nothing"}).\n${failedMessage(snapshotId)}`);
        return 1;
      }
      if (existsSync(paths.txn)) {
        io.err(`factory ${target} reported success but left the journal ${paths.txn} in place.\n${failedMessage(snapshotId)}`);
        return 1;
      }
      return 0;
    } catch (e) {
      if (snapshotId === undefined) io.err(`Update did not start: ${msg(e)}. Nothing was changed.`);
      else io.err(`${msg(e)}\n${failedMessage(snapshotId)}`);
      return 1;
    }
  });
}
