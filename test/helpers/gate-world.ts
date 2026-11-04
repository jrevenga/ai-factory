// Fixture world for the gate e2e suites (Task 12): an isolated factory home and Pi agent dir, a committed git project
// whose `origin` is a local bare repository (so a push that got through would be observable), and harmless
// directories outside the project. Every path lives under one makeTmp dir; nothing touches the real ~/.pi or
// ~/.factory (piPrintEnv refuses them).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./isolated-env.ts";
import { makeTmp, type Tmp } from "./tmp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAUX = join(ROOT, "test", "fixtures", "faux-provider.ts");
export const EXTENSION = join(ROOT, "src", "adapters", "pi", "extension", "index.ts");
export const OBSERVER = join(ROOT, "test", "fixtures", "observer.ts");
export const NESTED = join(ROOT, "test", "fixtures", "nested-tools.ts");
export const isWin = process.platform === "win32";
export const BLOCKED = "Blocked by the factory gate";
/** Dummy content of the project's `.env`; no tool result may ever contain it. */
export const SECRET_MARK = "FIXTURE_ONLY_NOT_A_SECRET_7f3a";

export type ToolResult = { event: "tool_result"; toolName: string; isError: boolean; text: string };
export type LedgerEvent = { type: string } & Record<string, unknown>;

export function jsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as T);
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
}

/** `package.json` test script: rewrites the tracked `src/a.txt`, so a run is observable and reconcilable. */
const NPM_TEST = ['import { writeFileSync } from "node:fs";', 'writeFileSync("src/a.txt", "changed by npm test\\n");', 'console.log("npm test ran");'].join("\n");

export interface GateWorld {
  tmp: Tmp;
  dir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  agentDir: string;
  project: string;
  realProject: string;
  /** The project's `origin`: a bare repository with no refs until something is pushed. */
  remote: string;
  /** `<dir>/outside`: outside every write root (holds `target.txt`). */
  outside: string;
  /** `<dir>/victim/keep.txt`: the target of the `rm -rf` attempt. */
  victim: string;
  /** Observer output (tool results). */
  log: string;
  /** Whether the R28 link `rel/l -> ../home/.ssh/key` exists (POSIX only). */
  symlinks: boolean;
}

/**
 * <dir>/factory home/state.json   valid install record (handshake ok)
 * <dir>/project                   git, origin = <dir>/remote.git; README.md, notes.md (machine block), src/a.txt,
 *                                 package.json (`npm test` rewrites src/a.txt), scripts/ok.mjs declared as `test` in
 *                                 .factory/config.json, p.diff, key; untracked .env (dummy) and, on POSIX,
 *                                 rel/l -> ../home/.ssh/key
 * <dir>/home/.ssh/key             POSIX: the fake HOME's secret (dummy text)
 * <dir>/remote.git                bare, empty
 * <dir>/outside/target.txt, <dir>/victim/keep.txt
 */
export async function makeGateWorld(prefix: string): Promise<GateWorld> {
  const tmp = await makeTmp(prefix);
  const dir = tmp.dir;
  const env = isolatedEnv(dir);
  // A fake home (Pi's gate reads os.homedir(), i.e. HOME on POSIX) so home-anchored secrets are fixture files. On
  // Windows os.homedir() follows USERPROFILE and Git Bash its own HOME, so the real home is left as is there.
  let fakeHome: string | undefined;
  if (!isWin) {
    fakeHome = join(dir, "home");
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "key"), `${SECRET_MARK}\n`);
    env.HOME = fakeHome;
  }
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
  const remote = join(dir, "remote.git");
  mkdirSync(remote);
  git(remote, "init", "-q", "--bare");
  const outside = join(dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "target.txt"), "outside original\n");
  const victimDir = join(dir, "victim");
  mkdirSync(victimDir);
  const victim = join(victimDir, "keep.txt");
  writeFileSync(victim, "must survive\n");

  const project = join(dir, "project");
  for (const d of ["src", "scripts", ".factory", "rel"]) mkdirSync(join(project, d), { recursive: true });
  git(project, "init", "-q");
  git(project, "remote", "add", "origin", remote);
  writeFileSync(join(project, ".gitignore"), ".env\n");
  writeFileSync(join(project, "README.md"), "readme\n");
  writeFileSync(join(project, "notes.md"), "# Notes\n\n<!-- machine: written by code only -->\nphase: draft\n<!-- /machine -->\n");
  writeFileSync(join(project, "src", "a.txt"), "a original\n");
  writeFileSync(join(project, "scripts", "npm-test.mjs"), NPM_TEST);
  writeFileSync(join(project, "scripts", "ok.mjs"), 'console.log("checks passed");\n');
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "gate-fixture", private: true, scripts: { test: "node scripts/npm-test.mjs" } }));
  writeFileSync(join(project, ".factory", "config.json"), JSON.stringify({ schema: 1, commands: { test: "node scripts/ok.mjs" } }));
  writeFileSync(join(project, "key"), "plain file\n");
  writeFileSync(join(project, "p.diff"), "not a real patch\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "init");
  writeFileSync(join(project, ".env"), `TOKEN=${SECRET_MARK}\n`);
  // R28 fixture (POSIX only, see `fakeHome`): rel/l -> ../home/.ssh/key points at project/home/.ssh/key, which does
  // not exist and is no secret path; the same link copied to the project root points at <dir>/home/.ssh/key, a secret
  // of the fake home.
  let symlinks = false;
  if (fakeHome !== undefined) {
    try {
      symlinkSync(join("..", "home", ".ssh", "key"), join(project, "rel", "l"));
      symlinks = true;
    } catch {
      symlinks = false;
    }
  }
  const log = join(dir, "observed.jsonl");
  env.OBSERVE_FILE = log;
  return { tmp, dir, env, home, agentDir: env.PI_CODING_AGENT_DIR as string, project, realProject: realpathSync.native(project), remote, outside, victim, log, symlinks };
}

export function results(w: GateWorld): ToolResult[] {
  return jsonLines<{ event: string } & Partial<ToolResult>>(w.log).filter((o): o is ToolResult => o.event === "tool_result");
}

/** Events of every run of the project, oldest run first. */
export function ledgerRuns(w: GateWorld): LedgerEvent[][] {
  const runs = join(w.home, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .flatMap((p) => readdirSync(join(runs, p)).map((r) => join(runs, p, r, "events.jsonl")))
    .sort()
    .map((f) => jsonLines<LedgerEvent>(f));
}

export function gateEvents(w: GateWorld): LedgerEvent[] {
  return ledgerRuns(w)
    .flat()
    .filter((e) => e.type === "gate");
}

/** Refs in the bare remote (empty unless a push got through). */
export function remoteRefs(w: GateWorld): string {
  return git(w.remote, "for-each-ref", "--format=%(refname)");
}
