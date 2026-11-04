import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  loadSnapshot,
  MANIFEST_FILE,
  reconcileAfter,
  reconcileNote,
  Reconciler,
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
    expect(readlinkSync(join(bd, "after", "c.txt"))).toBe("src/b.txt");
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
