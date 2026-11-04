import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MachinePostChecks, setRoute } from "../../../../src/adapters/pi/extension/enforce.ts";
import { ROUTE_ENTRY } from "../../../../src/adapters/pi/extension/route-state.ts";
import { commitCheckpoint, registerTaskState, TASK_PROGRESS_TOOL, type TaskSession } from "../../../../src/adapters/pi/extension/task-state.ts";
import { RunEvent } from "../../../../src/core/ledger/events.ts";
import { INITIAL_ROUTE } from "../../../../src/core/route/route.ts";
import type { RouteState } from "../../../../src/core/route/types.ts";
import { MACHINE_CLOSE, MACHINE_OPEN, parseMachine } from "../../../../src/core/task/machine.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const isWin = process.platform === "win32";
const RUN_ID = "20261104T100000Z-1";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRoute(INITIAL_ROUTE);
  for (const c of cleanups.splice(0)) await c();
});

// The code under test inherits the process env: keep the developer's git config out of it.
beforeAll(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", isWin ? "NUL" : "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

const TASK_TEXT = "---\nid: t1\ntitle: Add search\n---\n# Add search\n\nNotes.\n";

/** A repository (identity in its local config) with a worktree on factory/t1 holding the task file. */
async function world(opts: { taskText?: string | null } = {}) {
  const t = await makeTmp("task-state");
  cleanups.push(t.cleanup);
  const dir = realpathSync.native(t.dir);
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q");
  git(project, "config", "user.name", "Factory Test");
  git(project, "config", "user.email", "factory-test@example.invalid");
  writeFileSync(join(project, "README.md"), "x\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "init");
  const wt = join(dir, "wt");
  git(project, "worktree", "add", "-q", "-b", "factory/t1", wt);
  const taskFile = join(wt, ".factory", "knowledge", "tasks", "t1.md");
  if (opts.taskText !== null) {
    mkdirSync(join(wt, ".factory", "knowledge", "tasks"), { recursive: true });
    writeFileSync(taskFile, opts.taskText ?? TASK_TEXT);
  }
  const base = git(wt, "rev-parse", "HEAD");
  const feature: RouteState = {
    route: "feature",
    tier: "feature",
    taskId: "t1",
    reason: "add search",
    worktree: wt,
    writeRoots: [wt],
    needsReclassification: false,
    base,
  };
  const small: RouteState = { route: "small", tier: "small", taskId: "fix-1", reason: "fix a typo", writeRoots: [project], needsReclassification: false, base };
  return { dir, project, wt, taskFile, base, feature, small };
}

interface ToolLike {
  name: string;
  executionMode?: string;
  parameters: unknown;
  execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; details: unknown }>;
}

async function wired(opts: { taskText?: string | null; session?: boolean; effectiveTools?: () => Array<{ name: string; parameters: unknown }> } = {}) {
  const w = await world(opts);
  const tools: ToolLike[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const events: RunEvent[] = [];
  const pi = {
    on: () => () => undefined,
    registerTool: (t: ToolLike) => void tools.push(t),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
    getAllTools: () => (opts.effectiveTools ? opts.effectiveTools() : tools.map((t) => ({ name: t.name, parameters: t.parameters }))),
  };
  const postChecks = new MachinePostChecks();
  const session: TaskSession = {
    ledger: { append: (e) => void events.push(RunEvent.parse(e)) },
    runId: RUN_ID,
    projectRoot: w.project,
    home: join(w.dir, "home"),
    piAgentDir: join(w.dir, "pi agent"),
    postChecks,
  };
  const factoryTools = new Set<string>();
  const handle = registerTaskState(pi as never, { session: async () => (opts.session === false ? undefined : session), factoryTools });
  const tool = tools.find((t) => t.name === TASK_PROGRESS_TOOL)!;
  const progress = (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, {});
  return { ...w, tools, tool, entries, events, postChecks, factoryTools, handle, progress };
}

const machineOf = (file: string) => {
  const p = parseMachine(readFileSync(file, "utf8"));
  if (p === undefined || "invalid" in p) throw new Error("no valid machine section");
  return p.fields;
};

describe("task_progress registration", () => {
  it("registers task_progress as a sequential factory tool", async () => {
    const x = await wired();
    expect(x.tools.map((t) => t.name)).toEqual([TASK_PROGRESS_TOOL]);
    expect(x.tool.executionMode).toBe("sequential");
    expect(x.factoryTools.has(TASK_PROGRESS_TOOL)).toBe(true);
  });

  it("M2: task_progress stays a factory tool only while the effective definition is this extension's", async () => {
    const ours = await wired();
    ours.handle.verifyTools();
    expect(ours.factoryTools.has(TASK_PROGRESS_TOOL)).toBe(true);
    const shadowed = await wired({ effectiveTools: () => [{ name: TASK_PROGRESS_TOOL, parameters: { type: "object" } }] });
    shadowed.handle.verifyTools();
    expect(shadowed.factoryTools.has(TASK_PROGRESS_TOOL)).toBe(false);
  });
});

describe("task_progress on feature/project routes", () => {
  it("a checkpoint commits in the task worktree only and writes checkpoint: <sha> into the machine section", async () => {
    const x = await wired();
    setRoute(x.feature);
    writeFileSync(join(x.wt, "search.ts"), "export const search = 1;\n");
    const mainBefore = git(x.project, "rev-parse", "main");
    const statusBefore = git(x.project, "status", "--porcelain");

    const r = await x.progress({ phase: "implement", item: "search module", checkpoint: true, message: "search skeleton" });
    expect(r.isError).not.toBe(true);

    const sha = git(x.wt, "rev-parse", "HEAD");
    expect(sha).not.toBe(x.base);
    expect(git(x.wt, "rev-parse", "HEAD~1")).toBe(x.base);
    expect(git(x.wt, "log", "-1", "--format=%s%n%b")).toBe("factory checkpoint: t1 implement\nsearch skeleton");
    expect(git(x.wt, "log", "-1", "--format=%an <%ae>")).toBe("Factory Test <factory-test@example.invalid>");
    expect(git(x.wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([".factory/knowledge/tasks/t1.md", "search.ts"]);
    expect(git(x.wt, "branch", "--show-current")).toBe("factory/t1");
    // The user's repository: branch and working tree untouched.
    expect(git(x.project, "rev-parse", "main")).toBe(mainBefore);
    expect(git(x.project, "branch", "--show-current")).toBe("main");
    expect(git(x.project, "status", "--porcelain")).toBe(statusBefore);

    expect(machineOf(x.taskFile)).toEqual({ phase: "implement", base: x.base, checkpoint: sha, worktree: x.wt, run: RUN_ID });
    expect(r.content[0]?.text).toContain(sha.slice(0, 12));
    expect(x.events.map((e) => e.type)).toEqual(["progress", "checkpoint"]);
    expect(x.events[0]).toMatchObject({ type: "progress", taskId: "t1", phase: "implement", item: "search module" });
    expect(x.events[1]).toMatchObject({ type: "checkpoint", taskId: "t1", sha, kind: "commit" });
  });

  it("creates the machine section after the frontmatter when absent, keeping the rest of the file", async () => {
    const x = await wired();
    setRoute(x.feature);
    const r = await x.progress({ phase: "plan" });
    expect(r.isError).not.toBe(true);
    const text = readFileSync(x.taskFile, "utf8");
    expect(text).toBe(`---\nid: t1\ntitle: Add search\n---\n${MACHINE_OPEN}\nphase: plan · base: ${x.base} · worktree: ${x.wt} · run: ${RUN_ID}\n${MACHINE_CLOSE}\n\n# Add search\n\nNotes.\n`);
    // No checkpoint: nothing committed.
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
    expect(x.events.map((e) => e.type)).toEqual(["progress"]);
  });

  it("updates an existing section in place, keeps its checkpoint and CRLF line endings", async () => {
    const crlf = `---\r\nid: t1\r\n---\r\n${MACHINE_OPEN}\r\nphase: plan · checkpoint: ${"a".repeat(40)}\r\n${MACHINE_CLOSE}\r\n\r\n# T\r\n`;
    const x = await wired({ taskText: crlf });
    setRoute(x.feature);
    expect((await x.progress({ phase: "implement" })).isError).not.toBe(true);
    const text = readFileSync(x.taskFile, "utf8");
    expect(text).toBe(
      `---\r\nid: t1\r\n---\r\n${MACHINE_OPEN}\r\nphase: implement · base: ${x.base} · checkpoint: ${"a".repeat(40)} · worktree: ${x.wt} · run: ${RUN_ID}\r\n${MACHINE_CLOSE}\r\n\r\n# T\r\n`,
    );
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("redacts the item in the ledger", async () => {
    const x = await wired();
    setRoute(x.feature);
    await x.progress({ item: `wire token=${TOKEN}` });
    const ev = x.events[0] as { item?: string };
    expect(ev.item).toBeDefined();
    expect(ev.item).not.toContain(TOKEN);
  });

  it("refuses when the task file does not exist", async () => {
    const x = await wired({ taskText: null });
    setRoute(x.feature);
    const r = await x.progress({ phase: "plan", checkpoint: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain(".factory/knowledge/tasks/t1.md");
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
    expect(x.events).toEqual([]);
  });

  it("refuses an ambiguous machine section and an unrepresentable phase before committing anything", async () => {
    const x = await wired({ taskText: `# T\n${MACHINE_OPEN}\nphase: a\n${MACHINE_CLOSE}\n${MACHINE_OPEN}\n${MACHINE_CLOSE}\n` });
    setRoute(x.feature);
    writeFileSync(join(x.wt, "a.ts"), "1\n");
    const bad = await x.progress({ phase: "plan", checkpoint: true });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/machine section/);
    writeFileSync(x.taskFile, TASK_TEXT);
    const multi = await x.progress({ phase: "a\nb", checkpoint: true });
    expect(multi.isError).toBe(true);
    const sep = await x.progress({ phase: "a · b", checkpoint: true });
    expect(sep.isError).toBe(true);
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
    expect(x.events).toEqual([]);
  });

  it("refuses a checkpoint when the worktree is no longer on factory/<taskId>", async () => {
    const x = await wired();
    setRoute(x.feature);
    git(x.wt, "switch", "-q", "-c", "elsewhere");
    const r = await x.progress({ checkpoint: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("factory/t1");
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
  });

  // Hook scripts need a POSIX shell shebang; the hooksPath override itself is platform independent.
  it.skipIf(isWin)("does not run repository hooks for checkpoint commits", async () => {
    const x = await wired();
    setRoute(x.feature);
    const hooks = join(x.project, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const marker = join(x.dir, "hook-ran");
    for (const name of ["pre-commit", "post-commit", "commit-msg"]) {
      writeFileSync(join(hooks, name), `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
      chmodSync(join(hooks, name), 0o755);
    }
    const r = await x.progress({ checkpoint: true });
    expect(r.isError).not.toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(x.wt, "rev-parse", "HEAD")).not.toBe(x.base);
  });

  it("a checkpoint without changes since the last commit records HEAD", async () => {
    const x = await wired();
    setRoute(x.feature);
    git(x.wt, "add", "-A");
    git(x.wt, "commit", "-q", "-m", "task file");
    const head = git(x.wt, "rev-parse", "HEAD");
    const r = await x.progress({ checkpoint: true });
    // The task file holds no machine section yet, so the first checkpoint has nothing new to commit.
    expect(r.isError).not.toBe(true);
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(head);
    expect(machineOf(x.taskFile).checkpoint).toBe(head);
  });

  it.skipIf(isWin)("M6: a repository-config core.hooksPath (husky style, inside the worktree) is overridden too", async () => {
    const x = await wired();
    setRoute(x.feature);
    git(x.project, "config", "core.hooksPath", ".husky");
    const marker = join(x.dir, "husky-ran");
    mkdirSync(join(x.wt, ".husky"), { recursive: true });
    for (const name of ["pre-commit", "post-commit"]) {
      writeFileSync(join(x.wt, ".husky", name), `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
      chmodSync(join(x.wt, ".husky", name), 0o755);
    }
    const r = await x.progress({ checkpoint: true });
    expect(r.isError).not.toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(x.wt, "rev-parse", "HEAD")).not.toBe(x.base);
  });

  it("I1: a symlinked .factory directory is refused and the link target is not written", async () => {
    const x = await wired({ taskText: null });
    setRoute(x.feature);
    const outside = join(x.dir, "outside");
    mkdirSync(join(outside, "knowledge", "tasks"), { recursive: true });
    writeFileSync(join(outside, "knowledge", "tasks", "t1.md"), TASK_TEXT);
    symlinkSync(outside, join(x.wt, ".factory"), isWin ? "junction" : "dir");
    const r = await x.progress({ phase: "plan", checkpoint: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/symbolic link|outside the worktree/);
    expect(readFileSync(join(outside, "knowledge", "tasks", "t1.md"), "utf8")).toBe(TASK_TEXT);
    expect(readdirSync(join(outside, "knowledge", "tasks"))).toEqual(["t1.md"]);
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
    expect(x.events).toEqual([]);
  });

  it.skipIf(isWin)("I1: a symlinked task file is refused; the target is unchanged and nothing is copied into the worktree", async () => {
    const x = await wired({ taskText: null });
    setRoute(x.feature);
    const secret = join(x.dir, "secret.txt");
    writeFileSync(secret, "AWS_SECRET=abc\n");
    mkdirSync(join(x.wt, ".factory", "knowledge", "tasks"), { recursive: true });
    symlinkSync(secret, x.taskFile, "file");
    const r = await x.progress({ phase: "plan", checkpoint: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/regular file/);
    expect(readFileSync(secret, "utf8")).toBe("AWS_SECRET=abc\n");
    expect(lstatSync(x.taskFile).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(x.wt, ".factory", "knowledge", "tasks"))).toEqual(["t1.md"]);
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
  });

  it("R34: a checkpoint never stores secret-path files in git objects and names them; .env.example is committed", async () => {
    const x = await wired();
    setRoute(x.feature);
    // A tracked secret file (committed with the task file before the checkpoint) that is then modified.
    writeFileSync(join(x.wt, ".npmrc"), "registry=x\n");
    git(x.wt, "add", "-A");
    git(x.wt, "commit", "-q", "-m", "tracked npmrc");
    const committedBase = git(x.wt, "rev-parse", "HEAD");
    writeFileSync(join(x.wt, ".npmrc"), "//registry/:_authToken=npm_SECRETVALUE1\n");
    writeFileSync(join(x.wt, ".env"), "TOKEN=supersecret-env\n");
    mkdirSync(join(x.wt, "certs"));
    writeFileSync(join(x.wt, "certs", "key.pem"), "-----BEGIN PRIVATE KEY-----\nabc-pem-secret\n");
    writeFileSync(join(x.wt, ".env.example"), "TOKEN=\n");
    writeFileSync(join(x.wt, "app.ts"), "export {};\n");
    const blob = (text: string) => execFileSync("git", ["hash-object", "--stdin"], { cwd: x.wt, input: text, encoding: "utf8", env: GIT_ENV }).trim();
    const secretBlobs = [blob("//registry/:_authToken=npm_SECRETVALUE1\n"), blob("TOKEN=supersecret-env\n"), blob("-----BEGIN PRIVATE KEY-----\nabc-pem-secret\n")];

    const r = await x.progress({ checkpoint: true });
    expect(r.isError).not.toBe(true);
    expect(git(x.wt, "rev-parse", "HEAD~1")).toBe(committedBase);
    expect(git(x.wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([".env.example", "app.ts"]);
    for (const b of secretBlobs) {
      expect(() => execFileSync("git", ["cat-file", "-e", b], { cwd: x.wt, env: GIT_ENV, stdio: "ignore" })).toThrow();
    }
    const text = r.content[0]?.text ?? "";
    for (const f of [".env", ".npmrc", "certs/key.pem"]) expect(text).toContain(f);
    const cp = x.events.find((e) => e.type === "checkpoint") as { excluded?: string[] } | undefined;
    expect(cp?.excluded?.sort()).toEqual([".env", ".npmrc", "certs/key.pem"]);
    // The secret files stay as they are in the working tree.
    expect(readFileSync(join(x.wt, ".env"), "utf8")).toBe("TOKEN=supersecret-env\n");
    expect(git(x.wt, "status", "--porcelain")).toContain("?? .env");
  });

  const blobOf = (cwd: string, text: string) => execFileSync("git", ["hash-object", "--stdin"], { cwd, input: text, encoding: "utf8", env: GIT_ENV }).trim();
  const hasObject = (cwd: string, sha: string) => {
    try {
      execFileSync("git", ["cat-file", "-e", sha], { cwd, env: GIT_ENV, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it("R2-1: a tracked file replaced by a directory holding a secret does not let the secret in through the deletion", async () => {
    const x = await wired();
    setRoute(x.feature);
    writeFileSync(join(x.wt, "conf"), "plain\n");
    git(x.wt, "add", "-A");
    git(x.wt, "commit", "-q", "-m", "tracked conf");
    rmSync(join(x.wt, "conf"));
    mkdirSync(join(x.wt, "conf"));
    writeFileSync(join(x.wt, "conf", ".env"), "TOKEN=dir-secret-1\n");
    writeFileSync(join(x.wt, "conf", "ok.ts"), "export {};\n");
    const r = await x.progress({ checkpoint: true });
    expect(r.isError).not.toBe(true);
    expect(git(x.wt, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual(["A\tconf/ok.ts", "D\tconf"]);
    expect(hasObject(x.wt, blobOf(x.wt, "TOKEN=dir-secret-1\n"))).toBe(false);
    const cp = x.events.find((e) => e.type === "checkpoint") as { excluded?: string[] } | undefined;
    expect(cp?.excluded).toEqual(["conf/.env"]);
    expect(git(x.wt, "status", "--porcelain")).toContain("?? conf/.env");
  });

  it.skipIf(isWin)("R2-1: a tracked symlink replaced by a directory holding a secret keeps the secret out", async () => {
    const x = await wired();
    setRoute(x.feature);
    symlinkSync("elsewhere", join(x.wt, "certs"));
    git(x.wt, "add", "-A");
    git(x.wt, "commit", "-q", "-m", "tracked link");
    rmSync(join(x.wt, "certs"));
    mkdirSync(join(x.wt, "certs"));
    writeFileSync(join(x.wt, "certs", "key.pem"), "-----BEGIN PRIVATE KEY-----\ndir-secret-2\n");
    const r = await x.progress({ checkpoint: true });
    expect(r.isError).not.toBe(true);
    expect(git(x.wt, "show", "--name-status", "--format=", "HEAD")).toBe("D\tcerts");
    expect(hasObject(x.wt, blobOf(x.wt, "-----BEGIN PRIVATE KEY-----\ndir-secret-2\n"))).toBe(false);
    expect(r.content[0]?.text).toContain("certs/key.pem");
  });

  it("R2-1 backstop: a staged secret path found before the commit resets the index and refuses the checkpoint", async () => {
    const x = await wired();
    writeFileSync(join(x.wt, "app.ts"), "export {};\n");
    writeFileSync(join(x.wt, "creds.txt"), "x\n");
    // A classifier that misses creds.txt while staging but reports it afterwards stands in for any staging gap.
    const seen = new Map<string, number>();
    const isSecret = (p: string) => {
      const n = (seen.get(p) ?? 0) + 1;
      seen.set(p, n);
      return p === "creds.txt" && n > 1;
    };
    expect(() => commitCheckpoint(x.wt, "factory checkpoint: t1", undefined, isSecret)).toThrow(/creds\.txt/);
    expect(git(x.wt, "diff", "--cached", "--name-only")).toBe("");
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
  });

  it("R2-2: a task file with more than one hard link is refused and the other link is not copied", async () => {
    const x = await wired({ taskText: null });
    setRoute(x.feature);
    const outside = join(x.dir, "outside.txt");
    writeFileSync(outside, "AWS_SECRET=abc\n");
    mkdirSync(join(x.wt, ".factory", "knowledge", "tasks"), { recursive: true });
    linkSync(outside, x.taskFile);
    const r = await x.progress({ phase: "plan", checkpoint: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/hard link/);
    expect(readFileSync(outside, "utf8")).toBe("AWS_SECRET=abc\n");
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
    expect(x.events).toEqual([]);
  });

  it("R34: an already staged secret file is unstaged, and a checkpoint with only secret changes commits nothing", async () => {
    const x = await wired();
    setRoute(x.feature);
    git(x.wt, "add", "-A");
    git(x.wt, "commit", "-q", "-m", "task file");
    const head = git(x.wt, "rev-parse", "HEAD");
    writeFileSync(join(x.wt, ".env"), "A=1\n");
    git(x.wt, "add", ".env");
    const r = await x.progress({ checkpoint: true });
    expect(r.isError).not.toBe(true);
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(head);
    expect(git(x.wt, "diff", "--cached", "--name-only")).toBe("");
    expect(r.content[0]?.text).toContain(".env");
  });

  it("M2: a failed commit resets the staged index and says so", async () => {
    const x = await wired();
    setRoute(x.feature);
    git(x.project, "config", "--unset", "user.email");
    git(x.project, "config", "--unset", "user.name");
    git(x.project, "config", "user.useConfigOnly", "true");
    writeFileSync(join(x.wt, "app.ts"), "export {};\n");
    const r = await x.progress({ checkpoint: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/git commit failed/);
    expect(r.content[0]?.text).toMatch(/index was reset/);
    expect(git(x.wt, "diff", "--cached", "--name-only")).toBe("");
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
  });

  it.skipIf(isWin)("M2: a failure after the checkpoint names the checkpoint sha and the pending audit error", async () => {
    const x = await wired();
    setRoute(x.feature);
    let appends = 0;
    // The checkpoint event cannot be audited, and the task file cannot be written afterwards.
    const origPush = x.events.push.bind(x.events);
    x.events.push = (...e: RunEvent[]) => {
      appends++;
      if (e[0]?.type === "checkpoint") {
        chmodSync(join(x.wt, ".factory", "knowledge", "tasks"), 0o500);
        throw new Error("ledger down");
      }
      return origPush(...e);
    };
    try {
      const r = await x.progress({ checkpoint: true });
      const sha = git(x.wt, "rev-parse", "HEAD");
      expect(sha).not.toBe(x.base);
      expect(r.isError).toBe(true);
      const text = r.content[0]?.text ?? "";
      expect(text).toContain(sha);
      expect(text).toContain("ledger down");
      expect(appends).toBe(2);
      expect(readdirSync(join(x.wt, ".factory", "knowledge", "tasks"))).toEqual(["t1.md"]);
    } finally {
      chmodSync(join(x.wt, ".factory", "knowledge", "tasks"), 0o755);
    }
  });

  it("M4: a phase or message that holds a secret is rejected before any effect", async () => {
    const x = await wired();
    setRoute(x.feature);
    writeFileSync(join(x.wt, "app.ts"), "export {};\n");
    const phase = await x.progress({ phase: `deploy token=${TOKEN}`, checkpoint: true });
    expect(phase.isError).toBe(true);
    expect(phase.content[0]?.text).toMatch(/secret/);
    expect(phase.content[0]?.text).not.toContain(TOKEN);
    const message = await x.progress({ checkpoint: true, message: `uses ${TOKEN}` });
    expect(message.isError).toBe(true);
    expect(git(x.wt, "rev-parse", "HEAD")).toBe(x.base);
    expect(x.events).toEqual([]);
  });

  it("M5: a refusal after a base reset still reports the reset", async () => {
    const x = await wired();
    setRoute({ ...x.feature, base: "f".repeat(40) });
    const r = await x.progress({ phase: "a · b" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("f".repeat(40));
    expect(r.content[0]?.text).toContain(x.base);
  });

  it("N1: a base that is no longer an ancestor of HEAD is recomputed from HEAD with a notice", async () => {
    const x = await wired();
    setRoute({ ...x.feature, base: "f".repeat(40) });
    const r = await x.progress({ phase: "plan" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]?.text).toMatch(/base/);
    expect(machineOf(x.taskFile).base).toBe(x.base);
    expect(x.entries.at(-1)).toEqual({ customType: ROUTE_ENTRY, data: { ...x.feature, base: x.base, runId: RUN_ID } });
    expect(x.events.some((e) => e.type === "route")).toBe(true);
  });

  it("carry-forward: the ruling-8 post-check keeps a block task_progress wrote during another call", async () => {
    const x = await wired();
    setRoute(x.feature);
    await x.progress({ phase: "plan" });
    const before = readFileSync(x.taskFile, "utf8");
    // An edit of the task file was allowed (pre-call copy taken); task_progress writes before its result.
    x.postChecks.remember("edit-1", { file: x.taskFile, input: x.taskFile, before });
    await x.progress({ phase: "implement", checkpoint: true });
    const written = readFileSync(x.taskFile, "utf8");
    writeFileSync(x.taskFile, written.replace("# Add search", "# Add search (edited)"));
    expect(x.postChecks.afterToolResult({ toolCallId: "edit-1", content: [], isError: false }, { append: () => undefined }, RUN_ID)).toBeUndefined();
    expect(machineOf(x.taskFile).phase).toBe("implement");
    expect(readFileSync(x.taskFile, "utf8")).toContain("(edited)");

    // A model change to the block during a call is still restored, to the last block the extension wrote.
    const now = readFileSync(x.taskFile, "utf8");
    x.postChecks.remember("edit-2", { file: x.taskFile, input: x.taskFile, before: now });
    writeFileSync(x.taskFile, now.replace("phase: implement", "phase: done"));
    const res = x.postChecks.afterToolResult({ toolCallId: "edit-2", content: [], isError: false }, { append: () => undefined }, RUN_ID);
    expect(res).toBeDefined();
    expect(machineOf(x.taskFile).phase).toBe("implement");
  });
});

describe("task_progress on the small route", () => {
  it("a checkpoint creates refs/factory/undo/<taskId> and leaves the working tree and status unchanged", async () => {
    const x = await wired();
    setRoute(x.small);
    writeFileSync(join(x.project, "README.md"), "changed\n");
    writeFileSync(join(x.project, "new.txt"), "untracked\n");
    const statusBefore = git(x.project, "status", "--porcelain");
    const r = await x.progress({ phase: "fix", checkpoint: true });
    expect(r.isError).not.toBe(true);
    const ref = git(x.project, "rev-parse", "refs/factory/undo/fix-1");
    expect(git(x.project, "show", `${ref}:README.md`)).toBe("changed");
    expect(git(x.project, "status", "--porcelain")).toBe(statusBefore);
    expect(readFileSync(join(x.project, "README.md"), "utf8")).toBe("changed\n");
    expect(git(x.project, "rev-parse", "HEAD")).toBe(x.base);
    expect(git(x.project, "stash", "list")).toBe("");
    expect(x.events.map((e) => e.type)).toEqual(["progress", "checkpoint"]);
    expect(x.events[1]).toMatchObject({ type: "checkpoint", taskId: "fix-1", sha: ref, kind: "undo-ref" });
    // Small has no task file.
    expect(existsSync(join(x.project, ".factory"))).toBe(false);
  });

  it("M3: the undo ref keeps a reflog, so an earlier undo point stays reachable", async () => {
    const x = await wired();
    setRoute(x.small);
    writeFileSync(join(x.project, "README.md"), "one\n");
    await x.progress({ checkpoint: true });
    const first = git(x.project, "rev-parse", "refs/factory/undo/fix-1");
    writeFileSync(join(x.project, "README.md"), "two\n");
    await x.progress({ checkpoint: true });
    const log = git(x.project, "reflog", "show", "--format=%H", "refs/factory/undo/fix-1").split("\n");
    expect(log).toContain(first);
    expect(log[0]).toBe(git(x.project, "rev-parse", "refs/factory/undo/fix-1"));
  });

  it.skipIf(isWin)("M6: the reference-transaction hook does not run for the undo ref", async () => {
    const x = await wired();
    setRoute(x.small);
    const marker = join(x.dir, "ref-hook-ran");
    const hook = join(x.project, ".git", "hooks", "reference-transaction");
    mkdirSync(join(x.project, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(x.project, "README.md"), "changed\n");
    expect((await x.progress({ checkpoint: true })).isError).not.toBe(true);
    expect(git(x.project, "rev-parse", "--verify", "refs/factory/undo/fix-1")).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });

  it("a small checkpoint on a clean tree points the undo ref at HEAD", async () => {
    const x = await wired();
    setRoute(x.small);
    expect((await x.progress({ checkpoint: true })).isError).not.toBe(true);
    expect(git(x.project, "rev-parse", "refs/factory/undo/fix-1")).toBe(x.base);
  });
});

describe("task_progress refusals", () => {
  it("is an error result on the answer route, without a task id, on a flagged route and without a session", async () => {
    const x = await wired();
    setRoute(INITIAL_ROUTE);
    const answer = await x.progress({ phase: "plan", checkpoint: true });
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toMatch(/route/);
    const { taskId: _omit, ...noTask } = x.small;
    setRoute(noTask);
    expect((await x.progress({ checkpoint: true })).isError).toBe(true);
    setRoute({ ...x.feature, needsReclassification: true });
    const flagged = await x.progress({ phase: "plan" });
    expect(flagged.isError).toBe(true);
    expect(flagged.content[0]?.text).toContain("set_route");
    expect(x.events).toEqual([]);
    expect(git(x.project, "for-each-ref", "refs/factory")).toBe("");
    expect(readFileSync(x.taskFile, "utf8")).toBe(TASK_TEXT);

    const none = await wired({ session: false });
    setRoute(none.feature);
    expect((await none.progress({ phase: "plan" })).isError).toBe(true);
  });
});
