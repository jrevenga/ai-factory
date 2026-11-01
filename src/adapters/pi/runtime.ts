// The pinned Pi runtime (plan ruling 4): Pi is installed into a factory-owned prefix
// `<FACTORY_HOME>/pi/<version>/` and always run as `node <prefix>/…/dist/bundle/cli.js`, so a user's own
// `pi` on PATH is never used, replaced or shadowed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { npm as runNpm } from "../platform/npm.ts";
import type { FactoryPaths } from "../platform/paths.ts";
import { runBounded, type RunResult } from "../platform/process.ts";
import { gitEnv, GitError, resolveRef as gitResolveRef, type GitErrorKind } from "../vcs/git.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PACKAGE_DIR = ["node_modules", "@earendil-works", "pi-coding-agent"];
const CLI_REL = [...PACKAGE_DIR, "dist", "bundle", "cli.js"];
const PLAIN_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface PiRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PiRuntimeDeps {
  npm: typeof runNpm;
  resolveRef: typeof gitResolveRef;
}

/** Why a `git:` package ref could not be resolved: a classified git failure, or `invalid-ref` (unparseable or unpinned). */
export type UnresolvableRefKind = GitErrorKind | "invalid-ref";

export class UnresolvableRef extends Error {
  readonly ref: string;
  readonly kind: UnresolvableRefKind;
  constructor(ref: string, kind: UnresolvableRefKind, detail: string, options?: { cause?: unknown }) {
    super(`Cannot resolve package ref ${ref} (${kind}): ${detail}. Pi settings were not changed.`, options);
    this.name = "UnresolvableRef";
    this.ref = ref;
    this.kind = kind;
  }
}

export class PiInstallFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiInstallFailed";
  }
}

export class PiCommandFailed extends Error {
  readonly result: RunResult;
  constructor(what: string, result: RunResult) {
    const how = result.timedOut ? "timed out" : `exited with ${result.code}`;
    super(`pi ${what} ${how}: ${(result.stderr || result.stdout).trim() || "no output"}`);
    this.name = "PiCommandFailed";
    this.result = result;
  }
}

/** `cli.js` inside a pinned prefix. */
export function pinnedCliPath(prefix: string): string {
  return join(prefix, ...CLI_REL);
}

/** Version of the Pi package installed in `prefix`, or undefined when absent/unreadable. */
function installedVersion(prefix: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(prefix, ...PACKAGE_DIR, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Splits a Pi `git:` package ref into the URL Pi clones and its ref, mirroring Pi 1.4.0's
 * `parseGitUrl`/`splitRef` for the URL, SCP-like and `host/path` forms (host shorthands without a
 * scheme get `https://`). Returns undefined for non-`git:` refs.
 */
export function parsePiGitRef(source: string): { url: string; ref: string | undefined } | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("git:")) return undefined;
  const raw = trimmed.slice(4).trim();

  const scp = raw.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    const rest = scp[2] ?? "";
    const at = rest.indexOf("@");
    if (at <= 0 || at === rest.length - 1) return { url: raw, ref: undefined };
    return { url: `git@${scp[1] ?? ""}:${rest.slice(0, at)}`, ref: rest.slice(at + 1) };
  }
  if (raw.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { url: raw, ref: undefined };
    }
    const path = parsed.pathname.replace(/^\/+/, "");
    const at = path.indexOf("@");
    if (at <= 0 || at === path.length - 1) return { url: raw, ref: undefined };
    const ref = path.slice(at + 1);
    parsed.pathname = `/${path.slice(0, at)}`;
    return { url: parsed.toString().replace(/\/$/, ""), ref };
  }
  const slash = raw.indexOf("/");
  const path = slash < 0 ? "" : raw.slice(slash + 1);
  const at = path.indexOf("@");
  if (slash < 0 || at <= 0 || at === path.length - 1) return { url: `https://${raw}`, ref: undefined };
  return { url: `https://${raw.slice(0, slash)}/${path.slice(0, at)}`, ref: path.slice(at + 1) };
}

/** `node <cli> …args` with stdin closed and telemetry off. */
export function runPi(cli: string, args: string[], opts: PiRunOptions = {}): Promise<RunResult> {
  return runBounded(process.execPath, [cli, ...args], {
    cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), PI_TELEMETRY: "0" },
    timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    signal: opts.signal,
  });
}

export class PiRuntime {
  private readonly deps: PiRuntimeDeps;

  constructor(deps: Partial<PiRuntimeDeps> = {}) {
    this.deps = { npm: runNpm, resolveRef: gitResolveRef, ...deps };
  }

