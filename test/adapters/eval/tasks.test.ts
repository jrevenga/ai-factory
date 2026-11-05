import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDir, evalPaths } from "../../../src/adapters/eval/paths.ts";
import { hashTree, loadTasks } from "../../../src/adapters/eval/tasks.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const FIX = resolve(import.meta.dirname, "../../fixtures/eval/tasks");

let tmp: Tmp;
beforeEach(async () => {
  tmp = await makeTmp("eval-tasks");
});
afterEach(async () => {
  await tmp.cleanup();
});

describe("evalPaths", () => {
  it("lives under FACTORY_HOME/eval", () => {
    const home = resolve(tmp.dir, "fh");
    const p = evalPaths({ FACTORY_HOME: home });
    const root = join(home, "eval");
    expect(p).toEqual({
      root,
      runs: join(root, "runs"),
      tasks: join(root, "tasks"),
      vault: { codex: join(root, "vault", "codex"), pi: join(root, "vault", "pi"), claudeToken: join(root, "vault", "claude-oauth-token") },
      tools: join(root, "tools"),
    });
  });

  it.skipIf(process.platform === "win32")("ensurePrivateDir creates 0700 directories", async () => {
    const dir = join(tmp.dir, "a", "b");
    await ensurePrivateDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(tmp.dir, "a"))).mode & 0o777).toBe(0o700);
  });
});

describe("loadTasks", () => {
  it("accepts a good root and reports the snapshot facts", () => {
    const [t, ...rest] = loadTasks([{ dir: join(FIX, "good"), source: "public" }]);
    expect(rest).toEqual([]);
    expect(t?.task.id).toBe("alpha");
    expect(t?.source).toBe("public");
    expect(t?.hasSolution).toBe(true);
    expect(t?.dir).toBe(join(FIX, "good", "alpha"));
    expect(t?.task.gate.maxContinuations).toBe(3);
  });

  it("rejects a schema violation and names the file", () => {
    expect(() => loadTasks([{ dir: join(FIX, "bad-schema"), source: "public" }])).toThrow(/broken[\\/]task\.json/);
  });

  it("rejects a duplicate id across roots and names both", () => {
    const run = () =>
      loadTasks([
        { dir: join(FIX, "good"), source: "public" },
        { dir: join(FIX, "dup"), source: "private" },
      ]);
    expect(run).toThrow(/alpha/);
    expect(run).toThrow(new RegExp(`${esc(join(FIX, "good", "alpha"))}.*${esc(join(FIX, "dup", "alpha"))}`));
  });

  it("skips a missing root", () => {
    expect(loadTasks([{ dir: join(tmp.dir, "nope"), source: "private" }])).toEqual([]);
  });

  it("rejects a dir snapshot without repo/", async () => {
    const root = join(tmp.dir, "root");
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(join(root, "alpha", "task.json"), await readFile(join(FIX, "good", "alpha", "task.json")));
    expect(() => loadTasks([{ dir: root, source: "private" }])).toThrow(/repo/);
  });

  it("rejects a task whose id differs from its directory name", async () => {
    const root = join(tmp.dir, "root");
    await mkdir(join(root, "other", "repo"), { recursive: true });
    await writeFile(join(root, "other", "task.json"), await readFile(join(FIX, "good", "alpha", "task.json")));
    expect(() => loadTasks([{ dir: root, source: "private" }])).toThrow(/other/);
  });

  it("accepts a git snapshot without repo/ and without solution/", async () => {
    const root = join(tmp.dir, "root");
    await mkdir(join(root, "gamma"), { recursive: true });
    const raw = JSON.parse(await readFile(join(FIX, "good", "alpha", "task.json"), "utf8"));
    raw.id = "gamma";
    raw.snapshot = { kind: "git", url: "https://example.invalid/r.git", ref: "a".repeat(40) };
    await writeFile(join(root, "gamma", "task.json"), JSON.stringify(raw));
    const [t] = loadTasks([{ dir: root, source: "private" }]);
    expect(t?.hasSolution).toBe(false);
  });
});

describe("hashTree", () => {
  it("is stable, content-sensitive and independent of creation order", async () => {
    const a = join(tmp.dir, "a");
    const b = join(tmp.dir, "b");
    await mkdir(join(a, "sub"), { recursive: true });
    await mkdir(join(b, "sub"), { recursive: true });
    await writeFile(join(a, "x.txt"), "one");
    await writeFile(join(a, "sub", "y.txt"), "two");
    await writeFile(join(b, "sub", "y.txt"), "two");
    await writeFile(join(b, "x.txt"), "one");
    expect(hashTree(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTree(a)).toBe(hashTree(b));
    await writeFile(join(b, "x.txt"), "ONE");
    expect(hashTree(a)).not.toBe(hashTree(b));
  });

  it("does not confuse a file boundary with file content", async () => {
    const a = join(tmp.dir, "a");
    const b = join(tmp.dir, "b");
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, "f"), "X");
    await writeFile(join(a, "g"), "Y");
    await writeFile(join(b, "f"), "Xg\0Y");
    expect(hashTree(a)).not.toBe(hashTree(b));
  });

  it("hashes the task fixtures deterministically", () => {
    expect(hashTree(join(FIX, "good", "alpha", "checks"))).toBe(hashTree(join(FIX, "good", "alpha", "checks")));
    expect(hashTree(join(FIX, "good", "alpha", "checks"))).not.toBe(hashTree(join(FIX, "good", "alpha", "repo")));
  });

  it.skipIf(process.platform === "win32")("hashes a symlink by its target text, never following it", async () => {
    const a = join(tmp.dir, "a");
    await mkdir(a);
    await writeFile(join(tmp.dir, "outside-1"), "same");
    await symlink(join(tmp.dir, "outside-1"), join(a, "l"));
    const h1 = hashTree(a);
    await writeFile(join(tmp.dir, "outside-1"), "changed");
    expect(hashTree(a)).toBe(h1);
    const b = join(tmp.dir, "b");
    await mkdir(b);
    await symlink(join(tmp.dir, "outside-2"), join(b, "l"));
    expect(hashTree(b)).not.toBe(h1);
  });
});

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
