import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  loadSnapshot,
  MANIFEST_FILE,
  reconcileAfter,
  JOURNAL_FILE,
  reconcileNote,
  Reconciler,
  mergeReplayOrder,
  replayInterrupted,
  type ReplayItem,
  takeSnapshot,
  UNTRACKED_LIMITS,
  type Snapshot,
} from "../../../../src/adapters/pi/extension/reconcile.ts";
import { RunEvent } from "../../../../src/core/ledger/events.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const isWin = process.platform === "win32";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
/** Bytes that a utf8 round trip would corrupt: a clean binary file must come back byte for byte. */
const BINARY = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0xc3, 0x28, 0x00, 0x01]);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
beforeAll(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", isWin ? "NUL" : "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => lstatSync(join(dir, f)).isFile()).sort();
}

/** Everything the data-safety rule forbids creating: objects, refs (loose and packed), HEAD. */
function repoState(root: string) {
  return {
    objects: filesUnder(join(root, ".git", "objects")),
    refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: readFileSync(join(root, ".git", "HEAD"), "utf8"),
    packedRefs: existsSync(join(root, ".git", "packed-refs")) ? readFileSync(join(root, ".git", "packed-refs"), "utf8") : "",
  };
}

async function repo() {
  const t = await makeTmp("reconcile");
  cleanups.push(t.cleanup);
  const dir = realpathSync.native(t.dir);
  const root = join(dir, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "src", "a.txt"), "a original\n");
  writeFileSync(join(root, "src", "b.txt"), "b original\n");
  writeFileSync(join(root, "src", "bin.dat"), BINARY);
  writeFileSync(join(root, "README.md"), "readme\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const runDir = join(dir, "factory home", "runs", "proj", "run-1");
  mkdirSync(runDir, { recursive: true });
  let n = 0;
  const backupDir = () => join(runDir, "reconcile", `call-${++n}`);
  return { dir, root, runDir, backupDir };
}

const read = (f: string) => readFileSync(f, "utf8");