  /**
   * Returns the `cli.js` of Pi `version` under `<piPrefixes>/<version>`, installing it from npm first
   * unless that prefix already holds exactly this version. The install goes to a staging prefix that is
   * moved into place only when complete, so an interrupted install never leaves a half prefix.
   *
   * No path travels as an npm argument (ruling 15: the Windows `.cmd` fallback rejects `&`, `%`, `!`…):
   * the staging dir gets a private `package.json` and is npm's working directory, which makes it npm's
   * local prefix. `npm_config_prefix` is not usable for this — npm reads it only as the *global* prefix
   * (`npm prefix` ignores it), which would need `-g` and a platform-dependent layout.
   */
  async ensurePinned(paths: FactoryPaths, version: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
    if (!PLAIN_SEMVER.test(version)) throw new PiInstallFailed(`Invalid Pi version ${JSON.stringify(version)}: expected an exact semver such as 1.4.0.`);
    const prefix = join(paths.piPrefixes, version);
    const cli = pinnedCliPath(prefix);
    if (installedVersion(prefix) === version && existsSync(cli)) return cli;

    await mkdir(paths.piPrefixes, { recursive: true });
    const staging = join(paths.piPrefixes, `.staging-${version}-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await mkdir(staging);
      await writeFile(join(staging, "package.json"), `${JSON.stringify({ name: "factory-pi-runtime", private: true }, null, 2)}\n`);
      const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", `${PI_PACKAGE}@${version}`];
      const r = await this.deps.npm(args, { env: opts.env, cwd: staging, timeoutMs: opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS });
      if (r.code !== 0) {
        const how = r.timedOut ? "timed out" : `failed with exit ${r.code}`;
        throw new PiInstallFailed(`npm install of ${PI_PACKAGE}@${version} ${how}. Check network access to the npm registry and retry.\n${r.stderr.trim()}`);
      }
      if (installedVersion(staging) !== version || !existsSync(pinnedCliPath(staging))) {
        throw new PiInstallFailed(`npm installed ${PI_PACKAGE}@${version} without ${CLI_REL.join("/")} at version ${version}.`);
      }
      // A concurrent install may have published the same version meanwhile; otherwise the existing
      // prefix holds another version or is incomplete and is replaced.
      if (installedVersion(prefix) !== version || !existsSync(cli)) {
        await rm(prefix, { recursive: true, force: true });
        await rename(staging, prefix);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return cli;
  }

  run(cli: string, args: string[], opts: PiRunOptions = {}): Promise<RunResult> {
    return runPi(cli, args, opts);
  }

  /** Pi's `--version` output. */
  async version(cli: string, opts: PiRunOptions = {}): Promise<string> {
    const r = await this.run(cli, ["--version"], opts);
    if (r.code !== 0) throw new PiCommandFailed("--version", r);
    return r.stdout.trim();
  }

  /**
   * `pi install <ref>` (user scope). A `git:` ref is first resolved with `git ls-remote`; if it cannot
   * be resolved, UnresolvableRef is thrown and Pi is never run, so Pi settings stay untouched.
   */
  async installPackage(cli: string, ref: string, opts: PiRunOptions = {}): Promise<void> {
    if (ref.trim().startsWith("git:")) await this.assertResolvable(ref, opts);
    // Pi clones with git: no prompts, and a byte-identical checkout regardless of host autocrlf.
    const env = gitEnv(opts.env ?? process.env);
    const r = await this.run(cli, ["install", ref], { ...opts, env, timeoutMs: opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS });
    if (r.code !== 0) throw new PiCommandFailed(`install ${ref}`, r);
  }

  private async assertResolvable(ref: string, opts: PiRunOptions): Promise<void> {
    const parsed = parsePiGitRef(ref);
    if (!parsed?.ref) throw new UnresolvableRef(ref, "invalid-ref", "a git package ref must name a tag (git:<url>@<tag>)");
    let found: boolean;
    try {
      found = await this.deps.resolveRef(parsed.url, parsed.ref, { env: opts.env, cwd: opts.cwd });
    } catch (e) {
      // GitError carries its classification; anything else (git missing, teardown failure) is unknown.
      const kind = e instanceof GitError ? e.kind : "unknown";
      throw new UnresolvableRef(ref, kind, e instanceof Error ? e.message : String(e), { cause: e });
    }
    if (!found) throw new UnresolvableRef(ref, "not-found", `tag ${parsed.ref} does not exist at ${parsed.url}`);
  }
}
