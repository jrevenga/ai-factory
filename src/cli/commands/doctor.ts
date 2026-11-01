// `factory doctor`: read-only health checks. Never writes, never needs elevated rights; every failing
// check carries the command or step that fixes it. Online checks run only when `offline` is false.
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_FILE_NAME } from "../../../guard/factory-guard.ts";
import { loadProfiles, readPersonalConfig, readState } from "../../adapters/store/state-store.ts";
import { readTxn } from "../../adapters/store/transaction.ts";
import { classifyGitError, gitEnv, lsRemoteTags, type GitErrorKind } from "../../adapters/vcs/git.ts";
import { PiRuntime, pinnedCliPath } from "../../adapters/pi/runtime.ts";
import { readPiSettings } from "../../adapters/pi/settings-file.ts";
import { readJson } from "../../adapters/platform/json-file.ts";
import { npm } from "../../adapters/platform/npm.ts";
import type { FactoryPaths } from "../../adapters/platform/paths.ts";
import { runBounded } from "../../adapters/platform/process.ts";
import { detectLogins } from "../../adapters/providers/logins.ts";
import { checkReachability, type Provider } from "../../adapters/providers/reachability.ts";
import { CoreConfig } from "../../core/config/schema.ts";
import { effectiveSource, packageRef, type ReleaseManifest } from "../../core/release/manifest.ts";
import { compareSemver } from "../../core/release/semver.ts";
import { DESIRED_PI_SETTINGS, ManagedRecord, planManagedSettings } from "../../core/settings/managed.ts";

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface DoctorContext {
  paths: FactoryPaths;
  env: NodeJS.ProcessEnv;
  offline: boolean;
  manifest: ReleaseManifest;
  fetchFn?: typeof fetch;
  /** Package root (holds release.json, guard/, profiles/, defaults/); defaults to this package. */
  root?: string;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const GIT_FIXES: Record<GitErrorKind, string> = {
  "auth-https":
    "Git needs credentials for this repository over HTTPS. Sign in once (for example `git ls-remote <repo>` in a terminal, or configure a credential helper / token). " +
    "On Windows, non-interactive sessions such as SSH cannot use Git Credential Manager's wincredman store: run the command in a local terminal or use a personal access token.",
  "auth-ssh":
    "Git could not authenticate over SSH. Load your SSH key into ssh-agent (`ssh-add`) or make sure the key file is readable. " +
    "On Windows, non-interactive sessions may not be able to read your SSH key.",
  "not-found": "The repository or the release tag was not found. Check FACTORY_SOURCE or the repository URL and your access to it.",
  network: "The repository could not be reached. Check your network connection, proxy settings and the repository URL.",
  unknown: "Run `git ls-remote <repo>` in a terminal to see the underlying git error.",
};

async function check(id: string, run: () => Promise<Omit<DoctorCheck, "id">> | Omit<DoctorCheck, "id">): Promise<DoctorCheck> {
  try {
    return { id, ...(await run()) };
  } catch (e) {
    return { id, status: "fail", message: `check could not run: ${msg(e)}`, fix: "Re-run `factory doctor`; if it persists, report this message." };
  }
}

function writableDir(dir: string): boolean {
  let d = dir;
  for (;;) {
    try {
      if (statSync(d).isDirectory()) {
        accessSync(d, constants.W_OK);
        return true;
      }
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(d);
      if (parent === d) return false;
      d = parent;
    }
  }
}

async function sqliteFts5(): Promise<Omit<DoctorCheck, "id">> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(body, tokenize="unicode61 remove_diacritics 2")`);
    db.prepare("INSERT INTO t(body) VALUES (?)").run("Decisión");
    const hit = (db.prepare("SELECT count(*) AS c FROM t WHERE t MATCH ?").get("decision") as { c: number }).c === 1;
    if (!hit) return { status: "fail", message: "SQLite FTS5 does not fold diacritics", fix: "Use Node.js >= 22.19.0 (bundled SQLite with FTS5)." };
    return { status: "ok", message: "node:sqlite with FTS5 and diacritic folding works" };
  } finally {
    db.close();
  }
}

export async function runDoctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const { paths, env, manifest } = ctx;
  const root = ctx.root ?? PACKAGE_ROOT;
  const source = effectiveSource(manifest, env);
  const checks: DoctorCheck[] = [];
  const add = async (id: string, run: () => Promise<Omit<DoctorCheck, "id">> | Omit<DoctorCheck, "id">) => {
    checks.push(await check(id, run));
  };
  let piSettings: Record<string, unknown> | undefined;
  let piSettingsError: string | undefined;
  try {
    piSettings = await readPiSettings(paths.piSettings);
  } catch (e) {
    piSettingsError = msg(e);
  }

  await add("node-version", () =>
    compareSemver(process.versions.node, manifest.node.min) >= 0
      ? { status: "ok", message: `Node.js ${process.versions.node}` }
      : { status: "fail", message: `Node.js ${process.versions.node} is older than ${manifest.node.min}`, fix: `Install Node.js ${manifest.node.min} or newer (user-level, e.g. via nvm or fnm).` },
  );
  await add("node-sqlite-fts5", () =>
    sqliteFts5().catch((e: unknown) => ({
      status: "fail" as const,
      message: `node:sqlite with FTS5 is unavailable: ${msg(e)}`,
      fix: `Use Node.js ${manifest.node.min} or newer.`,
    })),
  );
  await add("git", async () => {
    try {
      const r = await runBounded("git", ["--version"], { env: gitEnv(env), timeoutMs: 10_000 });
      if (r.code === 0) return { status: "ok", message: r.stdout.trim() };
      return { status: "fail", message: `git --version exited with ${r.code}`, fix: "Reinstall Git (https://git-scm.com/downloads)." };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "fail", message: "git was not found on PATH", fix: "Install Git (https://git-scm.com/downloads) and make sure it is on PATH." };
      throw e;
    }
  });
  await add("npm", async () => {
    const r = await npm(["--version"], { env, timeoutMs: 30_000 });
    return r.code === 0
      ? { status: "ok", message: `npm ${r.stdout.trim()}` }
      : { status: "fail", message: `npm --version exited with ${r.code}`, fix: "Reinstall Node.js with npm (https://nodejs.org)." };
  });
  await add("npm-prefix-writable", async () => {
    const r = await npm(["prefix", "-g"], { env, timeoutMs: 30_000 });
    const prefix = r.stdout.trim();
    if (r.code !== 0 || prefix === "") return { status: "fail", message: "could not determine npm's global prefix", fix: "Run `npm prefix -g` and fix the npm error it prints." };
    return writableDir(prefix)
      ? { status: "ok", message: `npm global prefix ${prefix} is writable` }
      : { status: "fail", message: `npm global prefix ${prefix} is not writable`, fix: "Point npm at a user-owned prefix: `npm config set prefix <a directory you own>` and add its bin directory to PATH." };
  });
  await add("factory-home-writable", () =>
    writableDir(paths.home)
      ? { status: "ok", message: `${paths.home} is writable` }
      : { status: "fail", message: `${paths.home} is not writable`, fix: "Make the directory writable for your user, or set FACTORY_HOME to a directory you own." },
  );
  await add("state", async () => {
    const state = await readState(paths);
    if (!state) return { status: "fail", message: `no ${paths.state}: the factory is not installed`, fix: "factory install" };
    if (state.version !== manifest.factory) {
      return { status: "fail", message: `installed state is ${state.version} but this CLI is ${manifest.factory}`, fix: "factory install" };
    }
    return { status: "ok", message: `factory ${state.version} installed` };
  });
  await add("txn", async () => {
    const txn = await readTxn(paths);
    return txn
      ? { status: "fail", message: `unfinished ${txn.kind} ${txn.from} -> ${txn.to} (${paths.txn})`, fix: "factory rollback" }
      : { status: "ok", message: "no unfinished transaction" };
  });
  await add("pi-pinned", async () => {
    const cli = pinnedCliPath(join(paths.piPrefixes, manifest.pi.version));
    if (!existsSync(cli)) return { status: "fail", message: `pinned Pi ${manifest.pi.version} not found at ${cli}`, fix: "factory install" };
    const version = await new PiRuntime().version(cli, { env });
    return version === manifest.pi.version
      ? { status: "ok", message: `Pi ${version}` }
      : { status: "fail", message: `pinned Pi reports ${version}, expected ${manifest.pi.version}`, fix: "factory install" };
  });
  await add("pi-settings", () =>
    piSettingsError === undefined
      ? { status: "ok", message: `${paths.piSettings} parses` }
      : { status: "fail", message: piSettingsError, fix: `Fix or remove ${paths.piSettings}, then re-run \`factory doctor\`.` },
  );
  await add("managed-settings", async () => {
    if (!piSettings) return { status: "warn", message: "skipped: Pi settings could not be read" };
    const raw = await readJson(paths.managedSettings);
    const parsed = raw === undefined ? { success: true as const, data: { schema: 1 as const, keys: {} } } : ManagedRecord.safeParse(raw);
    if (!parsed.success) return { status: "fail", message: `${paths.managedSettings} is invalid: ${parsed.error.message}`, fix: `Fix or remove ${paths.managedSettings}, then run \`factory install\`.` };
    // Read-only: only the plan is computed, nothing is written.
    const plan = planManagedSettings(piSettings, parsed.data, DESIRED_PI_SETTINGS, { now: new Date().toISOString(), factoryVersion: manifest.factory });
    const notes = plan.changes.filter((c) => c.action === "kept-user-value" || c.action === "kept-foreign-value").map((c) => `${c.key}: ${c.action === "kept-user-value" ? "you changed it, kept" : "already set by you, kept"}`);
    if (piSettings.transport !== "sse") notes.push("transport is not sse: Codex limits will be unknown");
    return notes.length > 0 ? { status: "warn", message: notes.join("; ") } : { status: "ok", message: "managed Pi settings are in place" };
  });
  await add("factory-package", () => {
    const ref = packageRef(manifest, env);
    const packages = piSettings?.packages;
    const present =
      Array.isArray(packages) &&
      packages.some((p) => p === ref || (typeof p === "object" && p !== null && (p as { source?: unknown }).source === ref));
    return present
      ? { status: "ok", message: ref }
      : { status: "fail", message: `Pi settings do not list ${ref}`, fix: "factory install" };
  });
  await add("guard", () => {
    const installed = join(paths.piExtensions, GUARD_FILE_NAME);
    if (!existsSync(installed)) return { status: "fail", message: `${installed} is missing`, fix: "factory install" };
    const same = readFileSync(installed).equals(readFileSync(join(root, "guard", GUARD_FILE_NAME)));
    return same ? { status: "ok", message: "guard extension matches the shipped file" } : { status: "fail", message: `${installed} differs from the shipped guard`, fix: "factory install" };
  });
  await add("source-override", () =>
    env.FACTORY_SOURCE
      ? { status: "warn", message: `FACTORY_SOURCE overrides the package source: ${env.FACTORY_SOURCE}` }
      : { status: "ok", message: "using the release's package source" },
  );

  let personal: Awaited<ReturnType<typeof readPersonalConfig>>;
  let configProblem: string | undefined;
  await add("config", async () => {
    try {
      personal = await readPersonalConfig(paths);
    } catch (e) {
      configProblem = msg(e);
      return { status: "fail", message: configProblem.includes(paths.config) ? configProblem : `${paths.config}: ${configProblem}`, fix: `Fix or remove ${paths.config}, then run \`factory install\`.` };
    }
    return personal
      ? { status: "ok", message: `${paths.config} parses (profile ${personal.profile})` }
      : { status: "warn", message: `no ${paths.config}: defaults are in use`, fix: "factory install" };
  });
  let profiles: Awaited<ReturnType<typeof loadProfiles>> = [];
  let profilesProblem: string | undefined;
  await add("profiles", async () => {
    try {
      profiles = await loadProfiles(join(root, "profiles"));
    } catch (e) {
      profilesProblem = msg(e);
      return { status: "fail", message: profilesProblem, fix: "factory install (reinstalls the shipped profiles); if it persists, report this message." };
    }
    return { status: "ok", message: `${profiles.length} profiles load` };
  });

  const piCli = pinnedCliPath(join(paths.piPrefixes, manifest.pi.version));
  const logins = await detectLogins({ piCli: existsSync(piCli) ? piCli : undefined, env });
  await add("logins", () => {
    const desc = `claude: ${logins.claude}, codex: ${logins.codex}`;
    if (logins.claude !== "present" && logins.codex !== "present") {
      return { status: "fail", message: `no provider login found (${desc})`, fix: "Log in to Claude with `claude auth login`, and/or to Codex with `factory` then `/login` (Pi, provider openai-codex)." };
    }
    return logins.claude === "present" && logins.codex === "present" ? { status: "ok", message: desc } : { status: "warn", message: desc };
  });

  if (!ctx.offline) {
    await add("repo-access", async () => {
      try {
        const tags = await lsRemoteTags(source, { env, timeoutMs: 15_000 });
        return { status: "ok", message: `${source} reachable (${tags.length} tags)` };
      } catch (e) {
        const kind = (e as { kind?: GitErrorKind }).kind ?? classifyGitError(msg(e));
        return { status: "fail", message: `cannot read ${source}: ${msg(e)}`, fix: GIT_FIXES[kind] };
      }
    });
    await add("provider-reachability", async () => {
      if (configProblem || profilesProblem) {
        return { status: "warn", message: "skipped: the required providers depend on a config or profiles failure reported above", fix: "Fix the config/profiles failure, then re-run `factory doctor`." };
      }
      let required: Provider[] = ["claude", "codex"];
      const profile = profiles.find((p) => p.name === personal?.profile);
      if (profile) required = profile.requires;
      const result = await checkReachability(required, ctx.fetchFn ?? fetch);
      const down = Object.entries(result).filter(([, v]) => v === "unreachable").map(([k]) => k);
      return down.length === 0
        ? { status: "ok", message: `reachable: ${required.join(", ")}` }
        : { status: "fail", message: `unreachable: ${down.join(", ")}`, fix: "Check your network connection, proxy and firewall, then retry." };
    });
  }

  await add("parallelism", async () => {
    if (configProblem) return { status: "warn", message: "skipped: personal config is invalid (see the config check)", fix: `Fix ${paths.config} first.` };
    const core = CoreConfig.parse(await readJson(join(root, "defaults", "config.json")));
    const configured = personal?.parallelism ?? core.parallelism;
    const max = Math.max(1, Math.min(8, Math.floor(totalmem() / 1024 ** 3 / 4)));
    return configured > max
      ? { status: "warn", message: `parallelism ${configured} exceeds the ${max} this machine's memory supports`, fix: `Lower it: set "parallelism": ${max} in ${paths.config}.` }
      : { status: "ok", message: `parallelism ${configured} (max ${max})` };
  });

  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((c) => `${c.status.toUpperCase().padEnd(4)} ${c.id}: ${c.message}${c.fix ? `\n     fix: ${c.fix}` : ""}`)
    .join("\n");
}
