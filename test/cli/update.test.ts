import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, Locked } from "../../src/adapters/store/lock.ts";
import { registerSession } from "../../src/adapters/store/sessions.ts";
import { listSnapshots } from "../../src/adapters/store/snapshots.ts";
import { readTxn } from "../../src/adapters/store/transaction.ts";
import { writePersonalConfig, writeState } from "../../src/adapters/store/state-store.ts";
import { update } from "../../src/cli/commands/update.ts";
import { makeWorld, realisticApply, SOURCE, stateAt, tree, type World } from "../helpers/release-world.ts";

const CHANGELOG = ["# Changelog", "", "## [0.2.0] - 2026-11-01", "- new thing", "", "## [0.1.1] - 2026-10-20", "- fix", "", "## [0.1.0] - 2026-10-01", "- first"].join("\n");

let w: World;

beforeEach(async () => {
  w = await makeWorld("update");
  await writeState(w.paths, stateAt("0.1.0", [{ version: "0.1.0", at: "2026-10-01T00:00:00.000Z", reason: "install" }]));
  await writePersonalConfig(w.paths, { schema: 1, profile: "codex-only" });
  w.tags = ["v0.1.0", "v0.1.1", "v0.2.0", "latest", "v0.3.0-rc.1"];
  w.releases = { "v0.1.0": {}, "v0.1.1": {}, "v0.2.0": { changelog: CHANGELOG } };
});
afterEach(async () => {
  await w.cleanup();
});

