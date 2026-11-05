import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBounded } from "../../../src/adapters/platform/process.ts";
import { bwrapUsable, type SandboxSpec } from "../../../src/adapters/eval/sandbox.ts";
import { loadTasks, type LoadedTask } from "../../../src/adapters/eval/tasks.ts";
import { controllerGit, controllerGitEnv } from "../../../src/adapters/eval/git-isolated.ts";
import { CheckResult } from "../../../src/core/eval/records.ts";
import { EvalTask } from "../../../src/core/eval/task.ts";
import { buildVerifyTree, diffStat, materialize, overlayChecks, runChecks } from "../../../src/adapters/eval/workspace.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const FIX = resolve(import.meta.dirname, "../../fixtures/eval/tasks");
const win = process.platform === "win32";
const bwrap = await bwrapUsable();

let tmp: Tmp;
let fixHome: Tmp;
let fixEnv: NodeJS.ProcessEnv;
beforeEach(async () => {
  tmp = await makeTmp("eval-ws");
  fixHome = await makeTmp("eval-ws-home");
  const emptyConfig = join(fixHome.dir, "empty-gitconfig");
  await writeFile(emptyConfig, "");
  fixEnv = { PATH: process.env.PATH, HOME: fixHome.dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, ...IDENT };
  for (const k of ["SystemRoot", "ComSpec", "TEMP", "TMP", "PATHEXT"]) if (process.env[k] !== undefined) fixEnv[k] = process.env[k];
});
afterEach(async () => {
  await tmp.cleanup();
  await fixHome.cleanup();
});

const IDENT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };

