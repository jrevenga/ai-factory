import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../src/adapters/store/lock.ts";
import { registerSession } from "../../src/adapters/store/sessions.ts";
import { createSnapshot, listSnapshots } from "../../src/adapters/store/snapshots.ts";
import { readTxn } from "../../src/adapters/store/transaction.ts";
import { writeState } from "../../src/adapters/store/state-store.ts";
import { rollback } from "../../src/cli/commands/rollback.ts";
import { update } from "../../src/cli/commands/update.ts";
import { makeWorld, realisticApply, SOURCE, stateAt, tree, type World } from "../helpers/release-world.ts";

const at = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const INSTALL_010 = { version: "0.1.0", at: "2026-10-01T00:00:00.000Z", reason: "install" as const };
const UPDATE_020 = { version: "0.2.0", at: "2026-10-10T00:00:00.000Z", reason: "update" as const, from: "0.1.0" };

let w: World;

beforeEach(async () => {
  w = await makeWorld("rollback");
});
afterEach(async () => {
  await w.cleanup();
});

async function writeConfig(value: object): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(w.paths.config, text);
  return text;
}

/** Installed 0.1.0, updated to 0.2.0 (snapshot taken when leaving 0.1.0). Returns the snapshotted config bytes. */
async function installedThenUpdated(): Promise<string> {
  await writeState(w.paths, stateAt("0.1.0", [INSTALL_010]));
  const old = await writeConfig({ schema: 1, profile: "codex-only" });
  await createSnapshot(w.paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: at("2026-10-10") });
  await writeState(w.paths, stateAt("0.2.0", [INSTALL_010, UPDATE_020]));
  return old;
}

describe("factory rollback (normal mode)", () => {
  it("defaults to the previous history version; equal schemas keep the current config.json (post-upgrade edits preserved)", async () => {
    await installedThenUpdated();
    const edited = await writeConfig({ schema: 1, profile: "claude-only", note: "edited after the upgrade" });
    w.releases = { "v0.1.0": {} };
    const code = await rollback(w.ctx(), { yes: true });
    expect(code, w.err.join("\n")).toBe(0);
    expect(readFileSync(w.paths.config, "utf8")).toBe(edited);
    expect(w.log).toEqual([
      "clone v0.1.0",
      `npm install -g --legacy-peer-deps git+${SOURCE}#v0.1.0`,
      "npm root -g",
      `node ${w.globalCli} _apply-release --reason rollback --from 0.2.0 --parent-lock ${process.pid} --yes`,
    ]);
    expect(w.out.join("\n")).not.toContain("Rolling back loses changes");
    expect(w.confirms).toEqual([]);
    const snaps = await listSnapshots(w.paths);
    expect(snaps[0]).toMatchObject({ from: "0.2.0", to: "0.1.0", kind: "rollback" });
    expect(JSON.parse(readFileSync(w.paths.state, "utf8")).version).toBe("0.1.0");
    expect(existsSync(w.paths.txn)).toBe(false);
    await (await acquireLock(w.paths)).release();
  });

  it("config schema 2 vs target schema 1 with a snapshot copy → restored, with the loss message", async () => {
    const old = await installedThenUpdated();
    await writeConfig({ schema: 2, profile: "codex-only", renamed: true });
    w.releases = { "v0.1.0": { stateSchemas: { "config.json": 1 } } };
    expect(await rollback(w.ctx(), { yes: true }), w.err.join("\n")).toBe(0);
    expect(w.out.join("\n")).toContain("Rolling back loses changes in: config.json");
    expect(readFileSync(w.paths.config, "utf8")).toBe(old);
  });

  it("a restore asks for confirmation without --yes; declining changes nothing", async () => {
    await installedThenUpdated();
    await writeConfig({ schema: 2, profile: "codex-only" });
    w.releases = { "v0.1.0": {} };
    const before = tree(w.paths.home);
    expect(await rollback(w.ctx(), { yes: false })).toBe(1);
    expect(w.confirms).toHaveLength(1);
    expect(tree(w.paths.home)).toEqual(before);
    expect(w.log.some((l) => l.startsWith("npm "))).toBe(false);
  });

  it("config schema 2 without any snapshot copy → exit 1 before mutation, bytes unchanged", async () => {
    await writeState(w.paths, stateAt("0.2.0", [INSTALL_010, UPDATE_020]));
    await writeConfig({ schema: 2, profile: "codex-only" });
    w.releases = { "v0.1.0": {} };
    const before = tree(w.paths.home);
    expect(await rollback(w.ctx(), { yes: true })).toBe(1);
    expect(w.err.join("\n")).toContain("Cannot roll back config.json: no snapshot holds a compatible copy.");
    expect(tree(w.paths.home)).toEqual(before);
    expect(w.log.some((l) => l.startsWith("npm "))).toBe(false);
  });

  it("1.0.0 → 2.0.0 → 3.0.0, rollback 1.0.0 restores config.json from the 1.0.0-to-2.0.0 snapshot", async () => {
    const h1 = { version: "1.0.0", at: "2026-09-01T00:00:00.000Z", reason: "install" as const };
    const h2 = { version: "2.0.0", at: "2026-09-10T00:00:00.000Z", reason: "update" as const, from: "1.0.0" };
    const h3 = { version: "3.0.0", at: "2026-09-20T00:00:00.000Z", reason: "update" as const, from: "2.0.0" };
    await writeState(w.paths, stateAt("1.0.0", [h1]));
    const v1 = await writeConfig({ schema: 1, profile: "codex-only", era: 1 });
    await createSnapshot(w.paths, { from: "1.0.0", to: "2.0.0", kind: "update", now: at("2026-09-10") });
    await writeState(w.paths, stateAt("2.0.0", [h1, h2]));
    await writeConfig({ schema: 1, profile: "codex-only", era: 2 });
    await createSnapshot(w.paths, { from: "2.0.0", to: "3.0.0", kind: "update", now: at("2026-09-20") });
    await writeState(w.paths, stateAt("3.0.0", [h1, h2, h3]));
    await writeConfig({ schema: 2, profile: "codex-only", era: 3 });
    w.releases = { "v1.0.0": { stateSchemas: { "config.json": 1 } } };

    expect(await rollback(w.ctx(), { version: "1.0.0", yes: true }), w.err.join("\n")).toBe(0);
    expect(readFileSync(w.paths.config, "utf8")).toBe(v1);
    expect(w.log).toContain(`node ${w.globalCli} _apply-release --reason rollback --from 3.0.0 --parent-lock ${process.pid} --yes`);
  });

  it("a live session → exit 1, nothing changed", async () => {
    await installedThenUpdated();
    w.releases = { "v0.1.0": {} };
    const session = await registerSession(w.paths);
    try {
      const before = tree(w.paths.home);
      expect(await rollback(w.ctx(), { yes: true })).toBe(1);
      expect(w.err.join("\n")).toContain(`Close factory sessions first: pids ${process.pid}`);
      expect(tree(w.paths.home)).toEqual(before);
    } finally {
      await session.end();
    }
  });

  it("a failing child apply → exit 1, journal points at the new rollback snapshot", async () => {
    await installedThenUpdated();
    w.releases = { "v0.1.0": {} };
    w.onApply = async () => 1;
    expect(await rollback(w.ctx(), { yes: true })).toBe(1);
    const [snap] = await listSnapshots(w.paths);
    expect(snap).toMatchObject({ from: "0.2.0", to: "0.1.0", kind: "rollback" });
    expect(await readTxn(w.paths)).toMatchObject({ kind: "rollback", from: "0.2.0", to: "0.1.0", snapshot: snap!.id });
    expect(w.err.join("\n")).toContain(snap!.id);
    expect(w.err.join("\n")).toContain('Run "factory rollback"');
  });
});