describe("factory update", () => {
  it("picks the highest v* tag above the installed version (v0.2.0 over v0.1.0/v0.1.1)", async () => {
    const code = await update(w.ctx(), { yes: true });
    expect(code, w.err.join("\n")).toBe(0);
    expect(w.log).toContain("clone v0.2.0");
    expect(w.log).toContain(`npm install -g --legacy-peer-deps git+${SOURCE}#v0.2.0`);
    expect(JSON.parse(readFileSync(w.paths.state, "utf8")).version).toBe("0.2.0");
  });

  it("happy path: changelog, snapshot → journal → npm -g --legacy-peer-deps → apply with --parent-lock <pid>", async () => {
    let atNpm: { txn: Awaited<ReturnType<typeof readTxn>>; snapshots: Awaited<ReturnType<typeof listSnapshots>> } | undefined;
    const base = w.ctx();
    const ctx = w.ctx({
      npm: async (args, opts) => {
        if (args[0] === "install") atNpm = { txn: await readTxn(w.paths), snapshots: await listSnapshots(w.paths) };
        return base.deps!.npm!(args, opts);
      },
    });
    const code = await update(ctx, { yes: true });
    expect(code, w.err.join("\n")).toBe(0);
    expect(w.log).toEqual([
      `ls-remote ${SOURCE}`,
      "clone v0.2.0",
      `npm install -g --legacy-peer-deps git+${SOURCE}#v0.2.0`,
      "npm root -g",
      `node ${w.globalCli} _apply-release --reason update --from 0.1.0 --parent-lock ${process.pid} --yes`,
    ]);
    // The journal names a complete snapshot of the pre-update state, both written before npm ran.
    expect(atNpm?.snapshots).toHaveLength(1);
    const snap = atNpm!.snapshots[0]!;
    expect(snap).toMatchObject({ from: "0.1.0", to: "0.2.0", kind: "update" });
    expect(snap.files).toEqual(expect.arrayContaining(["config.json", "state.json"]));
    expect(atNpm?.txn).toMatchObject({ kind: "update", from: "0.1.0", to: "0.2.0", snapshot: snap.id });
    // The changelog between the versions is shown, newest first, without the installed version.
    const shown = w.out.join("\n");
    expect(shown).toContain("## [0.2.0]");
    expect(shown).toContain("## [0.1.1]");
    expect(shown).not.toContain("## [0.1.0]");
    expect(existsSync(w.paths.txn)).toBe(false);
    // The lock is released afterwards.
    await (await acquireLock(w.paths)).release();
  });

  it("asks for confirmation without --yes; declining changes nothing", async () => {
    const before = tree(w.paths.home);
    expect(await update(w.ctx(), { yes: false })).toBe(1);
    expect(w.confirms).toEqual(["Update factory 0.1.0 → 0.2.0?"]);
    expect(tree(w.paths.home)).toEqual(before);
    expect(w.log.some((l) => l.startsWith("npm "))).toBe(false);
  });

  it("already at the highest tag → Already up to date, exit 0, nothing changed", async () => {
    w.tags = ["v0.1.0"];
    const before = tree(w.paths.home);
    expect(await update(w.ctx(), { yes: true })).toBe(0);
    expect(w.out.join("\n")).toContain("Already up to date");
    expect(tree(w.paths.home)).toEqual(before);
  });

  it("update aborts before swap on unresolvable tag: --to v9.9.9 → exit 1, no snapshot dir, no journal", async () => {
    const before = tree(w.paths.home);
    expect(await update(w.ctx(), { to: "v9.9.9", yes: true })).toBe(1);
    expect(w.err.join("\n")).toContain("v9.9.9");
    expect(existsSync(w.paths.backups)).toBe(false);
    expect(existsSync(w.paths.txn)).toBe(false);
    expect(tree(w.paths.home)).toEqual(before);
    expect(w.log.some((l) => l.startsWith("clone") || l.startsWith("npm "))).toBe(false);
  });

  it("--to selects a specific release", async () => {
    expect(await update(w.ctx(), { to: "0.1.1", yes: true })).toBe(0);
    expect(w.log).toContain(`npm install -g --legacy-peer-deps git+${SOURCE}#v0.1.1`);
  });

  it("a pending journal → exit 1 with the recovery message, nothing run", async () => {
    await writeFile(w.paths.txn, JSON.stringify({ id: "t", kind: "update", from: "0.0.9", to: "0.1.0", snapshot: "s", startedAt: "2026-11-01T09:00:00.000Z" }));
    expect(await update(w.ctx(), { yes: true })).toBe(1);
    expect(w.err.join("\n")).toBe('A previous update did not finish. Run "factory rollback".');
    expect(w.log).toEqual([]);
  });

  it("a session registered before update → exit 1 naming its pid, lock released, nothing changed", async () => {
    const session = await registerSession(w.paths);
    try {
      const before = tree(w.paths.home);
      expect(await update(w.ctx(), { yes: true })).toBe(1);
      expect(w.err.join("\n")).toContain(`Close factory sessions first: pids ${process.pid}`);
      expect(tree(w.paths.home)).toEqual(before);
      expect(w.log).toEqual([]);
      await (await acquireLock(w.paths)).release();
    } finally {
      await session.end();
    }
  });

  it("a session registration attempted while update holds the lock → Locked; the child can borrow the lock", async () => {
    let registration: unknown;
    let borrowed: boolean | undefined;
    w.onApply = async (args, world) => {
      registration = await registerSession(world.paths, { launcherPid: 999_999 }).then(
        () => "registered",
        (e: unknown) => e,
      );
      const lock = await acquireLock(world.paths, { ownerPid: Number(args[args.indexOf("--parent-lock") + 1]) });
      borrowed = lock.borrowed;
      await lock.release();
      return realisticApply(args, world);
    };
    expect(await update(w.ctx(), { yes: true })).toBe(0);
    expect(registration).toBeInstanceOf(Locked);
    expect(borrowed).toBe(true);
  });

  it("child exits 0 but state.json does not record the target → exit 1 with the rollback instruction", async () => {
    w.onApply = async () => 0;
    expect(await update(w.ctx(), { yes: true })).toBe(1);
    expect(w.err.join("\n")).toMatch(/does not record[\s\S]*Update failed\. Your previous state is in snapshot \S+\. Run "factory rollback"\./);
  });

  it("child exits 0 and writes state but leaves the journal → exit 1 with the rollback instruction", async () => {
    w.onApply = (args, world) => realisticApply(args, world, { clear: false });
    expect(await update(w.ctx(), { yes: true })).toBe(1);
    expect(w.err.join("\n")).toMatch(/journal[\s\S]*Run "factory rollback"/);
  });

  it("a lock release failure after a successful child → exit 1 with the error", async () => {
    const ctx = w.ctx({
      acquireLock: async (paths, opts) => {
        const real = await acquireLock(paths, opts);
        return { ...real, release: async () => {
          await real.release();
          throw new Error("lock compromised while the child ran");
        } };
      },
    });
    expect(await update(ctx, { yes: true })).toBe(1);
    expect(w.err.join("\n")).toContain("lock compromised while the child ran");
  });

  it("target release needing a newer Node → exit 1 with the fix, nothing changed", async () => {
    w.releases["v0.2.0"] = { nodeMin: "99.0.0" };
    const before = tree(w.paths.home);
    expect(await update(w.ctx(), { yes: true })).toBe(1);
    expect(w.err.join("\n")).toMatch(/Node\.js 99\.0\.0[\s\S]*Install Node\.js 99\.0\.0 or newer/);
    expect(tree(w.paths.home)).toEqual(before);
  });

  it("npm failure after the journal → exit 1 naming the snapshot and factory rollback; journal kept", async () => {
    w.npmFails = true;
    expect(await update(w.ctx(), { yes: true })).toBe(1);
    const [snap] = await listSnapshots(w.paths);
    expect(w.err.join("\n")).toContain(`Update failed. Your previous state is in snapshot ${snap!.id}. Run "factory rollback".`);
    expect((await readTxn(w.paths))?.snapshot).toBe(snap!.id);
    expect(w.log.some((l) => l.startsWith("node "))).toBe(false);
  });

  it("a failing child apply → exit with its code and the recovery message; journal kept", async () => {
    w.onApply = async () => 1;
    expect(await update(w.ctx(), { yes: true })).toBe(1);
    expect(w.err.join("\n")).toMatch(/Update failed\. Your previous state is in snapshot \S+\. Run "factory rollback"\./);
    expect(existsSync(w.paths.txn)).toBe(true);
    await (await acquireLock(w.paths)).release();
  });
});