describe("takeSnapshot / reconcileAfter (Task 11)", () => {
  it("Step 1: a runner that edits a tracked file, stages a change and creates an untracked file is fully reverted; ignored output stays; copies are kept; no git objects or refs are created", async () => {
    const r = await repo();
    const before = repoState(r.root);
    const indexBefore = readFileSync(join(r.root, ".git", "index"));
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    expect(existsSync(join(bd, MANIFEST_FILE))).toBe(true);

    // The runner: an edit, a staged change, a new untracked file, an ignored build output, a binary rewrite.
    writeFileSync(join(r.root, "src", "a.txt"), "a changed by the runner\n");
    writeFileSync(join(r.root, "src", "b.txt"), "b staged by the runner\n");
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${git(r.root, "rev-parse", "HEAD:README.md")},src/b.txt`], { cwd: r.root, env: GIT_ENV });
    writeFileSync(join(r.root, "src", "new.txt"), "created by the runner\n");
    mkdirSync(join(r.root, "dist"));
    writeFileSync(join(r.root, "dist", "out.txt"), "build output\n");
    writeFileSync(join(r.root, "src", "bin.dat"), "not binary any more");

    const res = reconcileAfter(r.root, snap);
    expect(res.backupDir).toBe(bd);
    expect(res.reverted.sort()).toEqual(["src/a.txt", "src/b.txt", "src/bin.dat"]);
    expect(res.moved).toEqual(["src/new.txt"]);
    expect(res.indexRestored).toBe(true);
    expect(res.notRestored).toEqual([]);

    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(read(join(r.root, "src", "b.txt"))).toBe("b original\n");
    expect(readFileSync(join(r.root, "src", "bin.dat")).equals(BINARY)).toBe(true);
    expect(existsSync(join(r.root, "src", "new.txt"))).toBe(false);
    expect(read(join(r.root, "dist", "out.txt"))).toBe("build output\n");
    expect(readFileSync(join(r.root, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(git(r.root, "status", "--porcelain")).toBe("");

    // Nothing was lost: the pre-revert content of every reverted file and the moved file are under after/.
    expect(read(join(bd, "after", "src", "a.txt"))).toBe("a changed by the runner\n");
    expect(read(join(bd, "after", "src", "b.txt"))).toBe("b staged by the runner\n");
    expect(read(join(bd, "after", "src", "bin.dat"))).toBe("not binary any more");
    expect(read(join(bd, "after", "src", "new.txt"))).toBe("created by the runner\n");
    expect(existsSync(join(bd, "after", "index"))).toBe(true);
    expect(existsSync(join(bd, "index"))).toBe(true);

    expect(repoState(r.root)).toEqual(before);
    expect(JSON.parse(read(join(bd, MANIFEST_FILE)))).toMatchObject({ status: "done", result: { reverted: res.reverted, moved: ["src/new.txt"] } });
  });

  it("a user's uncommitted tracked edit survives: the command's change is reverted to the dirty content, not to HEAD", async () => {
    const r = await repo();
    writeFileSync(join(r.root, "src", "a.txt"), "user work in progress\n");
    writeFileSync(join(r.root, "README.md"), "staged by the user\n");
    git(r.root, "add", "README.md");
    const indexBefore = readFileSync(join(r.root, ".git", "index"));
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    expect(read(join(bd, "before", "src", "a.txt"))).toBe("user work in progress\n");
    expect(read(join(bd, "before", "README.md"))).toBe("staged by the user\n");
    writeFileSync(join(r.root, "src", "a.txt"), "runner\n");
    writeFileSync(join(r.root, "README.md"), "runner\n");
    const res = reconcileAfter(r.root, snap);
    expect(res.reverted.sort()).toEqual(["README.md", "src/a.txt"]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("user work in progress\n");
    expect(read(join(r.root, "README.md"))).toBe("staged by the user\n");
    expect(readFileSync(join(r.root, ".git", "index")).equals(indexBefore)).toBe(true);
  });

  it("edge cases: a deleted tracked file, a file replaced by a directory and a file replaced by a symlink are restored, with the replacements kept under after/", async () => {
    const r = await repo();
    writeFileSync(join(r.root, "c.txt"), "c original\n");
    git(r.root, "add", "c.txt");
    git(r.root, "commit", "-q", "-m", "c");
    const before = repoState(r.root);
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    unlinkSync(join(r.root, "README.md"));
    unlinkSync(join(r.root, "src", "a.txt"));
    mkdirSync(join(r.root, "src", "a.txt"));
    writeFileSync(join(r.root, "src", "a.txt", "inner.txt"), "inside the directory\n");
    unlinkSync(join(r.root, "c.txt"));
    symlinkSync("src/b.txt", join(r.root, "c.txt"));

    const res = reconcileAfter(r.root, snap);
    expect(res.notRestored).toEqual([]);
    expect(res.reverted.sort()).toEqual(["README.md", "c.txt", "src/a.txt"]);
    expect(read(join(r.root, "README.md"))).toBe("readme\n");
    expect(lstatSync(join(r.root, "src", "a.txt")).isFile()).toBe(true);
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(lstatSync(join(r.root, "c.txt")).isFile()).toBe(true);
    expect(read(join(r.root, "c.txt"))).toBe("c original\n");
    // The directory's content and the link itself (as a link) are kept.
    expect(read(join(bd, "after", "src", "a.txt", "inner.txt"))).toBe("inside the directory\n");
    expect(lstatSync(join(bd, "after", "c.txt")).isSymbolicLink()).toBe(true);
    // Windows reports a link target with its native separator, whatever the creator wrote.
    expect(readlinkSync(join(bd, "after", "c.txt")).replaceAll("\\", "/")).toBe("src/b.txt");
    expect(read(join(r.root, "src", "b.txt"))).toBe("b original\n");
    expect(git(r.root, "status", "--porcelain")).toBe("");
    expect(repoState(r.root)).toEqual(before);
  });

  it("R38: pre-existing untracked files are backed up and restored when the command changed or deleted them", async () => {
    const r = await repo();
    writeFileSync(join(r.root, "notes.txt"), "my notes\n");
    mkdirSync(join(r.root, "scratch"));
    writeFileSync(join(r.root, "scratch", "draft.md"), "draft\n");
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    expect(read(join(bd, "before", "notes.txt"))).toBe("my notes\n");
    expect(read(join(bd, "before", "scratch", "draft.md"))).toBe("draft\n");
    writeFileSync(join(r.root, "notes.txt"), "overwritten by the runner\n");
    rmSync(join(r.root, "scratch"), { recursive: true });
    const res = reconcileAfter(r.root, snap);
    expect(res.reverted.sort()).toEqual(["notes.txt", "scratch/draft.md"]);
    expect(read(join(r.root, "notes.txt"))).toBe("my notes\n");
    expect(read(join(r.root, "scratch", "draft.md"))).toBe("draft\n");
    expect(read(join(bd, "after", "notes.txt"))).toBe("overwritten by the runner\n");
  });

  it("R38: over the untracked cap (files or bytes) the snapshot fails closed with a clear reason and leaves no backup behind", async () => {
    expect(UNTRACKED_LIMITS).toEqual({ maxUntrackedFiles: 2000, maxUntrackedBytes: 50 * 1024 * 1024 });
    const r = await repo();
    for (let i = 0; i < 4; i++) writeFileSync(join(r.root, `u${i}.txt`), "x");
    const bd = r.backupDir();
    expect(() => takeSnapshot(r.root, bd, { maxUntrackedFiles: 3, maxUntrackedBytes: 1024 })).toThrow(/too many untracked files to reconcile safely/);
    expect(existsSync(bd)).toBe(false);
    writeFileSync(join(r.root, "big.bin"), Buffer.alloc(2048));
    const bd2 = r.backupDir();
    expect(() => takeSnapshot(r.root, bd2, { maxUntrackedFiles: 100, maxUntrackedBytes: 1024 })).toThrow(/too many untracked files to reconcile safely.*bytes/);
    expect(existsSync(bd2)).toBe(false);
  });

  it("fails closed outside a git work tree", async () => {
    const t = await makeTmp("reconcile-nogit");
    cleanups.push(t.cleanup);
    const bd = join(t.dir, "backup");
    expect(() => takeSnapshot(t.dir, bd)).toThrow(/not a git work tree/);
    expect(existsSync(bd)).toBe(false);
  });

  it.skipIf(isWin)("R39: a parent directory replaced by a symlink is never written through; the link is moved aside as a link and the files are restored in a real directory", async () => {
    const r = await repo();
    const outside = join(r.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.txt"), "outside content\n");
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    rmSync(join(r.root, "src"), { recursive: true });
    symlinkSync(outside, join(r.root, "src"));
    const res = reconcileAfter(r.root, snap);
    expect(read(join(outside, "a.txt"))).toBe("outside content\n");
    expect(readdirSync(outside)).toEqual(["a.txt"]);
    expect(lstatSync(join(bd, "after", "src")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(r.root, "src")).isDirectory()).toBe(true);
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(res.moved).toContain("src");
    expect(res.notRestored).toEqual([]);
  });

  it.skipIf(isWin)("R39: when the link cannot be moved aside (it is git-ignored), a restore below it is refused and reported as not restored; the copies are kept", async () => {
    const r = await repo();
    writeFileSync(join(r.root, ".gitignore"), "dist/\nsrc\n");
    git(r.root, "commit", "-q", "-am", "ignore src");
    const outside = join(r.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.txt"), "outside content\n");
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    rmSync(join(r.root, "src"), { recursive: true });
    symlinkSync(outside, join(r.root, "src"));
    const res = reconcileAfter(r.root, snap);
    expect(read(join(outside, "a.txt"))).toBe("outside content\n");
    expect(readdirSync(outside)).toEqual(["a.txt"]);
    expect(lstatSync(join(r.root, "src")).isSymbolicLink()).toBe(true);
    expect(res.reverted).toEqual([]);
    expect(res.notRestored.sort()).toEqual([
      expect.stringContaining("src/a.txt"),
      expect.stringContaining("src/b.txt"),
      expect.stringContaining("src/bin.dat"),
    ]);
    expect(res.notRestored[0]).toContain("symlink");
    expect(existsSync(bd)).toBe(true);
    expect(reconcileNote(res)).toContain("not restored");
  });

  it.skipIf(isWin)("R39: tracked files below a pre-existing symlink are not followed at snapshot time: they are skipped and named", async () => {
    const r = await repo();
    const outside = join(r.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.txt"), "outside content\n");
    rmSync(join(r.root, "src"), { recursive: true });
    symlinkSync(outside, join(r.root, "src"));
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    expect(snap.skipped).toEqual(expect.arrayContaining([expect.stringContaining("src/a.txt")]));
    writeFileSync(join(outside, "a.txt"), "changed through the link\n");
    const res = reconcileAfter(r.root, snap);
    expect(read(join(outside, "a.txt"))).toBe("changed through the link\n");
    expect(lstatSync(join(r.root, "src")).isSymbolicLink()).toBe(true);
    expect(res.reverted).toEqual([]);
    expect(res.skipped).toEqual(snap.skipped);
  });

  it.skipIf(isWin)("R39: backups are 0700 directories and 0600 files; symlinks are copied as symlinks", async () => {
    const r = await repo();
    writeFileSync(join(r.root, "src", "a.txt"), "dirty\n");
    chmodSync(join(r.root, "src", "a.txt"), 0o755);
    symlinkSync("a.txt", join(r.root, "src", "link"));
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    expect(statSync(bd).mode & 0o777).toBe(0o700);
    expect(statSync(join(bd, "before")).mode & 0o777).toBe(0o700);
    expect(statSync(join(bd, "before", "src")).mode & 0o777).toBe(0o700);
    expect(statSync(join(bd, "before", "src", "a.txt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(bd, "index")).mode & 0o777).toBe(0o600);
    expect(statSync(join(bd, MANIFEST_FILE)).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(bd, "before", "src", "link")).isSymbolicLink()).toBe(true);
    // The runner changes the mode and retargets the link: both are restored.
    chmodSync(join(r.root, "src", "a.txt"), 0o644);
    unlinkSync(join(r.root, "src", "link"));
    symlinkSync("b.txt", join(r.root, "src", "link"));
    const res = reconcileAfter(r.root, snap);
    expect(res.reverted.sort()).toEqual(["src/a.txt", "src/link"]);
    expect(statSync(join(r.root, "src", "a.txt")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(r.root, "src", "link"))).toBe("a.txt");
    expect(statSync(join(bd, "after")).mode & 0o777).toBe(0o700);
    expect(readlinkSync(join(bd, "after", "src", "link"))).toBe("b.txt");
  });

  it("R39: gitlinks (submodules) are skipped and named", async () => {
    const r = await repo();
    const head = git(r.root, "rev-parse", "HEAD");
    git(r.root, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/lib`);
    git(r.root, "commit", "-q", "-m", "gitlink");
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    expect(snap.skipped).toEqual(["vendor/lib (gitlink)"]);
    const res = reconcileAfter(r.root, snap);
    expect(res.skipped).toEqual(["vendor/lib (gitlink)"]);
    expect(reconcileNote(res)).toContain("vendor/lib");
  });

  it("nothing changed: an empty result, no note and no kept backup", async () => {
    const r = await repo();
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    const res = reconcileAfter(r.root, snap);
    expect(res).toMatchObject({ reverted: [], moved: [], notRestored: [], indexRestored: false });
    expect(reconcileNote(res)).toBeUndefined();
    expect(existsSync(bd)).toBe(false);
  });

  it("interrupted between snapshot and reconcile: the manifest on disk is enough to finish the job in a new process", async () => {
    const r = await repo();
    writeFileSync(join(r.root, "notes.txt"), "untracked notes\n");
    writeFileSync(join(r.root, "src", "a.txt"), "dirty a\n");
    const bd = r.backupDir();
    takeSnapshot(r.root, bd);
    const manifest = JSON.parse(read(join(bd, MANIFEST_FILE))) as Snapshot;
    expect(manifest).toMatchObject({ v: 1, status: "pending", root: r.root, backupDir: bd });
    // The manifest holds hashes and metadata, never file contents.
    expect(read(join(bd, MANIFEST_FILE))).not.toContain("dirty a");
    expect(read(join(bd, MANIFEST_FILE))).not.toContain("untracked notes");
    writeFileSync(join(r.root, "src", "a.txt"), "runner\n");
    writeFileSync(join(r.root, "notes.txt"), "runner\n");
    writeFileSync(join(r.root, "src", "b.txt"), "runner\n");
    writeFileSync(join(r.root, "created.txt"), "runner\n");
    const res = reconcileAfter(r.root, loadSnapshot(bd));
    expect(res.reverted.sort()).toEqual(["notes.txt", "src/a.txt", "src/b.txt"]);
    expect(res.moved).toEqual(["created.txt"]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("dirty a\n");
    expect(read(join(r.root, "notes.txt"))).toBe("untracked notes\n");
    expect(read(join(r.root, "src", "b.txt"))).toBe("b original\n");
    expect(loadSnapshot(bd).status).toBe("done");
  });

  it("a file the runner changed whose restore source does not match the snapshot is left untouched (nothing is overwritten) and reported", async () => {
    const r = await repo();
    writeFileSync(join(r.root, "src", "a.txt"), "dirty a\n");
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    writeFileSync(join(bd, "before", "src", "a.txt"), "tampered backup\n");
    writeFileSync(join(r.root, "src", "a.txt"), "runner\n");
    const res = reconcileAfter(r.root, snap);
    expect(res.notRestored).toEqual([expect.stringContaining("src/a.txt")]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("runner\n");
    expect(existsSync(bd)).toBe(true);
  });
});

describe("Reconciler (enforce wiring)", () => {
  it("snapshots per toolCallId, reconciles at that call's result with a note and a redacted ledger event; nested calls follow their parent", async () => {
    const r = await repo();
    const events: RunEvent[] = [];
    const ledger = { append: (e: RunEvent) => void events.push(RunEvent.parse(e)) };
    const rec = new Reconciler(r.runDir);
    rec.begin("call|1", undefined, r.root);
    writeFileSync(join(r.root, "src", "a.txt"), "parent change\n");
    rec.begin("nested-1", "call|1", r.root);
    writeFileSync(join(r.root, "src", "b.txt"), "nested change\n");
    expect(rec.size).toBe(2);
    const out = rec.finish({ toolCallId: "call|1", content: [{ type: "text", text: "tests passed" }], isError: false }, ledger, "run-1");
    expect(rec.size).toBe(0);
    const text = out?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    expect(text).toContain("tests passed");
    expect(text).toMatch(/Reverted on the answer route \(copies in .*reconcile.nested-1\): reverted src\/b\.txt/);
    expect(text).toMatch(/Reverted on the answer route \(copies in .*reconcile.call_1\): reverted src\/a\.txt/);
    const reconciled = events.filter((e) => e.type === "reconciled");
    // Innermost first: the nested call is reverted to its own snapshot, then the parent to its.
    expect(reconciled.map((e) => [e.toolCallId, e.reverted])).toEqual([
      ["nested-1", ["src/b.txt"]],
      ["call|1", ["src/a.txt"]],
    ]);
    expect(String((reconciled[1] as { backupDir: string }).backupDir)).toContain(join("reconcile", "call_1"));
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(read(join(r.root, "src", "b.txt"))).toBe("b original\n");
    expect(read(join(r.runDir, "reconcile", "nested-1", "after", "src", "b.txt"))).toBe("nested change\n");
    expect(read(join(r.runDir, "reconcile", "call_1", "after", "src", "a.txt"))).toBe("parent change\n");
  });

  it("finishAll reconciles calls whose result never came (another extension blocked them, or the agent settled)", async () => {
    const r = await repo();
    const events: RunEvent[] = [];
    const rec = new Reconciler(r.runDir);
    rec.begin("c1", undefined, r.root);
    writeFileSync(join(r.root, "README.md"), "runner\n");
    rec.finishAll({ append: (e) => void events.push(e) }, "run-1");
    expect(rec.size).toBe(0);
    expect(read(join(r.root, "README.md"))).toBe("readme\n");
    expect(events.map((e) => e.type)).toEqual(["reconciled"]);
  });

  it("discard drops a snapshot whose call never ran and removes its backup", async () => {
    const r = await repo();
    const rec = new Reconciler(r.runDir);
    const bd = rec.begin("c1", undefined, r.root);
    expect(existsSync(bd)).toBe(true);
    rec.discard("c1");
    expect(existsSync(bd)).toBe(false);
    expect(rec.size).toBe(0);
  });
});

describe("fix round 1", () => {
  it("I1: a replay after an interruption that began restoring never deletes preserved after/ content and reports the earlier operations", async () => {
    const r = await repo();
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    // The runner only creates a new file: once it is moved aside, nothing is left to restore.
    writeFileSync(join(r.root, "src", "new.txt"), "only copy of this content\n");
    let ops = 0;
    expect(() =>
      reconcileAfter(r.root, snap, {
        onOperation: () => {
          if (++ops === 1) throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");
    expect(existsSync(join(r.root, "src", "new.txt"))).toBe(false);
    expect(read(join(bd, "after", "src", "new.txt"))).toBe("only copy of this content\n");
    expect(loadSnapshot(bd).status).toBe("reconciling");

    const res = reconcileAfter(r.root, loadSnapshot(bd));
    expect(res.moved).toEqual(["src/new.txt"]);
    expect(res.backupRemoved).toBeUndefined();
    expect(read(join(bd, "after", "src", "new.txt"))).toBe("only copy of this content\n");
    expect(loadSnapshot(bd).status).toBe("done");
  });

  it("I1: a replay after a crash between a move aside and the restore finishes the restore and keeps every copy", async () => {
    const r = await repo();
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    writeFileSync(join(r.root, "src", "a.txt"), "runner a\n");
    writeFileSync(join(r.root, "src", "b.txt"), "runner b\n");
    writeFileSync(join(r.root, "created.txt"), "runner created\n");
    let ops = 0;
    expect(() =>
      reconcileAfter(r.root, snap, {
        onOperation: () => {
          if (++ops === 2) throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");
    const res = reconcileAfter(r.root, loadSnapshot(bd));
    expect(res.moved).toEqual(["created.txt"]);
    expect(res.reverted.sort()).toEqual(["src/a.txt", "src/b.txt"]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(read(join(r.root, "src", "b.txt"))).toBe("b original\n");
    expect(read(join(bd, "after", "created.txt"))).toBe("runner created\n");
    expect(read(join(bd, "after", "src", "a.txt"))).toBe("runner a\n");
    expect(read(join(bd, "after", "src", "b.txt"))).toBe("runner b\n");
  });

  it("I2: while another git command holds index.lock the current index is neither inspected nor copied nor replaced", async () => {
    const r = await repo();
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    git(r.root, "update-index", "--add", "--cacheinfo", `100644,${git(r.root, "rev-parse", "HEAD:README.md")},staged.txt`);
    const indexAfterRunner = readFileSync(join(r.root, ".git", "index"));
    writeFileSync(join(r.root, ".git", "index.lock"), "");
    const res = reconcileAfter(r.root, snap);
    expect(res.indexRestored).toBe(false);
    expect(res.notRestored).toEqual([expect.stringContaining("index.lock")]);
    expect(existsSync(join(bd, "after", "index"))).toBe(false);
    expect(readFileSync(join(r.root, ".git", "index")).equals(indexAfterRunner)).toBe(true);
    expect(read(join(r.root, ".git", "index.lock"))).toBe("");
  });

  it("I2: an index created by the runner (none at snapshot) is moved aside only under index.lock", async () => {
    const t = await makeTmp("reconcile-noindex");
    cleanups.push(t.cleanup);
    const root = join(realpathSync.native(t.dir), "project");
    mkdirSync(root);
    git(root, "init", "-q");
    expect(existsSync(join(root, ".git", "index"))).toBe(false);
    const bd = join(t.dir, "backup");
    const snap = takeSnapshot(root, bd);
    expect(snap.indexExisted).toBe(false);
    writeFileSync(join(root, "f.txt"), "f\n");
    git(root, "add", "f.txt");
    writeFileSync(join(root, ".git", "index.lock"), "");
    const held = reconcileAfter(root, snap);
    expect(held.notRestored).toEqual([expect.stringContaining("index.lock")]);
    expect(existsSync(join(root, ".git", "index"))).toBe(true);
    unlinkSync(join(root, ".git", "index.lock"));
    const res = reconcileAfter(root, loadSnapshot(bd));
    expect(res.indexRestored).toBe(true);
    expect(existsSync(join(root, ".git", "index"))).toBe(false);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    expect(existsSync(join(bd, "after", "index"))).toBe(true);
  });

  it.skipIf(isWin)("I3: entries moved into after/ by a same-filesystem rename get 0700 directories and 0600 files, descendants included, without following symlinks", async () => {
    const r = await repo();
    const outside = join(r.dir, "outside.txt");
    writeFileSync(outside, "outside\n");
    chmodSync(outside, 0o644);
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    // A tracked file replaced by a directory tree, and a new untracked tree.
    unlinkSync(join(r.root, "README.md"));
    mkdirSync(join(r.root, "README.md", "sub"), { recursive: true });
    writeFileSync(join(r.root, "README.md", "sub", "deep.txt"), "deep\n");
    chmodSync(join(r.root, "README.md", "sub", "deep.txt"), 0o755);
    symlinkSync(outside, join(r.root, "README.md", "sub", "link"));
    chmodSync(join(r.root, "README.md", "sub"), 0o755);
    mkdirSync(join(r.root, "gen"));
    writeFileSync(join(r.root, "gen", "x.txt"), "x\n");
    chmodSync(join(r.root, "gen", "x.txt"), 0o644);
    const res = reconcileAfter(r.root, snap);
    expect(res.notRestored).toEqual([]);
    const after = join(bd, "after");
    const modes: Array<[string, number]> = [];
    for (const rel of readdirSync(after, { recursive: true }) as string[]) {
      const st = lstatSync(join(after, rel));
      if (st.isSymbolicLink()) continue;
      modes.push([rel, st.mode & 0o777]);
      expect(st.mode & 0o777, rel).toBe(st.isDirectory() ? 0o700 : 0o600);
    }
    expect(modes.map(([p]) => p)).toEqual(expect.arrayContaining([join("README.md", "sub", "deep.txt"), join("gen", "x.txt")]));
    expect(lstatSync(join(after, "README.md", "sub", "link")).isSymbolicLink()).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it("I4: a ledger append failure is surfaced in the result and the diagnostics, also on a no-op reconcile, and the backup is kept", async () => {
    const r = await repo();
    const rec = new Reconciler(r.runDir);
    const failing = { append: () => { throw new Error("disk full"); } };
    const diagnostics: string[] = [];
    const bd = rec.begin("c1", undefined, r.root);
    const out = rec.finish({ toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false }, failing, "run-1", (m) => diagnostics.push(m));
    const text = JSON.stringify(out?.content);
    expect(text).toContain("could not be written to the run ledger");
    expect(text).toContain("disk full");
    expect(diagnostics).toEqual([expect.stringContaining("disk full")]);
    expect(existsSync(join(bd, MANIFEST_FILE))).toBe(true);

    const bd2 = rec.begin("c2", undefined, r.root);
    writeFileSync(join(r.root, "README.md"), "runner\n");
    const out2 = rec.finish({ toolCallId: "c2", content: [], isError: false }, failing, "run-1", (m) => diagnostics.push(m));
    expect(JSON.stringify(out2?.content)).toContain("could not be written to the run ledger");
    expect(JSON.stringify(out2?.content)).toContain("README.md");
    expect(existsSync(join(bd2, "after", "README.md"))).toBe(true);
    expect(diagnostics).toHaveLength(2);
  });

  it("I5: the result names every affected file, without a cap", async () => {
    const r = await repo();
    for (let i = 0; i < 150; i++) writeFileSync(join(r.root, "src", `t${i}.txt`), `t${i}\n`);
    git(r.root, "add", "-A");
    git(r.root, "commit", "-q", "-m", "many");
    const rec = new Reconciler(r.runDir);
    rec.begin("c1", undefined, r.root);
    for (let i = 0; i < 150; i++) writeFileSync(join(r.root, "src", `t${i}.txt`), "runner\n");
    for (let i = 0; i < 700; i++) writeFileSync(join(r.root, `new-${i}.txt`), "n\n");
    const out = rec.finish({ toolCallId: "c1", content: [], isError: false }, { append: () => undefined }, "run-1");
    const text = (out?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
    for (let i = 0; i < 150; i++) expect(text).toContain(`src/t${i}.txt`);
    for (let i = 0; i < 700; i++) expect(text).toContain(`new-${i}.txt`);
    expect(text).not.toContain("more (all listed in");
  });

  it.skipIf(isWin)("fix round 2: a new untracked hard link to an ignored executable is backed up as an independent 0600 copy; the executable keeps 0755", async () => {
    const r = await repo();
    mkdirSync(join(r.root, "dist"));
    const exe = join(r.root, "dist", "tool.sh");
    writeFileSync(exe, "#!/bin/sh\necho tool\n");
    chmodSync(exe, 0o755);
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    linkSync(exe, join(r.root, "linked.sh"));
    mkdirSync(join(r.root, "gen"));
    linkSync(exe, join(r.root, "gen", "inner.sh"));
    const res = reconcileAfter(r.root, snap);
    expect(res.moved.sort()).toEqual(["gen/inner.sh", "linked.sh"]);
    expect(statSync(exe).mode & 0o777).toBe(0o755);
    expect(statSync(exe).nlink).toBe(1);
    for (const copy of [join(bd, "after", "linked.sh"), join(bd, "after", "gen", "inner.sh")]) {
      const st = lstatSync(copy);
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.nlink).toBe(1);
      expect(read(copy)).toBe("#!/bin/sh\necho tool\n");
    }
  });

  it.skipIf(isWin)("fix round 2: a hard-linked file inside a moved directory is copied, not chmodded through the link", async () => {
    const r = await repo();
    const outside = join(r.dir, "outside.sh");
    writeFileSync(outside, "outside\n");
    chmodSync(outside, 0o755);
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    unlinkSync(join(r.root, "README.md"));
    mkdirSync(join(r.root, "README.md"));
    linkSync(outside, join(r.root, "README.md", "hard.sh"));
    const res = reconcileAfter(r.root, snap);
    expect(res.reverted).toEqual(["README.md"]);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
    const copy = join(bd, "after", "README.md", "hard.sh");
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(statSync(copy).nlink).toBe(1);
    expect(read(copy)).toBe("outside\n");
  });
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("Task 13: privatizeTree failures after a successful rename (Task 11 minor)", () => {
  it.skipIf(isWin || isRoot)("an owner-unreadable new file is moved aside, journaled and reported as moved, with the 0600 backup mode", async () => {
    const r = await repo();
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    const secret = join(r.root, "unreadable.txt");
    writeFileSync(secret, "only copy\n");
    chmodSync(secret, 0o000);
    const res = reconcileAfter(r.root, snap);
    expect(res.notRestored).toEqual([]);
    expect(res.moved).toEqual(["unreadable.txt"]);
    expect(res.warnings).toBeUndefined();
    const copy = join(bd, "after", "unreadable.txt");
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(read(copy)).toBe("only copy\n");
    expect(read(join(bd, JOURNAL_FILE))).toContain('"op":"moved","path":"unreadable.txt"');
  });

  it.skipIf(isWin || isRoot)("when the backup cannot be finished (unreadable and hard-linked) the entry is still reported as moved and journaled, with a warning naming the copy", async () => {
    const r = await repo();
    mkdirSync(join(r.root, "dist"));
    const ignored = join(r.root, "dist", "locked.bin");
    writeFileSync(ignored, "ignored\n");
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    linkSync(ignored, join(r.root, "linked.bin"));
    chmodSync(ignored, 0o000);
    try {
      const res = reconcileAfter(r.root, snap);
      const copy = join(bd, "after", "linked.bin");
      expect(res.moved).toEqual(["linked.bin"]);
      expect(res.notRestored).toEqual([]);
      expect(res.warnings).toEqual([expect.stringContaining(`linked.bin (set aside to ${copy}, but its backup could not be finished`)]);
      expect(reconcileNote(res)).toContain("set aside with an incomplete backup:");
      expect(read(join(bd, JOURNAL_FILE))).toContain('"op":"moved","path":"linked.bin"');
      // The other link keeps its mode: nothing was chmodded through the shared inode.
      expect(statSync(ignored).mode & 0o777).toBe(0o000);
      expect(existsSync(join(r.root, "linked.bin"))).toBe(false);
    } finally {
      chmodSync(ignored, 0o644);
    }
  });
});

describe("Task 13: replayInterrupted (startup replay of an interrupted run's reconciles)", () => {
  const sink = () => {
    const events: RunEvent[] = [];
    return { events, ledger: { append: (e: RunEvent) => void events.push(RunEvent.parse(e)) } };
  };

  it("a reconciling manifest is finished: journaled operations are merged and after/ content is kept", async () => {
    const r = await repo();
    const bd = join(r.runDir, "reconcile", "call-a");
    const snap = takeSnapshot(r.root, bd);
    writeFileSync(join(r.root, "new.txt"), "only copy\n");
    writeFileSync(join(r.root, "src", "a.txt"), "runner\n");
    let ops = 0;
    expect(() =>
      reconcileAfter(r.root, snap, {
        onOperation: () => {
          if (++ops === 1) throw new Error("killed");
        },
      }),
    ).toThrow("killed");
    expect(loadSnapshot(bd).status).toBe("reconciling");
    const s = sink();
    const out = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9");
    expect(out.map((o) => [o.kind, o.dir])).toEqual([["replayed", bd]]);
    expect(s.events).toEqual([expect.objectContaining({ type: "reconciled", toolCallId: "call-a", moved: ["new.txt"], reverted: ["src/a.txt"] })]);
    expect(read(join(bd, "after", "new.txt"))).toBe("only copy\n");
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(loadSnapshot(bd).status).toBe("done");
    // Done manifests are left alone on a later replay.
    expect(replayInterrupted(r.runDir, s.ledger, "20261104T130000Z-9")).toEqual([]);
  });

  it("a pending manifest whose runner changed nothing is audited and its redundant backup removed", async () => {
    const r = await repo();
    const bd = join(r.runDir, "reconcile", "call-b");
    takeSnapshot(r.root, bd);
    const s = sink();
    const out = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9");
    expect(out).toEqual([{ dir: bd, kind: "replayed", notes: [] }]);
    expect(s.events).toEqual([expect.objectContaining({ type: "reconciled", toolCallId: "call-b", backupRemoved: true })]);
    expect(existsSync(bd)).toBe(false);
  });

  it("a snapshot dir without manifest is removed unless it holds after*/journal content, which is kept and reported", async () => {
    const r = await repo();
    const base = join(r.runDir, "reconcile");
    mkdirSync(join(base, "torn", "before"), { recursive: true });
    mkdirSync(join(base, "odd", "after"), { recursive: true });
    writeFileSync(join(base, "odd", "after", "x"), "keep\n");
    const s = sink();
    const out = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9");
    expect(out.map((o) => [o.kind, o.dir])).toEqual([
      ["kept", join(base, "odd")],
      ["removed", join(base, "torn")],
    ]);
    expect(existsSync(join(base, "torn"))).toBe(false);
    expect(read(join(base, "odd", "after", "x"))).toBe("keep\n");
  });

  it("fix round 1 (I2): nested snapshots are replayed innermost first, by the persisted sequence, whatever the directory names", async () => {
    const r = await repo();
    const rec = new Reconciler(r.runDir);
    // Directory names sort parent first ("a_parent" < "z-child"): replaying by name would end at the parent's
    // intermediate content B instead of the original.
    rec.begin("a|parent", undefined, r.root);
    writeFileSync(join(r.root, "src", "a.txt"), "B parent intermediate\n");
    rec.begin("z-child", "a|parent", r.root);
    writeFileSync(join(r.root, "src", "a.txt"), "C child\n");
    // Killed: neither call got its tool_result.
    const parent = loadSnapshot(join(r.runDir, "reconcile", "a_parent"));
    const child = loadSnapshot(join(r.runDir, "reconcile", "z-child"));
    expect(parent).toMatchObject({ toolCallId: "a|parent", seq: 1 });
    expect(child).toMatchObject({ toolCallId: "z-child", parentToolCallId: "a|parent", seq: 2 });
    const s = sink();
    const out = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9");
    expect(out.map((o) => o.kind)).toEqual(["replayed", "replayed"]);
    expect(s.events.map((e) => (e.type === "reconciled" ? e.toolCallId : e.type))).toEqual(["z-child", "a|parent"]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(read(join(r.runDir, "reconcile", "z-child", "after", "src", "a.txt"))).toBe("C child\n");
    expect(read(join(r.runDir, "reconcile", "a_parent", "after", "src", "a.txt"))).toBe("B parent intermediate\n");
  });

  /** Nested parent (snapshot A = original) and child (snapshot B = the parent's intermediate), both killed. */
  async function nestedKilled() {
    const r = await repo();
    const rec = new Reconciler(r.runDir);
    rec.begin("a|parent", undefined, r.root);
    writeFileSync(join(r.root, "src", "a.txt"), "B parent intermediate\n");
    rec.begin("z-child", "a|parent", r.root);
    writeFileSync(join(r.root, "src", "a.txt"), "C child\n");
    return { r, parentDir: join(r.runDir, "reconcile", "a_parent"), childDir: join(r.runDir, "reconcile", "z-child") };
  }
  const reconciledIds = (events: RunEvent[]) => events.filter((e) => e.type === "reconciled").map((e) => (e.type === "reconciled" ? e.toolCallId : ""));

  it("fix round 2 (I2, R50.2): an unreadable child manifest stops the run's replay; the parent is not restored until the child replays first", async () => {
    const { r, parentDir, childDir } = await nestedKilled();
    const childManifest = join(childDir, "manifest.json");
    const good = read(childManifest);
    writeFileSync(childManifest, "{ torn");
    const s = sink();
    const diag: string[] = [];
    const out = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9", (m) => diag.push(m));
    // Nothing is replayed: the parent's snapshot A must not land before the child's B is undone.
    expect(reconciledIds(s.events)).toEqual([]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("C child\n");
    expect(loadSnapshot(parentDir).status).toBe("pending");
    expect(out.map((o) => [o.kind, o.dir])).toEqual([
      ["kept", childDir],
      ["kept", parentDir],
    ]);
    expect(out[1]?.notes.join("\n")).toMatch(/not replayed/);
    expect(s.events).toEqual([expect.objectContaining({ type: "error", where: "reconcile-replay" })]);
    // The child becomes readable: the whole tail replays in order, child then parent, and ends at A.
    writeFileSync(childManifest, good);
    const s2 = sink();
    replayInterrupted(r.runDir, s2.ledger, "20261104T130000Z-9");
    expect(reconciledIds(s2.events)).toEqual(["z-child", "a|parent"]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
    expect(loadSnapshot(parentDir).status).toBe("done");
    expect(loadSnapshot(childDir).status).toBe("done");
  });

  it("fix round 2 (I2, R50.2): a failed child replay stops the run's replay before its parent; the next replay retries child then parent", async () => {
    const { r, parentDir, childDir } = await nestedKilled();
    const childManifest = join(childDir, "manifest.json");
    const good = read(childManifest);
    const m = JSON.parse(good) as Record<string, unknown>;
    writeFileSync(childManifest, JSON.stringify({ ...m, root: join(r.root, "gone") }));
    const s = sink();
    const out = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9");
    expect(reconciledIds(s.events)).toEqual([]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("C child\n");
    expect(loadSnapshot(parentDir).status).toBe("pending");
    expect(out.map((o) => o.kind)).toEqual(["replayed", "kept"]);
    expect(out[0]?.notes.join("\n")).toContain("failed");
    writeFileSync(childManifest, good);
    const s2 = sink();
    replayInterrupted(r.runDir, s2.ledger, "20261104T130000Z-9");
    expect(reconciledIds(s2.events)).toEqual(["z-child", "a|parent"]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
  });

  it("fix round 1 (I2): manifests without a sequence (before this change) are replayed newest first by createdAt", async () => {
    const r = await repo();
    const base = join(r.runDir, "reconcile");
    const older = takeSnapshot(r.root, join(base, "a-older"));
    writeFileSync(join(r.root, "src", "a.txt"), "B intermediate\n");
    const newer = takeSnapshot(r.root, join(base, "z-newer"));
    writeFileSync(join(r.root, "src", "a.txt"), "C\n");
    // Pin distinct creation times (the snapshots can fall in the same millisecond).
    for (const [snap, at] of [[older, "2026-11-04T10:00:00.000Z"], [newer, "2026-11-04T10:00:01.000Z"]] as const) {
      const file = join(snap.backupDir, "manifest.json");
      const m = JSON.parse(read(file)) as Record<string, unknown>;
      delete m.seq;
      writeFileSync(file, JSON.stringify({ ...m, createdAt: at }));
    }
    const s = sink();
    replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9");
    expect(s.events.map((e) => (e.type === "reconciled" ? e.toolCallId : e.type))).toEqual(["z-newer", "a-older"]);
    expect(read(join(r.root, "src", "a.txt"))).toBe("a original\n");
  });

  it.skipIf(isWin || isRoot)("fix round 1 (I4): an unreadable reconcile directory is reported (notes, diagnostics, ledger error) and kept for a retry", async () => {
    const r = await repo();
    const bd = join(r.runDir, "reconcile", "call-x");
    takeSnapshot(r.root, bd);
    const base = join(r.runDir, "reconcile");
    chmodSync(base, 0o000);
    const s = sink();
    const diag: string[] = [];
    let out: ReturnType<typeof replayInterrupted>;
    try {
      out = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9", (m) => diag.push(m));
    } finally {
      chmodSync(base, 0o700);
    }
    expect(out).toEqual([{ dir: base, kind: "kept", notes: [expect.stringMatching(/cannot be read \(EACCES.*kept for a retry/)] }]);
    expect(diag).toEqual([expect.stringContaining("EACCES")]);
    expect(s.events).toEqual([expect.objectContaining({ type: "error", where: "reconcile-replay", message: expect.stringContaining("EACCES") })]);
    expect(loadSnapshot(bd).status).toBe("pending");
    // A missing directory is the only "nothing to do".
    rmSync(base, { recursive: true });
    expect(replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9")).toEqual([]);
  });

  it("a stale index.lock left by a SIGKILL is reported as index not checked and left in place", async () => {
    const r = await repo();
    const bd = join(r.runDir, "reconcile", "call-c");
    takeSnapshot(r.root, bd);
    git(r.root, "update-index", "--add", "--cacheinfo", `100644,${git(r.root, "rev-parse", "HEAD:README.md")},staged.txt`);
    const lock = join(r.root, ".git", "index.lock");
    writeFileSync(lock, "");
    const s = sink();
    const [out] = replayInterrupted(r.runDir, s.ledger, "20261104T120000Z-9");
    expect(out?.notes.join("\n")).toContain("index not checked");
    expect(s.events[0]).toMatchObject({ type: "reconciled", notRestored: [expect.stringContaining("index not checked")] });
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(bd)).toBe(true);
  });
});

describe("mergeReplayOrder (R61)", () => {
  const item = (run: string, seq: number, createdAt: string, mtime = 0): ReplayItem => ({
    runDir: `/runs/p/${run}`,
    name: `${run}-${seq}`,
    mtime,
    snapshot: { v: 1, status: "pending", createdAt, root: "/w", backupDir: `/runs/p/${run}/reconcile/${seq}`, indexFile: "/w/.git/index", indexExisted: true, tracked: [], untracked: [], skipped: [], seq },
  });
  const names = (xs: ReplayItem[]) => xs.map((x) => x.name);

  it("takes the latest snapshot across runs first, keeping each run's own order", () => {
    const older = [item("r1", 2, "2026-11-04T10:00:03.000Z"), item("r1", 1, "2026-11-04T10:00:01.000Z")];
    const newer = [item("r2", 2, "2026-11-04T10:00:02.000Z"), item("r2", 1, "2026-11-04T10:00:00.000Z")];
    expect(names(mergeReplayOrder([older, newer]))).toEqual(["r1-2", "r2-2", "r1-1", "r2-1"]);
  });

  it("breaks equal snapshot times by the later run, then by the run's own order; an unreadable time falls back to mtime", () => {
    const t = "2026-11-04T10:00:00.000Z";
    expect(names(mergeReplayOrder([[item("r1", 2, t), item("r1", 1, t)], [item("r2", 1, t)]]))).toEqual(["r2-1", "r1-2", "r1-1"]);
    expect(names(mergeReplayOrder([[item("r1", 1, "x", 5)], [item("r2", 1, "y", 3)]]))).toEqual(["r1-1", "r2-1"]);
  });

  it("keeps a run's order even when its clock disagrees (nested calls replay innermost first)", () => {
    const run = [item("r1", 2, "2026-11-04T10:00:00.000Z"), item("r1", 1, "2026-11-04T10:00:05.000Z")];
    expect(names(mergeReplayOrder([run]))).toEqual(["r1-2", "r1-1"]);
  });
});

describe("R60: new files are judged under the snapshot's ignore rules", () => {
  it("a runner that ignores `.factory/` and creates `.factory/config.json` has the file moved aside and `.gitignore` restored", async () => {
    const r = await repo();
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    writeFileSync(join(r.root, ".gitignore"), "dist/\n.factory/\n");
    mkdirSync(join(r.root, ".factory"));
    writeFileSync(join(r.root, ".factory", "config.json"), '{"commands":{}}\n');
    const res = reconcileAfter(r.root, snap);
    expect(read(join(r.root, ".gitignore"))).toBe("dist/\n");
    expect(existsSync(join(r.root, ".factory", "config.json"))).toBe(false);
    expect(read(join(bd, "after", ".factory", "config.json"))).toBe('{"commands":{}}\n');
    expect(res.reverted).toContain(".gitignore");
    expect(res.moved).toContain(".factory/config.json");
  });

  it("a runner that removes an ignore pattern does not get pre-existing ignored outputs moved aside", async () => {
    const r = await repo();
    mkdirSync(join(r.root, "dist"));
    writeFileSync(join(r.root, "dist", "out.js"), "built before\n");
    const snap = takeSnapshot(r.root, r.backupDir());
    writeFileSync(join(r.root, ".gitignore"), "");
    const res = reconcileAfter(r.root, snap);
    expect(read(join(r.root, ".gitignore"))).toBe("dist/\n");
    expect(read(join(r.root, "dist", "out.js"))).toBe("built before\n");
    expect(res.moved).toEqual([]);
    expect(res.reverted).toEqual([".gitignore"]);
  });

  it("a new nested .gitignore (even one that ignores itself) is moved aside, and the files it hid are moved aside too", async () => {
    const r = await repo();
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    writeFileSync(join(r.root, "src", ".gitignore"), "*\n");
    writeFileSync(join(r.root, "src", "hidden.txt"), "created by the runner\n");
    const res = reconcileAfter(r.root, snap);
    expect(existsSync(join(r.root, "src", ".gitignore"))).toBe(false);
    expect(existsSync(join(r.root, "src", "hidden.txt"))).toBe(false);
    expect(res.moved.sort()).toEqual(["src/.gitignore", "src/hidden.txt"]);
    expect(read(join(bd, "after", "src", "hidden.txt"))).toBe("created by the runner\n");
  });

  it("a new .gitignore inside an ignored output directory is an ignored output and stays", async () => {
    const r = await repo();
    const snap = takeSnapshot(r.root, r.backupDir());
    mkdirSync(join(r.root, "dist"));
    writeFileSync(join(r.root, "dist", ".gitignore"), "*\n");
    writeFileSync(join(r.root, "dist", "out.js"), "built\n");
    const res = reconcileAfter(r.root, snap);
    expect(read(join(r.root, "dist", ".gitignore"))).toBe("*\n");
    expect(read(join(r.root, "dist", "out.js"))).toBe("built\n");
    expect(res.moved).toEqual([]);
  });

  it("a pre-existing ignored .gitignore that the runner rewrites is restored, not moved aside", async () => {
    const r = await repo();
    mkdirSync(join(r.root, "gen"));
    writeFileSync(join(r.root, "gen", ".gitignore"), "*\n");
    writeFileSync(join(r.root, "gen", "keep.out"), "generated before\n");
    const snap = takeSnapshot(r.root, r.backupDir());
    writeFileSync(join(r.root, "gen", ".gitignore"), "");
    const res = reconcileAfter(r.root, snap);
    expect(read(join(r.root, "gen", ".gitignore"))).toBe("*\n");
    expect(read(join(r.root, "gen", "keep.out"))).toBe("generated before\n");
    expect(res.moved).toEqual([]);
    expect(res.reverted).toEqual(["gen/.gitignore"]);
  });

  it(".git/info/exclude is snapshotted and restored: a runner-added exclude does not hide its new file", async () => {
    const r = await repo();
    const exclude = join(r.root, ".git", "info", "exclude");
    const original = existsSync(exclude) ? read(exclude) : undefined;
    const bd = r.backupDir();
    const snap = takeSnapshot(r.root, bd);
    mkdirSync(join(r.root, ".git", "info"), { recursive: true });
    writeFileSync(exclude, `${original ?? ""}secret-drop.txt\n`);
    writeFileSync(join(r.root, "secret-drop.txt"), "created by the runner\n");
    const res = reconcileAfter(r.root, snap);
    expect(existsSync(exclude) ? read(exclude) : undefined).toBe(original);
    expect(existsSync(join(r.root, "secret-drop.txt"))).toBe(false);
    expect(res.moved).toContain("secret-drop.txt");
    expect(res.reverted).toContain("(.git/info/exclude)");
  });

  for (const snapshotHasExclude of [true, false]) {
    it.skipIf(isWin)(`R64: .git/info replaced by a symlink is never followed (${snapshotHasExclude ? "overwrite" : "delete"}); the reconcile throws and stays unfinished`, async () => {
      const r = await repo();
      const info = join(r.root, ".git", "info");
      mkdirSync(info, { recursive: true });
      const exclude = join(info, "exclude");
      if (snapshotHasExclude) writeFileSync(exclude, "# snapshot rules\n");
      else rmSync(exclude, { force: true });
      const bd = r.backupDir();
      const snap = takeSnapshot(r.root, bd);
      const outside = join(r.dir, "outside-info");
      mkdirSync(outside);
      writeFileSync(join(outside, "exclude"), ".factory/\n");
      rmSync(info, { recursive: true });
      symlinkSync(outside, info);
      mkdirSync(join(r.root, ".factory"));
      writeFileSync(join(r.root, ".factory", "config.json"), "{}\n");
      expect(() => reconcileAfter(r.root, snap)).toThrow(/not a real directory/);
      expect(read(join(outside, "exclude"))).toBe(".factory/\n");
      expect(readdirSync(outside)).toEqual(["exclude"]);
      expect(existsSync(join(r.root, ".factory", "config.json"))).toBe(true);
      expect(loadSnapshot(bd).status).not.toBe("done");
    });
  }

  it.skipIf(isWin)("N1: in a linked worktree, the common dir's parent replaced by a symlink after the snapshot is never followed; the reconcile throws and stays unfinished", async () => {
    const r = await repo();
    const wt = join(r.dir, "linked");
    git(r.root, "worktree", "add", "-q", "-b", "side", wt);
    const exclude = join(r.root, ".git", "info", "exclude");
    mkdirSync(join(r.root, ".git", "info"), { recursive: true });
    writeFileSync(exclude, "# snapshot rules\n");
    const bd = r.backupDir();
    const snap = takeSnapshot(wt, bd);
    const moved = join(r.dir, "project-moved");
    const outside = join(r.dir, "outside-copy");
    renameSync(r.root, moved);
    mkdirSync(join(outside, ".git", "info"), { recursive: true });
    writeFileSync(join(outside, ".git", "info", "exclude"), "outside rules\n");
    symlinkSync(outside, r.root);
    expect(() => reconcileAfter(wt, snap)).toThrow();
    expect(read(join(outside, ".git", "info", "exclude"))).toBe("outside rules\n");
    expect(loadSnapshot(bd).status).not.toBe("done");
  });

  it.skipIf(isWin)("R64: a snapshot refuses when .git/info is a symlink", async () => {
    const r = await repo();
    const info = join(r.root, ".git", "info");
    const outside = join(r.dir, "outside-info");
    mkdirSync(outside);
    rmSync(info, { recursive: true, force: true });
    symlinkSync(outside, info);
    expect(() => takeSnapshot(r.root, r.backupDir())).toThrow(/not a real directory/);
  });
});