/** Plain git for building fixtures with an isolated HOME and git config; never used on anything an agent controls. */
async function plainGit(cwd: string, args: string[]): Promise<string> {
  const r = await runBounded("git", args, { cwd, env: fixEnv, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function dirTask(): LoadedTask {
  const [t] = loadTasks([{ dir: join(FIX, "good"), source: "public" }]);
  if (!t) throw new Error("fixture missing");
  return t;
}

async function setup(runName = "run") {
  const runDir = join(tmp.dir, runName);
  const m = await materialize(dirTask(), runDir);
  return { runDir, ...m, verify: join(runDir, "verify") };
}

describe("controllerGitEnv", () => {
  it("is minimal, isolated and drops inherited GIT_* variables", async () => {
    const saved = { ...process.env };
    process.env.GIT_DIR = "/nonexistent";
    process.env.GIT_INDEX_FILE = "/nonexistent/index";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = "/evil";
    process.env.AWS_SECRET_ACCESS_KEY = "nope";
    try {
      const scratch = join(tmp.dir, "scratch");
      const env = await controllerGitEnv(scratch);
      expect(Object.keys(env).filter((k) => k.startsWith("GIT_")).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(scratch, "empty-gitconfig"));
      expect(env.HOME).toBe(scratch);
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(await readFile(join(scratch, "empty-gitconfig"), "utf8")).toBe("");
      expect(await readdir(join(scratch, "no-hooks"))).toEqual([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("controllerGit ignores a hostile inherited environment", async () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(tmp.dir, "nonexistent");
    try {
      const scratch = join(tmp.dir, "scratch");
      const r = await controllerGit(["init", "-q", "-b", "main", join(tmp.dir, "r")], { cwd: tmp.dir, scratch });
      expect(r.code).toBe(0);
      expect(existsSync(join(tmp.dir, "r", ".git"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe("materialize", () => {
  it("is deterministic: same baseSha, one commit, ws is a copy of base", async () => {
    const a = await setup("a");
    const b = await setup("b");
    expect(a.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(a.baseSha).toBe(b.baseSha);
    expect(await plainGit(a.base, ["rev-list", "--all", "--count"])).toBe("1");
    expect(await plainGit(a.base, ["log", "-1", "--format=%an <%ae> %cn <%ce> %aI %cI"])).toBe(
      "factory-eval <eval@factory.invalid> factory-eval <eval@factory.invalid> 2026-01-01T00:00:00Z 2026-01-01T00:00:00Z",
    );
    expect(await plainGit(a.ws, ["rev-parse", "HEAD"])).toBe(a.baseSha);
    expect(await readFile(join(a.ws, "add.mjs"), "utf8")).toBe(await readFile(join(FIX, "good", "alpha", "repo", "add.mjs"), "utf8"));
    expect(existsSync(join(a.ws, "checks"))).toBe(false);
    expect(existsSync(join(a.ws, "solution"))).toBe(false);
  });

  it("does not copy a .git from a dir snapshot's repo/", async () => {
    const root = join(tmp.dir, "root");
    await mkdir(join(root, "alpha", "repo", ".git"), { recursive: true });
    await mkdir(join(root, "alpha", "repo", "sub", ".git"), { recursive: true });
    await writeFile(join(root, "alpha", "repo", ".git", "config"), "[core]\n\tfsmonitor = evil\n");
    await writeFile(join(root, "alpha", "repo", "sub", ".git", "x"), "x");
    await writeFile(join(root, "alpha", "repo", "sub", "keep.txt"), "k");
    await writeFile(join(root, "alpha", "task.json"), await readFile(join(FIX, "good", "alpha", "task.json")));
    const [t] = loadTasks([{ dir: root, source: "private" }]);
    const m = await materialize(t as LoadedTask, join(tmp.dir, "run"));
    expect(await readFile(join(m.base, ".git", "config"), "utf8")).not.toContain("evil");
    expect(existsSync(join(m.base, "sub", ".git"))).toBe(false);
    expect(existsSync(join(m.base, "sub", "keep.txt"))).toBe(true);
    expect(await plainGit(m.base, ["rev-list", "--all", "--count"])).toBe("1");
  });

  it("builds a git snapshot at ref without later history or the solution", async () => {
    const src = join(tmp.dir, "src");
    await mkdir(src);
    await plainGit(src, ["init", "-q", "-b", "main"]);
    await writeFile(join(src, "a.txt"), "hello\n");
    await plainGit(src, ["add", "-A"]);
    await plainGit(src, ["commit", "-q", "-m", "one"]);
    const ref = await plainGit(src, ["rev-parse", "HEAD"]);
    await writeFile(join(src, "SOLUTION.md"), "SECRET-SOLUTION-TEXT\n");
    await plainGit(src, ["add", "-A"]);
    await plainGit(src, ["commit", "-q", "-m", "two"]);

    const base = dirTask();
    const task = EvalTask.parse({ ...base.task, snapshot: { kind: "git", url: src, ref } });
    const m = await materialize({ ...base, task }, join(tmp.dir, "run"));

    expect(await plainGit(m.base, ["rev-list", "--all", "--count"])).toBe("1");
    expect(existsSync(join(m.base, "SOLUTION.md"))).toBe(false);
    expect(existsSync(join(m.ws, "SOLUTION.md"))).toBe(false);
    expect(await readFile(join(m.base, "a.txt"), "utf8")).toBe("hello\n");
    expect(m.baseSha).not.toBe(ref);
    const objs = (await plainGit(m.base, ["cat-file", "--batch-all-objects", "--batch-check"])).split("\n");
    for (const line of objs) {
      const [sha, type] = line.split(" ");
      if (type === "blob") expect(await plainGit(m.base, ["cat-file", "blob", sha as string])).not.toContain("SECRET-SOLUTION-TEXT");
    }
    // the temporary bare clone is gone
    expect(existsSync(join(tmp.dir, "run", ".ctl-git", "source.git"))).toBe(false);
  });
});

describe("buildVerifyTree and diffStat", () => {
  it("counts one modified and one new file; the result measures the agent's changes (diffStat is called before overlayChecks)", async () => {
    const s = await setup();
    await writeFile(join(s.ws, "add.mjs"), "export const add = (a, b) => a + b;\nexport const extra = 1;\n");
    await writeFile(join(s.ws, "new.txt"), "n1\nn2\nn3\n");
    await buildVerifyTree(s.base, s.ws, s.verify);

    const before = await diffStat(s.verify, s.baseSha);
    expect(before).toEqual({ files: 2, insertions: 5, deletions: 1 });

    await overlayChecks(dirTask(), s.verify, "all done\n");
    expect(existsSync(join(s.verify, "test", "sum.hidden.mjs"))).toBe(true);
    expect(await readFile(join(s.verify, ".eval", "final-message.txt"), "utf8")).toBe("all done\n");
    // the earlier result is the agent-only count; it is a plain value that the overlay cannot change
    expect(before).toEqual({ files: 2, insertions: 5, deletions: 1 });
  });

  it("excludes .eval from the stat", async () => {
    const s = await setup();
    await mkdir(join(s.ws, ".eval"));
    await writeFile(join(s.ws, ".eval", "x.txt"), "x");
    await buildVerifyTree(s.base, s.ws, s.verify);
    expect(await diffStat(s.verify, s.baseSha)).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("counts a binary file as one file and zero lines, and a deletion", async () => {
    const s = await setup();
    await writeFile(join(s.ws, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    await rm(join(s.ws, "add.mjs"));
    await buildVerifyTree(s.base, s.ws, s.verify);
    const st = await diffStat(s.verify, s.baseSha);
    expect(st.files).toBe(2);
    expect(st.insertions).toBe(0);
    expect(st.deletions).toBe(1);
  });

  it("replaces the worktree with ws, minus the top-level .git (and any nested .git)", async () => {
    const s = await setup();
    await writeFile(join(s.ws, "new.txt"), "n");
    await mkdir(join(s.ws, "sub", ".git"), { recursive: true });
    await writeFile(join(s.ws, "sub", ".git", "config"), "x");
    await writeFile(join(s.ws, "sub", "f.txt"), "f");
    await buildVerifyTree(s.base, s.ws, s.verify);
    expect(existsSync(join(s.verify, "new.txt"))).toBe(true);
    expect(existsSync(join(s.verify, "sub", "f.txt"))).toBe(true);
    expect(existsSync(join(s.verify, "sub", ".git"))).toBe(false);
    // verify/.git is the controller's clone of base, not ws's
    expect(await readFile(join(s.verify, ".git", "config"), "utf8")).toContain(s.base.replace(/\\/g, "/").split("/").pop() as string);
    expect(await plainGit(s.verify, ["rev-parse", "HEAD"])).toBe(s.baseSha);
  });

  it.skipIf(win)("copies a symlink as a symlink and never follows it", async () => {
    const s = await setup();
    const outside = join(tmp.dir, "outside.txt");
    await writeFile(outside, "outside-content");
    await symlink(outside, join(s.ws, "link"));
    await symlink("..", join(s.ws, "up"));
    await buildVerifyTree(s.base, s.ws, s.verify);
    expect((await lstat(join(s.verify, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(s.verify, "link"))).toBe(outside);
    expect(await readlink(join(s.verify, "up"))).toBe("..");
    expect(await readFile(outside, "utf8")).toBe("outside-content");
  });

  it.skipIf(win)("skips special files", async () => {
    const s = await setup();
    const r = await runBounded("mkfifo", [join(s.ws, "pipe")]);
    if (r.code !== 0) return;
    await buildVerifyTree(s.base, s.ws, s.verify);
    expect(existsSync(join(s.verify, "pipe"))).toBe(false);
  });

  it.skipIf(win)("overlayChecks never writes through a symlink planted by the agent", async () => {
    const s = await setup();
    const outside = join(tmp.dir, "outside-dir");
    await mkdir(outside);
    await symlink(outside, join(s.ws, "test")); // the withheld test/ files will be copied over this
    await symlink(join(tmp.dir, "victim"), join(s.ws, ".eval"));
    await buildVerifyTree(s.base, s.ws, s.verify);
    await overlayChecks(dirTask(), s.verify, "msg");
    expect(await readdir(outside)).toEqual([]);
    expect(existsSync(join(tmp.dir, "victim"))).toBe(false);
    expect((await lstat(join(s.verify, "test"))).isDirectory()).toBe(true);
    expect(await readFile(join(s.verify, "test", "sum.hidden.mjs"), "utf8")).toContain("add(1, 2)");
    expect(await readFile(join(s.verify, ".eval", "final-message.txt"), "utf8")).toBe("msg");
  });
});

/** Writes a node script that records that it ran, then behaves as a pass-through filter. */
async function markerScript(dir: string): Promise<string> {
  const script = join(dir, "mark.js");
  await writeFile(
    script,
    [
      "const fs = require('fs');",
      "fs.writeFileSync(process.argv[2], 'ran');",
      "if (process.argv[3] === 'pipe') process.stdin.pipe(process.stdout);",
      "",
    ].join("\n"),
  );
  return script;
}

const fwd = (p: string) => p.replace(/\\/g, "/");
const gq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Plants every executable git channel in ws/.git (the agent owns that directory). */
async function plantTraps(ws: string, markers: string): Promise<void> {
  await mkdir(markers, { recursive: true });
  const script = fwd(await markerScript(dirname(markers)));
  const node = fwd(process.execPath);
  const cmd = (name: string, pipe = false) => `"${node}" "${script}" "${fwd(join(markers, name))}"${pipe ? " pipe" : ""}`;
  const hooks = join(dirname(markers), "evil-hooks");
  await mkdir(hooks, { recursive: true });
  for (const h of ["post-checkout", "pre-commit", "post-commit", "pre-push"]) {
    const p = join(hooks, h);
    await writeFile(p, `#!/bin/sh\n${cmd(`hook-${h}`)}\n`);
    await chmod(p, 0o755);
  }
  const config = [
    "[filter \"evil\"]",
    `\tclean = ${gq(cmd("filter-clean", true))}`,
    `\tsmudge = ${gq(cmd("filter-smudge", true))}`,
    `\trequired = false`,
    "[diff \"evil\"]",
    `\ttextconv = ${gq(cmd("textconv", true))}`,
    "[core]",
    `\tfsmonitor = ${gq(cmd("fsmonitor"))}`,
    `\thooksPath = ${gq(fwd(hooks))}`,
    "",
  ].join("\n");
  const cfgPath = join(ws, ".git", "config");
  await writeFile(cfgPath, (await readFile(cfgPath, "utf8")) + "\n" + config);
  await writeFile(join(ws, ".gitattributes"), "* filter=evil diff=evil\n");
}

describe("C1 regression: agent-planted git configuration never executes on the controller", () => {
  it.skipIf(win)("sanity: the traps are armed (plain git on ws runs the planted filter)", async () => {
    const s = await setup();
    const markers = join(tmp.dir, "markers");
    await plantTraps(s.ws, markers);
    await writeFile(join(s.ws, "add.mjs"), "export const add = 1;\n");
    await runBounded("git", ["-C", s.ws, "add", "-A"], { env: fixEnv, timeoutMs: 30_000 });
    expect(existsSync(join(markers, "filter-clean"))).toBe(true);
  });

  it("materialize -> modify ws -> buildVerifyTree -> diffStat -> overlayChecks never runs anything planted", async () => {
    const s = await setup();
    const markers = join(tmp.dir, "markers");
    await plantTraps(s.ws, markers);
    await writeFile(join(s.ws, "add.mjs"), "export const add = (a, b) => a + b;\n");
    await writeFile(join(s.ws, "new.txt"), "new\n");

    await buildVerifyTree(s.base, s.ws, s.verify);
    const st = await diffStat(s.verify, s.baseSha);
    await overlayChecks(dirTask(), s.verify, "done");
    // the controller's own follow-up git calls on verify (as the orchestrator does) are inert too
    await controllerGit(["status", "--porcelain"], { cwd: s.verify, scratch: join(s.runDir, ".ctl-git") });
    await controllerGit(["diff", "--stat", s.baseSha], { cwd: s.verify, scratch: join(s.runDir, ".ctl-git") });

    expect(await readdir(markers)).toEqual([]);
    expect(st.files).toBe(3); // add.mjs, new.txt, .gitattributes
    // the agent's attributes file arrived as an ordinary file, its config did not
    expect(await readFile(join(s.verify, ".gitattributes"), "utf8")).toContain("filter=evil");
    expect(await readFile(join(s.verify, ".git", "config"), "utf8")).not.toContain("evil");
  });
});

describe("runChecks", () => {
  function taskWith(checks: { name: string; argv: string[]; timeoutSec?: number }[]): LoadedTask {
    const base = dirTask();
    return { ...base, task: EvalTask.parse({ ...base.task, checks }) };
  }

  it("reports pass, fail and timeout", async () => {
    const dir = join(tmp.dir, "v");
    await mkdir(dir);
    const t = taskWith([
      { name: "ok", argv: [process.execPath, "-e", "process.exit(0)"] },
      { name: "bad", argv: [process.execPath, "-e", "process.exit(3)"] },
      { name: "slow", argv: [process.execPath, "-e", "setTimeout(()=>{},60000)"], timeoutSec: 1 },
    ]);
    const res = await runChecks(t, dir, null);
    expect(res.map((r) => [r.name, r.pass, r.exitCode, r.timedOut])).toEqual([
      ["ok", true, 0, false],
      ["bad", false, 3, false],
      ["slow", false, null, true],
    ]);
    for (const r of res) expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(res[2]?.ms).toBeGreaterThanOrEqual(900);
  });

  it("runs the argv without a shell in the verify dir", async () => {
    const dir = join(tmp.dir, "v");
    await mkdir(dir);
    const t = taskWith([
      { name: "cwd", argv: [process.execPath, "-e", "require('fs').writeFileSync('cwd.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }))", "a b", "$HOME;x"] },
    ]);
    const res = await runChecks(t, dir, null);
    expect(res[0]?.pass).toBe(true);
    const seen = JSON.parse(await readFile(join(dir, "cwd.json"), "utf8")) as { cwd: string; args: string[] };
    expect(await realpathOf(seen.cwd)).toBe(await realpathOf(dir));
    expect(seen.args).toEqual(["a b", "$HOME;x"]);
  });

  it("does not hand the controller's environment to the check", async () => {
    const dir = join(tmp.dir, "v");
    await mkdir(dir);
    process.env.EVAL_TEST_SECRET = "s3cret";
    try {
      const t = taskWith([{ name: "env", argv: [process.execPath, "-e", "process.exit(process.env.EVAL_TEST_SECRET === undefined ? 0 : 9)"] }]);
      expect((await runChecks(t, dir, null))[0]?.pass).toBe(true);
    } finally {
      delete process.env.EVAL_TEST_SECRET;
    }
  });

  it.skipIf(win)("leaves no orphan behind a timed-out check", async () => {
    const dir = join(tmp.dir, "v");
    await mkdir(dir);
    const pidFile = join(dir, "grandchild.pid");
    const script = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},60000)`;
    const t = taskWith([{ name: "hang", argv: [process.execPath, "-e", script], timeoutSec: 1 }]);
    const res = await runChecks(t, dir, null);
    expect(res[0]?.timedOut).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("reports a check that cannot start as a canonical failed result plus one diagnostic (R80)", async () => {
    const dir = join(tmp.dir, "v");
    await mkdir(dir);
    const t = taskWith([{ name: "missing", argv: [join(tmp.dir, "no-such-program")] }]);
    const diagnostics: [string, string][] = [];
    const res = await runChecks(t, dir, null, (name, message) => diagnostics.push([name, message]));
    expect(res).toHaveLength(1);
    const parsed = CheckResult.safeParse(res[0]);
    expect(parsed.success).toBe(true);
    expect(res[0]).toMatchObject({ name: "missing", pass: false, exitCode: null, timedOut: false });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.[0]).toBe("missing");
    expect(diagnostics[0]?.[1]).not.toBe("");
  });

  it.skipIf(!bwrap.ok)("runs sandboxed checks in the verify dir whatever cwd the spec carries", async () => {
    const dir = join(tmp.dir, "v");
    const other = join(tmp.dir, "other");
    await mkdir(dir);
    await mkdir(other);
    await writeFile(join(dir, "only-in-verify.txt"), "v");
    const spec: SandboxSpec = { hide: [], roBinds: [], rwBinds: [other], cwd: other, network: false };
    const t = taskWith([{ name: "here", argv: [process.execPath, "-e", "process.exit(require('fs').existsSync('only-in-verify.txt') ? 0 : 6)"] }]);
    const res = await runChecks(t, dir, spec);
    expect(res.map((r) => [r.name, r.pass, r.exitCode])).toEqual([["here", true, 0]]);
  });

  it.skipIf(!bwrap.ok)("runs under bubblewrap without network when given a sandbox spec", async () => {
    const dir = join(tmp.dir, "v");
    await mkdir(dir);
    const spec: SandboxSpec = { hide: [], roBinds: [], rwBinds: [dir], cwd: dir, network: true };
    const outsideFile = join(tmp.dir, "outside.txt");
    await writeFile(outsideFile, "x");
    const t = taskWith([
      // /tmp is a tmpfs inside the sandbox, so the host file is invisible, while the rw-bound cwd is shared
      { name: "fs", argv: [process.execPath, "-e", `require('fs').writeFileSync('w.txt','y');process.exit(require('fs').existsSync(${JSON.stringify(outsideFile)})?4:0)`] },
      { name: "net", argv: [process.execPath, "-e", "const n=require('os').networkInterfaces();process.exit(Object.keys(n).filter(k=>k!=='lo').length===0?0:5)"] },
    ]);
    const res = await runChecks(t, dir, spec);
    expect(res.map((r) => [r.name, r.pass])).toEqual([
      ["fs", true],
      ["net", true],
    ]);
    expect(await readFile(join(dir, "w.txt"), "utf8")).toBe("y");
  });
});

describe("run directory modes", () => {
  it.skipIf(win)("materialize and buildVerifyTree create runDir, scratch, base, ws and verify as 0700 under a permissive umask", async () => {
    const old = process.umask(0o022);
    try {
      const s = await setup("modes");
      await buildVerifyTree(s.base, s.ws, s.verify);
      for (const d of [s.runDir, join(s.runDir, ".ctl-git"), s.base, s.ws, s.verify]) {
        expect([d, (await stat(d)).mode & 0o777]).toEqual([d, 0o700]);
      }
    } finally {
      process.umask(old);
    }
  });
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(p);
}
