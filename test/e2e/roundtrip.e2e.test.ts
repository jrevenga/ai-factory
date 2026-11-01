// Phase 1 acceptance (A §3, §15): the npx bootstrap installs the factory from a served release, then
// `factory update` → `factory rollback` round-trips through a second release. Everything is real: npm
// (`npm exec`, i.e. npx), the global install in a temp prefix, the pinned Pi 1.4.0 from the public npm
// registry, and git over a local smart-HTTP server. Only `.github/workflows/e2e.yml` runs this file
// (`npm run test:e2e` excludes it): it takes minutes and downloads Pi several times.
//
// Fixture releases are built from the committed `HEAD` of this repository (uncommitted changes are not
// included): its tree is exported through a private index into a fresh work tree, so the real
// repository is only read, and a shallow CI checkout or a detached pull-request HEAD makes no difference.
//   v0.1.0 = HEAD's tree
//   v0.2.0 = v0.1.0 + `factory`/`version` 0.2.0 in release.json/package.json and a `## [0.2.0]` changelog
//            section (additive release: same stateSchemas, same lockfile, so lockfileSha256 stays valid)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_FILE_NAME } from "../../guard/factory-guard.ts";
import { npm } from "../../src/adapters/platform/npm.ts";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { runBounded, type RunResult } from "../../src/adapters/platform/process.ts";
import { locateGlobalCli } from "../../src/cli/commands/install.ts";
import { startGitServer, type GitServer } from "../helpers/git-server.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { tree } from "../helpers/release-world.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const isWindows = process.platform === "win32";
const STEP_TIMEOUT_MS = 15 * 60_000;
const BOOTSTRAP_BUDGET_S = 600;
/** Doctor checks allowed to be non-ok: CI has no provider logins, and FACTORY_SOURCE is set on purpose. */
const ALLOWED_NON_OK = ["logins", "source-override"];
/**
 * Advisory checks allowed to `warn` (never `fail`), ruling R12: `parallelism` depends on the machine's
 * memory (GitHub runners have ~7 GB, so the suggested maximum 1 is below the default 3).
 */
const ALLOWED_WARN = ["parallelism"];

// Fixed identity, no signing, no line-ending conversion: the fixture holds exactly HEAD's bytes.
const GIT_CONFIG = [
  "-c",
  "user.name=factory-test",
  "-c",
  "user.email=factory-test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "core.autocrlf=false",
];

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
let server: GitServer;
let source: string;
/** `npm_config_prefix`; npm's global bin dir is the prefix itself on Windows, `<prefix>/bin` on POSIX. */
let prefix: string;
let prefixBin: string;
/** Neutral working directory for every command (no package.json, no .npmrc). */
let userCwd: string;

async function gitOk(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const r = await runBounded("git", [...GIT_CONFIG, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...opts.env },
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.code}, timedOut ${r.timedOut}):\n${r.stderr}`);
  return r.stdout;
}

async function editJson(file: string, edit: (doc: Record<string, unknown>) => void): Promise<void> {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(doc);
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Builds the two fixture releases and serves them as `fixture/ai-factory.git` (tags v0.1.0, v0.2.0). */
async function buildFixture(dir: string): Promise<GitServer> {
  const work = join(dir, "fixture work tree");
  await mkdir(work, { recursive: true });
  // Export HEAD's tree without touching the real repository's index or refs.
  const indexEnv = { GIT_INDEX_FILE: join(dir, "fixture.index") };
  await gitOk(["-C", ROOT, "read-tree", "HEAD"], { env: indexEnv });
  await gitOk(["-C", ROOT, "checkout-index", "--all", "--force", `--prefix=${work.replace(/\\/g, "/")}/`], { env: indexEnv });

  const bare = join(dir, "served root", "fixture", "ai-factory.git");
  await gitOk(["init", "--quiet", "--initial-branch=main"], { cwd: work });
  await gitOk(["add", "--all"], { cwd: work });
  await gitOk(["commit", "--quiet", "-m", "release 0.1.0"], { cwd: work });
  await gitOk(["tag", "v0.1.0"], { cwd: work });

  await editJson(join(work, "package.json"), (pkg) => void (pkg.version = "0.2.0"));
  await editJson(join(work, "release.json"), (rel) => void (rel.factory = "0.2.0"));
  const changelog = readFileSync(join(work, "CHANGELOG.md"), "utf8");
  if (!changelog.startsWith("# Changelog\n")) throw new Error("CHANGELOG.md must start with \"# Changelog\"");
  await writeFile(join(work, "CHANGELOG.md"), changelog.replace("# Changelog\n", "# Changelog\n\n## [0.2.0] - unreleased\n\n- Round-trip fixture release.\n"));
  await gitOk(["commit", "--quiet", "--all", "-m", "release 0.2.0"], { cwd: work });
  await gitOk(["tag", "v0.2.0"], { cwd: work });

  await mkdir(dirname(bare), { recursive: true });
  await gitOk(["clone", "--quiet", "--bare", "--", work, bare]);
  return startGitServer(join(dir, "served root"), { requestTimeoutMs: 5 * 60_000 });
}

/** The globally installed `factory` shim in the temp prefix (`factory.cmd` runs through cmd.exe, ruling 15). */
function factoryShim(): string {
  return join(prefixBin, isWindows ? "factory.cmd" : "factory");
}

function describeRun(r: RunResult): string {
  return `exit ${r.code}, timedOut ${r.timedOut}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
}