describe("factory rollback (recovery mode)", () => {
  it("failed update after migration recovers exactly", async () => {
    await writeState(w.paths, stateAt("0.1.0", [INSTALL_010]));
    const preUpdate = await writeConfig({ schema: 1, profile: "codex-only", mine: "keep me" });
    w.tags = ["v0.1.0", "v0.2.0"];
    w.releases = { "v0.1.0": {}, "v0.2.0": { stateSchemas: { "config.json": 2 } } };
    // The new CLI's apply migrates config.json, then dies (exit 1) before writing state.json.
    w.onApply = async () => {
      await writeConfig({ schema: 2, profile: "codex-only", migrated: true });
      return 1;
    };
    expect(await update(w.ctx(), { yes: true })).toBe(1);
    const txn = await readTxn(w.paths);
    expect(txn).toMatchObject({ kind: "update", from: "0.1.0", to: "0.2.0" });
    const recoveryDir = join(w.paths.backups, txn!.snapshot);
    const recoveryBytes = tree(recoveryDir);
    expect(JSON.parse(readFileSync(w.paths.config, "utf8")).migrated).toBe(true);

    // Recovery: the real child writes state, the parent clears the journal after it succeeds.
    w.log.length = 0;
    w.onApply = (args, world) => realisticApply(args, world, { clear: false });
    const code = await rollback(w.ctx(), { yes: true });
    expect(code, w.err.join("\n")).toBe(0);
    expect(readFileSync(w.paths.config, "utf8")).toBe(preUpdate);
    expect(tree(recoveryDir)).toEqual(recoveryBytes);
    const snaps = await listSnapshots(w.paths);
    expect(snaps).toHaveLength(2);
    expect(snaps.find((s) => s.id !== txn!.snapshot)).toMatchObject({ kind: "rollback", to: "0.1.0" });
    expect(w.log).toEqual([
      "clone v0.1.0",
      `npm install -g --legacy-peer-deps git+${SOURCE}#v0.1.0`,
      "npm root -g",
      `node ${w.globalCli} _apply-release --reason rollback --from 0.1.0 --parent-lock ${process.pid} --yes`,
    ]);
    expect(existsSync(w.paths.txn)).toBe(false);
    expect(JSON.parse(readFileSync(w.paths.state, "utf8")).version).toBe("0.1.0");
  });

  it("a failed recovery keeps the journal and the recovery snapshot, so it can be retried", async () => {
    await writeState(w.paths, stateAt("0.1.0", [INSTALL_010]));
    await writeConfig({ schema: 1, profile: "codex-only" });
    const snap = await createSnapshot(w.paths, { from: "0.1.0", to: "0.2.0", kind: "update", now: at("2026-10-31") });
    await writeFile(w.paths.txn, JSON.stringify({ id: snap.id, kind: "update", from: "0.1.0", to: "0.2.0", snapshot: snap.id, startedAt: "2026-10-31T00:00:00.000Z" }));
    const recoveryBytes = tree(join(w.paths.backups, snap.id));
    w.releases = { "v0.1.0": {} };
    w.npmFails = true;
    expect(await rollback(w.ctx(), { yes: true })).toBe(1);
    expect((await readTxn(w.paths))?.snapshot).toBe(snap.id);
    expect(tree(join(w.paths.backups, snap.id))).toEqual(recoveryBytes);
    expect(w.err.join("\n")).toContain('Run "factory rollback" again');
  });
});
