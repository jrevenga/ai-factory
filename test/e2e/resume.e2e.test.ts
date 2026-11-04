// Resume after a killed session (Phase 2 Task 13, acceptance 2) in a real Pi 1.4.0 (faux provider). Run 1 declares a
// feature route, writes in the task worktree, takes a checkpoint and is killed mid-run without a graceful signal
// (SIGKILL to its process group on POSIX, `taskkill /T /F` on Windows), so no `run_end` is written. Run 2 continues the
// same session: the ledger marks run 1 interrupted, run 2 records that it resumed from it, the resume prompt section
// names the checkpoint and the phase, and the restored route stays read-only until set_route re-declares it (ruling 20).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_CLOSE, MACHINE_OPEN, parseMachine } from "../../src/core/task/machine.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { ensureTestPi, killPiHard, runPiSession, spawnPiSession, type SpawnedPi } from "../helpers/pi-harness.ts";
import { makeTmp } from "../helpers/tmp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAUX = join(ROOT, "test", "fixtures", "faux-provider.ts");
const HOLD = join(ROOT, "test", "fixtures", "hold-tool.ts");
const EXTENSION = join(ROOT, "src", "adapters", "pi", "extension", "index.ts");
const OBSERVER = join(ROOT, "test", "fixtures", "observer.ts");
const isWin = process.platform === "win32";
const RECLASSIFY = "re-declare the route with set_route";

type Observed = { event: string } & Record<string, unknown>;
type LedgerEvent = { type: string } & Record<string, unknown>;

function jsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as T);
}

/** Run dirs of every project ledger, oldest run first: [runId, events]. */
function ledgerRuns(factoryHome: string): Array<[string, LedgerEvent[]]> {
  const runs = join(factoryHome, "runs");
  return readdirSync(runs)
    .flatMap((p) => readdirSync(join(runs, p)).map((r) => [r, join(runs, p, r, "events.jsonl")] as const))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([r, f]) => [r, jsonLines<LedgerEvent>(f)]);
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

let cli: string;
beforeAll(async () => {
  cli = await ensureTestPi();
}, 600_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A committed project with a feature worktree `factory/t1` (outside the project) holding the task file. */
async function setup() {
  const t = await makeTmp("resume-e2e");
  cleanups.push(t.cleanup);
  const env = isolatedEnv(t.dir);
  const home = env.FACTORY_HOME as string;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      schema: 1,
      version: "0.1.0",
      installedAt: "2026-10-31T00:00:00.000Z",
      source: "https://github.com/jrevenga/ai-factory.git",
      piVersion: "1.4.0",
      piCli: "/nonexistent/cli.js",
      history: [{ version: "0.1.0", at: "2026-10-31T00:00:00.000Z", reason: "install" }],
    }),
  );
  const project = join(t.dir, "project");
  mkdirSync(project);
  git(project, "init", "-q");
  writeFileSync(join(project, "README.md"), "x\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "init");
  const wt = join(t.dir, "wt-t1");
  git(project, "worktree", "add", "-q", "-b", "factory/t1", wt);
  const tasks = join(wt, ".factory", "knowledge", "tasks");
  mkdirSync(tasks, { recursive: true });
  const taskFile = join(tasks, "t1.md");
  writeFileSync(taskFile, `---\nid: t1\ntitle: Resume me\n---\n${MACHINE_OPEN}\nphase: plan\n${MACHINE_CLOSE}\n\n# Resume me\n`);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "task t1");
  const log = join(t.dir, "observed.jsonl");
  env.OBSERVE_FILE = log;
  // The checkpoint commit runs git inside Pi with the inherited environment: give it an identity and no host config
  // (a CI runner has no user.name/user.email, so the commit, and with it the checkpoint, would fail).
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Factory Test",
    GIT_AUTHOR_EMAIL: "factory-test@example.invalid",
    GIT_COMMITTER_NAME: "Factory Test",
    GIT_COMMITTER_EMAIL: "factory-test@example.invalid",
  });
  return { dir: t.dir, env, home, project, wt, realWt: realpathSync.native(wt), taskFile, log, agentDir: env.PI_CODING_AGENT_DIR as string, sessions: join(t.dir, "sessions") };
}

