import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MachinePostChecks, setRoute } from "../../../../src/adapters/pi/extension/enforce.ts";
import { ROUTE_ENTRY } from "../../../../src/adapters/pi/extension/route-state.ts";
import { registerTaskState, TASK_PROGRESS_TOOL, type TaskSession } from "../../../../src/adapters/pi/extension/task-state.ts";
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
  const session: TaskSession = { ledger: { append: (e) => void events.push(RunEvent.parse(e)) }, runId: RUN_ID, projectRoot: w.project, postChecks };
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

  it("does not run repository hooks for checkpoint commits", async () => {
    if (isWin) return; // hook scripts need a POSIX shell shebang; the hooksPath override is platform independent.
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

  it("N1: a base that is no longer an ancestor of HEAD is recomputed from HEAD with a notice", async () => {
    const x = await wired();
    setRoute({ ...x.feature, base: "f".repeat(40) });
    const r = await x.progress({ phase: "plan" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]?.text).toMatch(/base/);
    expect(machineOf(x.taskFile).base).toBe(x.base);
    expect(x.entries.at(-1)).toEqual({ customType: ROUTE_ENTRY, data: { ...x.feature, base: x.base } });
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
