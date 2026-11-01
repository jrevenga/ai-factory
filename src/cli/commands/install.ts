// `factory install`: checks the minimum requirements, then either applies this release or, when run
// through `npx` (whose cache is temporary), bootstraps a global install first and hands over to it.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npm } from "../../adapters/platform/npm.ts";
import { npmInstallSpec } from "../../core/release/manifest.ts";
import { applyRelease, ApplyFailed, type ApplyContext } from "./apply-release.ts";
import { requirementChecks } from "./doctor.ts";

/** Seams for tests; production uses the real implementations. */
export interface InstallDeps {
  /** Real path of this CLI's entry file. */
  cliPath: string;
  npm: typeof npm;
  /** Runs `node <args>` with the terminal's output and resolves to its exit code. */
  runNode: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  requirements: typeof requirementChecks;
}

export interface InstallOptions {
  yes: boolean;
  profile?: string;
}

const NPM_TIMEOUT_MS = 10 * 60_000;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** True when `realPath` lies inside npm's `npx` cache (`…/_npx/…` or `…\_npx\…`). */
export function isNpxPath(realPath: string): boolean {
  return realPath.includes("/_npx/") || realPath.includes("\\_npx\\");
}

function ownCliPath(): string {
  return realpathSync(fileURLToPath(new URL("../../../bin/factory.mjs", import.meta.url)));
}

/** `node <args>` with stdin closed and output going straight to the terminal (no shell). */
function runNodeInherited(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function install(ctx: ApplyContext, opts: InstallOptions, overrides: Partial<InstallDeps> = {}): Promise<number> {
  const deps: InstallDeps = { cliPath: overrides.cliPath ?? ownCliPath(), npm, runNode: runNodeInherited, requirements: requirementChecks, ...overrides };
  const { io, env, manifest } = ctx;

  const failed = (await deps.requirements({ env, manifest })).filter((c) => c.status === "fail");
  if (failed.length > 0) {
    io.err(
      [
        "The factory cannot be installed until these requirements are met:",
        ...failed.map((c) => `  ${c.id}: ${c.message}${c.fix ? `\n     fix: ${c.fix}` : ""}`),
      ].join("\n"),
    );
    return 1;
  }

  if (isNpxPath(deps.cliPath)) return bootstrap(ctx, opts, deps);

  try {
    await applyRelease(ctx, { reason: "install", profile: opts.profile });
    return 0;
  } catch (e) {
    if (!(e instanceof ApplyFailed)) io.err(`Install did not complete: ${msg(e)}`);
    return 1;
  }
}

/**
 * Running from the npx cache: install this release globally (`--legacy-peer-deps`, ruling 5), then run
 * the global CLI's `install` with the same flags so the installed copy does the work.
 */
async function bootstrap(ctx: ApplyContext, opts: InstallOptions, deps: InstallDeps): Promise<number> {
  const { io, env, manifest } = ctx;
  const spec = npmInstallSpec(manifest, env);
  io.out(`Installing the factory CLI globally (${spec})…`);
  const installed = await deps.npm(["install", "-g", "--legacy-peer-deps", spec], { env, timeoutMs: NPM_TIMEOUT_MS });
  if (installed.code !== 0) {
    const how = installed.timedOut ? "timed out" : `failed with exit ${installed.code}`;
    io.err(`npm install -g of ${spec} ${how}. Check your network and access to the repository, then retry.\n${installed.stderr.trim()}`);
    return 1;
  }
  const rootResult = await deps.npm(["root", "-g"], { env, timeoutMs: 60_000 });
  const globalRoot = rootResult.stdout.trim();
  if (rootResult.code !== 0 || globalRoot === "") {
    io.err(`Could not determine npm's global root (\`npm root -g\` exited with ${rootResult.code}).\n${rootResult.stderr.trim()}`);
    return 1;
  }
  const globalCli = join(globalRoot, "ai-factory", "bin", "factory.mjs");
  if (isNpxPath(globalCli)) {
    io.err(`npm's global root ${globalRoot} is inside the npx cache; refusing to hand over to it. Set a user-owned global prefix (\`npm config set prefix <dir>\`) and retry.`);
    return 1;
  }
  if (!existsSync(globalCli)) {
    io.err(`npm reported success but ${globalCli} does not exist. Run \`npm ls -g ai-factory\` to inspect the global install, then retry.`);
    return 1;
  }
  const args = [globalCli, "install", ...(opts.yes ? ["--yes"] : []), ...(opts.profile === undefined ? [] : ["--profile", opts.profile])];
  try {
    return await deps.runNode(args, env);
  } catch (e) {
    io.err(`Could not start the globally installed factory CLI ${globalCli}: ${msg(e)}`);
    return 1;
  }
}