async function waitForFile(file: string, p: SpawnedPi, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void p.exited.then(() => (exited = true));
  while (!existsSync(file)) {
    if (exited) throw new Error(`pi exited before ${file} appeared; stderr:\n${p.stderr()}`);
    if (Date.now() > deadline) throw new Error(`${file} did not appear within ${timeoutMs} ms; stderr:\n${p.stderr()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("resume after a killed session (e2e, faux provider)", () => {
  it("a run killed without a graceful signal is reported interrupted; the continued session resumes from its checkpoint and must re-declare the route", async () => {
    const s = await setup();
    const sentinel = join(s.dir, "held");
    const extensions = [FAUX, HOLD, EXTENSION, OBSERVER];

    // Run 1: feature route, a write in the worktree, a checkpoint, then a call that never returns.
    s.env.HOLD_SENTINEL = sentinel;
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "set_route", args: { route: "feature", taskId: "t1", reason: "implement t1", worktree: s.wt } },
      { tool: "write", args: { path: join(s.wt, "work.txt"), content: "work\n" } },
      { tool: "task_progress", args: { phase: "implement", checkpoint: true } },
      { tool: "hold", args: {} },
    ]);
    const run1 = spawnPiSession({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions, sessionDir: s.sessions });
    try {
      await waitForFile(sentinel, run1, 90_000);
    } finally {
      await killPiHard(run1);
    }
    const exit = await run1.exited;
    if (!isWin) expect(exit, run1.stderr() + run1.stdout()).toEqual({ code: null, signal: "SIGKILL" });

    // The checkpoint call succeeded before the hold (its result is in the observer log, which Pi writes before the
    // next LLM call, i.e. before the hold).
    const run1Results = jsonLines<Observed>(s.log).filter((o) => o.event === "tool_result");
    expect(run1Results.find((o) => o.toolName === "task_progress"), JSON.stringify(run1Results)).toMatchObject({ isError: false });

    const before = ledgerRuns(s.home);
    expect(before).toHaveLength(1);
    const [run1Id, run1Events] = before[0]!;
    expect(run1Events.map((e) => e.type)).not.toContain("run_end");
    const checkpoint = run1Events.find((e) => e.type === "checkpoint");
    expect(checkpoint, JSON.stringify(run1Events)).toMatchObject({ taskId: "t1", kind: "commit" });
    const sha = checkpoint!.sha as string;
    expect(sha).toMatch(/^[0-9a-f]{40,64}$/);

    // Run 2: continue the session. A write before set_route is blocked; after it, the same write succeeds.
    delete s.env.HOLD_SENTINEL;
    const after = join(s.wt, "after.txt");
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "write", args: { path: after, content: "after\n" } },
      { tool: "set_route", args: { route: "feature", taskId: "t1", reason: "resume t1", worktree: s.wt } },
      { tool: "write", args: { path: after, content: "after\n" } },
      { text: "first agent run done" },
    ]);
    // Two prompts in one process: two agent runs; the resume section must reach the first only.
    const run2 = await runPiSession({ cli, agentDir: s.agentDir, cwd: s.project, env: s.env, extensions, sessionDir: s.sessions, continue: true, args: ["go"], prompt: "again" });
    expect(run2.timedOut).toBe(false);
    expect(run2.code, run2.stderr).toBe(0);

    const runs = ledgerRuns(s.home);
    expect(runs).toHaveLength(2);
    const [run2Id, run2Events] = runs[1]!;
    const interrupted = runs[0]![1].filter((e) => e.type === "run_interrupted");
    expect(interrupted).toEqual([expect.objectContaining({ runId: run1Id, detectedBy: run2Id })]);
    expect(run2Events[0]).toMatchObject({ type: "run_start", resumedFrom: [run1Id] });
    // The route came back from the session entries, flagged (ruling 20).
    expect(run2Events.find((e) => e.type === "route")).toMatchObject({
      reason: "restored from session",
      state: { route: "feature", taskId: "t1", writeRoots: [s.realWt], needsReclassification: true },
    });

    // The resume section reached run 2's prompt (once), naming the run, the task, the phase and the checkpoint.
    const observed = jsonLines<Observed>(s.log);
    const sections = observed.filter((o) => o.event === "prompt_sections").map((o) => o.sections as Record<string, string>);
    // Run 1 had one agent run, run 2 two; the second agent run of run 2 has no resume section.
    expect(sections).toHaveLength(3);
    expect(Object.keys(sections[2]!)).not.toContain("factory-resume");
    const resume = sections.map((x) => Object.values(x).find((v) => v.includes("Interrupted factory run"))).filter((v) => v !== undefined);
    expect(resume).toEqual([
      `Interrupted factory run ${run1Id}: task t1, phase implement, last checkpoint ${sha}. Resume from the checkpoint; re-declare the route with set_route.`,
    ]);
    expect(run2.stderr).toContain(`Interrupted factory run ${run1Id}`);

    // The task file and the worktree are at the checkpoint.
    const machine = parseMachine(readFileSync(s.taskFile, "utf8"));
    expect(machine && !("invalid" in machine) ? machine.fields.checkpoint : undefined).toBe(sha);
    expect(git(s.wt, "rev-parse", "HEAD")).toBe(sha);

    const results = observed.filter((o) => o.event === "tool_result").map((o) => [o.toolName, o.isError, o.text] as [string, boolean, string]);
    const run2Results = results.slice(-3);
    expect(run2Results.map(([n, e]) => [n, e])).toEqual([
      ["write", true],
      ["set_route", false],
      ["write", false],
    ]);
    expect(run2Results[0]![2]).toContain(RECLASSIFY);
    expect(readFileSync(after, "utf8")).toBe("after\n");
  }, 240_000);
});