async function factory(args: string[], timeoutMs = STEP_TIMEOUT_MS): Promise<RunResult> {
  return runBounded(factoryShim(), args, { cwd: userCwd, env, timeoutMs });
}

async function expectFactoryOk(args: string[]): Promise<RunResult> {
  const r = await factory(args);
  expect(r.code, `factory ${args.join(" ")}: ${describeRun(r)}`).toBe(0);
  return r;
}

async function expectDoctorHealthy(): Promise<void> {
  const r = await factory(["doctor", "--offline", "--json"], 5 * 60_000);
  let checks: { id: string; status: string; message: string }[];
  try {
    checks = JSON.parse(r.stdout) as typeof checks;
  } catch {
    throw new Error(`doctor printed no JSON: ${describeRun(r)}`);
  }
  const unexpected = checks.filter(
    (c) => c.status !== "ok" && !ALLOWED_NON_OK.includes(c.id) && !(c.status === "warn" && ALLOWED_WARN.includes(c.id)),
  );
  expect(unexpected, JSON.stringify(checks, null, 2)).toEqual([]);
  expect(checks.find((c) => c.id === "state")?.status).toBe("ok");
}

function readJsonFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function piPackages(): unknown[] {
  const packages = readJsonFile(paths.piSettings).packages;
  return Array.isArray(packages) ? packages : [];
}

function stateVersion(): unknown {
  return readJsonFile(paths.state).version;
}

function snapshotIds(): string[] {
  return existsSync(paths.backups) ? readdirSync(paths.backups) : [];
}

beforeAll(async () => {
  tmp = await makeTmp("roundtrip-e2e");
  server = await buildFixture(tmp.dir);
  source = server.url("fixture/ai-factory.git");

  const base = isolatedEnv(tmp.dir);
  prefix = base.npm_config_prefix as string;
  prefixBin = isWindows ? prefix : join(prefix, "bin");
  // Windows spells the key `Path`; prefix whichever spelling is present.
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env = { ...base, [pathKey]: `${prefixBin}${delimiter}${base[pathKey] ?? ""}`, FACTORY_SOURCE: source, PI_OFFLINE: "1" };
  paths = factoryPaths(env);
  userCwd = join(tmp.dir, "user cwd");
  await mkdir(userCwd, { recursive: true });
  // Every location a command may write lies under the temp root, never the real homes or global prefix.
  for (const dir of [paths.home, paths.piAgentDir, prefix, env.npm_config_cache as string]) expect(dir.startsWith(tmp.dir)).toBe(true);
  expect(existsSync(paths.home)).toBe(false);
  expect(existsSync(paths.piAgentDir)).toBe(false);
}, 300_000);

// Two hooks, as in runtime.e2e: the git server's close is bounded and keeps the default timeout; removing
// the temp root (npm cache, npx cache, global prefix and pinned Pi) is slow on Windows.
let closing: Promise<void> | undefined;
const closeServer = () => (closing ??= server?.close() ?? Promise.resolve());
afterAll(async () => {
  await closeServer();
  await tmp?.cleanup();
}, 300_000);
afterAll(async () => {
  await closeServer();
});

