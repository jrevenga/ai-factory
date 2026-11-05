// Acceptance (A §15): a broken package install leaves write tools blocked. A real `_apply-release` with
// the real PiRuntime fails because the release tag does not exist at the served source; the guard it
// copied before failing must then block a `write` in the real pinned Pi.
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_FILE_NAME } from "../../guard/factory-guard.ts";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { PiRuntime } from "../../src/adapters/pi/runtime.ts";
import { applyRelease, ApplyFailed } from "../../src/cli/commands/apply-release.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { ReleaseManifest } from "../../src/core/release/manifest.ts";
import { makeBareRepo, makeWorkTree, startGitServer, type GitServer } from "../helpers/git-server.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { runPiPrint } from "../helpers/pi-harness.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAUX = join(ROOT, "test", "fixtures", "faux-provider.ts");
const OBSERVER = join(ROOT, "test", "fixtures", "observer.ts");
const manifest = ReleaseManifest.parse(JSON.parse(readFileSync(join(ROOT, "release.json"), "utf8")));

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
let server: GitServer;
let applyError: unknown;
const out: string[] = [];
const err: string[] = [];

beforeAll(async () => {
  tmp = await makeTmp("broken-install-e2e");
  // A served release repo that has an older tag but not the manifest's v<factory> tag.
  const work = join(tmp.dir, "fixture work tree");
  await makeWorkTree(work, [{ "package.json": JSON.stringify({ name: "ai-factory", version: "0.0.9", keywords: ["pi-package"] }, null, 2) }]);
  const served = join(tmp.dir, "served root");
  await makeBareRepo(work, join(served, "fixture", "ai-factory.git"), [{ name: "v0.0.9" }]);
  server = await startGitServer(served);

  env = { ...isolatedEnv(tmp.dir), PI_OFFLINE: "1", FACTORY_SOURCE: server.url("fixture/ai-factory.git") };
  paths = factoryPaths(env);
  expect(existsSync(paths.piAgentDir)).toBe(false);
  expect(existsSync(paths.home)).toBe(false);

  const io: CliIO = { out: (s) => void out.push(s), err: (s) => void err.push(s), confirm: async () => false, isTTY: false };
  applyError = await applyRelease({ paths, env, manifest, io, pi: new PiRuntime(), now: () => new Date() }, { reason: "install" }).then(
    () => undefined,
    (e: unknown) => e,
  );
}, 600_000);

let closing: Promise<void> | undefined;
const closeServer = () => (closing ??= server?.close() ?? Promise.resolve());
afterAll(async () => {
  await closeServer();
  await tmp?.cleanup();
}, 120_000);
afterAll(async () => {
  await closeServer();
});

describe("broken install (e2e, real Pi 1.4.0)", () => {
  it("apply for a tag that does not exist fails, keeps no state and installs no package", () => {
    expect(applyError).toBeInstanceOf(ApplyFailed);
    const text = err.join("\n");
    expect(text).toContain(`Install did not complete: Cannot resolve package ref git:${env.FACTORY_SOURCE}@v${manifest.factory} (not-found)`);
    expect(text).toContain("Previous state kept.");
    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.piSettings)).toBe(false);
    expect(existsSync(join(paths.piExtensions, GUARD_FILE_NAME))).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("the guard installed by the failed apply blocks a write in the pinned Pi", async () => {
    // Already installed by the failed apply: returns at once, without npm.
    const cli = await new PiRuntime({ npm: () => Promise.reject(new Error("npm must not run")) }).ensurePinned(paths, manifest.pi.version, { env });
    const work = join(tmp.dir, "project");
    const target = join(work, "out.txt");
    const log = join(tmp.dir, "observed.jsonl");
    const runEnv = { ...env, OBSERVE_FILE: log, FAUX_SCRIPT: JSON.stringify([{ tool: "write", args: { path: target, content: "x" } }]) };
    await mkdir(work, { recursive: true });

    // Only the faux provider and the observer are passed; the guard is discovered from <agentDir>/extensions.
    const r = await runPiPrint({ cli, agentDir: paths.piAgentDir, cwd: work, env: runEnv, extensions: [FAUX, OBSERVER] });

    expect(r.timedOut).toBe(false);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(target)).toBe(false);
    const results = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { event: string; toolName?: string; isError?: boolean; text?: string })
      .filter((o) => o.event === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolName: "write", isError: true });
    expect(results[0]?.text).toContain("factory guard:");
  }, 180_000);
});
