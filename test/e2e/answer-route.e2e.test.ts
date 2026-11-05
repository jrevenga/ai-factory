// Answer-route runner reconciliation in a real Pi 1.4.0 (faux provider, Task 11, ruling 5): a project-declared runner
// runs on the answer route through `bash` and through `run_check`; after each call the tracked file it modified is
// restored, its git-ignored build output stays, the tool result carries the reconciliation note and the ledger has a
// `reconciled` event with the backup path. No git object or ref is created in the project's repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { ensureTestPi, runPiPrint } from "../helpers/pi-harness.ts";
import { makeTmp } from "../helpers/tmp.ts";
import { RELEASE } from "../helpers/release-version.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAUX = join(ROOT, "test", "fixtures", "faux-provider.ts");
const EXTENSION = join(ROOT, "src", "adapters", "pi", "extension", "index.ts");
const OBSERVER = join(ROOT, "test", "fixtures", "observer.ts");
const isWin = process.platform === "win32";
const NOTE = "Reverted on the answer route (copies in ";

type Result = { event: "tool_result"; toolName: string; isError: boolean; text: string };
type LedgerEvent = { type: string } & Record<string, unknown>;

function jsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as T);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    // No automatic maintenance: a detached `git maintenance run --auto` after a commit holds `objects/maintenance.lock`
    // for a moment, which would make the object-store comparisons below racy.
    ["-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", "-c", "init.defaultBranch=main", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

let cli: string;
beforeAll(async () => {
  cli = await ensureTestPi();
}, 600_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const MODIFY = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'writeFileSync("src/a.txt", "changed by the runner\\n");',
  'mkdirSync("dist", { recursive: true });',
  'writeFileSync("dist/out.txt", "build output\\n");',
  'console.log("runner done");',
].join("\n");

describe("answer-route reconciliation (e2e, faux provider)", () => {
  it("a declared runner run through bash and through run_check is reconciled after each call: tracked file restored, ignored output kept, note in the result, `reconciled` in the ledger", async () => {
    const t = await makeTmp("answer-e2e");
    cleanups.push(t.cleanup);
    const env = isolatedEnv(t.dir);
    const home = env.FACTORY_HOME as string;
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        schema: 1,
        version: RELEASE,
        installedAt: "2026-10-31T00:00:00.000Z",
        source: "https://github.com/jrevenga/ai-factory.git",
        piVersion: "1.4.0",
        piCli: "/nonexistent/cli.js",
        history: [{ version: RELEASE, at: "2026-10-31T00:00:00.000Z", reason: "install" }],
      }),
    );
    const project = join(t.dir, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "scripts"));
    mkdirSync(join(project, ".factory"));
    git(project, "init", "-q");
    writeFileSync(join(project, ".gitignore"), "dist/\n");
    writeFileSync(join(project, "src", "a.txt"), "a original\n");
    writeFileSync(join(project, "scripts", "modify.mjs"), MODIFY);
    writeFileSync(join(project, ".factory", "config.json"), JSON.stringify({ schema: 1, commands: { test: "node scripts/modify.mjs" } }));
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "init");
    const objects = () => (readdirSync(join(project, ".git", "objects"), { recursive: true }) as string[]).sort();
    const before = { objects: objects(), refs: git(project, "for-each-ref", "--format=%(refname) %(objectname)") };

    const log = join(t.dir, "observed.jsonl");
    env.OBSERVE_FILE = log;
    env.FAUX_SCRIPT = JSON.stringify([
      { tool: "bash", args: { command: "node scripts/modify.mjs" } },
      { tool: "run_check", args: { command: "node scripts/modify.mjs" } },
    ]);
    const r = await runPiPrint({ cli, agentDir: env.PI_CODING_AGENT_DIR as string, cwd: project, env, extensions: [FAUX, EXTENSION, OBSERVER] });
    expect(r.timedOut).toBe(false);
    expect(r.code, r.stderr).toBe(0);

    const res = jsonLines<{ event: string } & Partial<Result>>(log).filter((o): o is Result => o.event === "tool_result");
    expect(res.map((x) => [x.toolName, x.isError])).toEqual([
      ["bash", false],
      ["run_check", false],
    ]);
    for (const x of res) {
      expect(x.text).toContain("runner done");
      expect(x.text).toContain(NOTE);
      expect(x.text).toContain("reverted src/a.txt");
    }
    expect(readFileSync(join(project, "src", "a.txt"), "utf8")).toBe("a original\n");
    expect(readFileSync(join(project, "dist", "out.txt"), "utf8")).toBe("build output\n");
    expect(git(project, "status", "--porcelain")).toBe("");
    expect({ objects: objects(), refs: git(project, "for-each-ref", "--format=%(refname) %(objectname)") }).toEqual(before);

    const runs = join(home, "runs");
    const [projectDir] = readdirSync(runs);
    const [runId] = readdirSync(join(runs, projectDir!));
    const events = jsonLines<LedgerEvent>(join(runs, projectDir!, runId!, "events.jsonl"));
    const gates = events.filter((e) => e.type === "gate").map((e) => [e.tool, e.decision]);
    expect(gates).toEqual([
      ["bash", "allow"],
      ["run_check", "allow"],
    ]);
    const reconciled = events.filter((e) => e.type === "reconciled");
    expect(reconciled).toHaveLength(2);
    for (const e of reconciled) {
      expect(e).toMatchObject({ reverted: ["src/a.txt"], moved: [] });
      const backupDir = e.backupDir as string;
      expect(backupDir).toContain(join(runs, projectDir!, runId!, "reconcile"));
      expect(readFileSync(join(backupDir, "after", "src", "a.txt"), "utf8")).toBe("changed by the runner\n");
      expect(JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"))).toMatchObject({ status: "done" });
    }
    const check = events.find((e) => e.type === "check")?.record as Record<string, unknown> | undefined;
    expect(check).toMatchObject({ exitCode: 0, mutated: true, declaredAs: "test" });
  }, 180_000);
});