describe("bootstrap install and update → rollback round-trip (e2e, real npm and Pi 1.4.0)", () => {
  let updateSnapshot: string | undefined;
  let updateSnapshotTree: Record<string, string> = {};

  it(
    "npx bootstraps v0.1.0: global factory, state, Pi package, managed settings, guard, healthy doctor",
    async () => {
      // `npx -y <spec> <args>` is `npm exec --yes -- <spec> <args>`; npm runs through its JS entry
      // (resolveNpm), so no npx/.cmd shim is needed on Windows.
      const spec = `git+${source}#v0.1.0`;
      const started = performance.now();
      const r = await npm(["exec", "--yes", "--", spec, "install", "--yes", "--profile", "codex-only"], { env, cwd: userCwd, timeoutMs: STEP_TIMEOUT_MS });
      const seconds = (performance.now() - started) / 1000;
      console.log(`[roundtrip] step 2 (npx bootstrap install) took ${seconds.toFixed(1)} s (budget ${BOOTSTRAP_BUDGET_S} s) on ${process.platform} / Node ${process.versions.node}`);
      expect(r.code, `npx bootstrap: ${describeRun(r)}`).toBe(0);
      expect(seconds).toBeLessThan(BOOTSTRAP_BUDGET_S);

      // The global CLI lives in the temp prefix (never the real one) and is on PATH there.
      const globalCli = await locateGlobalCli(npm, env);
      expect(globalCli.startsWith(prefix)).toBe(true);
      expect(existsSync(factoryShim())).toBe(true);

      expect(stateVersion()).toBe("0.1.0");
      expect(piPackages()).toContain(`git:${source}@v0.1.0`);
      const settings = readJsonFile(paths.piSettings);
      expect(settings.transport).toBe("sse");
      expect(settings.enableInstallTelemetry).toBe(false);
      expect(existsSync(join(paths.piExtensions, GUARD_FILE_NAME))).toBe(true);
      expect(readJsonFile(paths.config).profile).toBe("codex-only");
      await expectDoctorHealthy();
    },
    STEP_TIMEOUT_MS + 60_000,
  );

  it(
    "factory update --to v0.2.0 installs v0.2.0 and keeps an immutable 0.1.0-to-0.2.0 snapshot",
    async () => {
      await expectFactoryOk(["update", "--to", "v0.2.0", "--yes"]);
      expect((await expectFactoryOk(["version"])).stdout.trim()).toBe("0.2.0");

      expect(stateVersion()).toBe("0.2.0");
      const snapshots = snapshotIds().filter((id) => id.endsWith("-0.1.0-to-0.2.0"));
      expect(snapshots).toHaveLength(1);
      updateSnapshot = snapshots[0] as string;
      updateSnapshotTree = tree(join(paths.backups, updateSnapshot));
      expect(Object.keys(updateSnapshotTree)).toContain("snapshot.json");
      expect(piPackages()).toContain(`git:${source}@v0.2.0`);
      expect(piPackages()).not.toContain(`git:${source}@v0.1.0`);
      expect(existsSync(paths.txn)).toBe(false);
      await expectDoctorHealthy();
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "factory rollback returns to v0.1.0, keeps a config edit made after the update and leaves the update snapshot untouched",
    async () => {
      expect(updateSnapshot, "the update step must have passed").toBeDefined();
      // Step 4: a user edit after the update.
      await editJson(paths.config, (cfg) => void (cfg.language = "es"));

      await expectFactoryOk(["rollback", "--yes"]);

      expect(stateVersion()).toBe("0.1.0");
      // Same stateSchemas in both releases: the rollback keeps current data (ruling 11).
      expect(readJsonFile(paths.config).language).toBe("es");
      expect(piPackages()).toContain(`git:${source}@v0.1.0`);
      expect(piPackages()).not.toContain(`git:${source}@v0.2.0`);
      expect(existsSync(paths.txn)).toBe(false);
      const version = await expectFactoryOk(["version"]);
      expect(version.stdout.trim()).toBe("0.1.0");
      expect(tree(join(paths.backups, updateSnapshot as string))).toEqual(updateSnapshotTree);
      expect(snapshotIds().filter((id) => id.endsWith("-0.2.0-to-0.1.0"))).toHaveLength(1);
      await expectDoctorHealthy();
    },
    STEP_TIMEOUT_MS,
  );
});
