// `factory _apply-release`: the one step every install, update and rollback converges on, always run by
// the CLI version being installed (plan ruling 10). Its flags are a compatibility contract from v0.1.0 on.
//
// Order matters. The guard is copied right after taking the lock, so any later failure leaves Pi's write
// tools blocked; `state.json` is written last, so any earlier failure leaves the previous state in place;
// the transaction journal is removed only after that (ruling 12).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_FILE_NAME } from "../../../guard/factory-guard.ts";
import { readJson, renameWithRetry, writeJsonAtomic } from "../../adapters/platform/json-file.ts";
import type { FactoryPaths } from "../../adapters/platform/paths.ts";
import type { PiRuntime } from "../../adapters/pi/runtime.ts";
import { applyManagedPiSettings } from "../../adapters/pi/settings-file.ts";
import { detectLogins } from "../../adapters/providers/logins.ts";
import { acquireLock, type Lock } from "../../adapters/store/lock.ts";
import { docSchemas, loadProfiles, readState, stateDocPath, writePersonalConfig, writeState } from "../../adapters/store/state-store.ts";
import { clearTxn } from "../../adapters/store/transaction.ts";
import type { LoginState } from "../../core/profiles/propose.ts";
import { proposeProfile } from "../../core/profiles/propose.ts";
import { effectiveSource, packageRef, type ReleaseManifest } from "../../core/release/manifest.ts";
import { MIGRATIONS, planMigrations, type Migration } from "../../core/state/migrations.ts";
import { FactoryState, type StateDoc } from "../../core/state/schema.ts";
import type { CliIO } from "../io.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";

export type ApplyReason = "install" | "update" | "rollback";
export const APPLY_REASONS: readonly ApplyReason[] = ["install", "update", "rollback"];

/** Seams for tests; production uses the real implementations. */
export interface ApplyDeps {
  detectLogins: typeof detectLogins;
  runDoctor: typeof runDoctor;
  migrations: readonly Migration[];
  clearTxn: typeof clearTxn;
}

export interface ApplyContext {
  paths: FactoryPaths;
  env: NodeJS.ProcessEnv;
  /** This CLI's own release.json. */
  manifest: ReleaseManifest;
  io: CliIO;
  pi: PiRuntime;
  now(): Date;
  /** Package root holding guard/, profiles/ and defaults/; defaults to this package. */
  root?: string;
  deps?: Partial<ApplyDeps>;
}

export interface ApplyOptions {
  reason: ApplyReason;
  /** The version being left (update/rollback); recorded in the history entry. */
  from?: string;
  /** Pid of a parent factory process holding the factory lock, which is then borrowed. */
  parentLockPid?: number;
  /** Profile for a newly created personal config. */
  profile?: string;
}

/** Ruling R8: an install never runs over (or clears) the journal of an unfinished update or rollback. */
export const TXN_PENDING_MESSAGE = 'A previous update did not finish. Run "factory rollback".';

class InstallBlockedByTxn extends Error {
  constructor() {
    super(TXN_PENDING_MESSAGE);
    this.name = "InstallBlockedByTxn";
  }
}

/** Raised after the failure has been reported to the user; callers only map it to an exit code. */
export class ApplyFailed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApplyFailed";
  }
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const stripPeriod = (s: string): string => s.trim().replace(/\.+$/, "");

/** Copies the shipped guard into Pi's global extensions dir; readers see the old or the new file, never a partial one. */
async function installGuard(root: string, paths: FactoryPaths): Promise<void> {
  await mkdir(paths.piExtensions, { recursive: true });
  const target = join(paths.piExtensions, GUARD_FILE_NAME);
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await copyFile(join(root, "guard", GUARD_FILE_NAME), tmp);
    await renameWithRetry(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

function loginInstructions(logins: { claude: LoginState; codex: LoginState }, piCli: string): string {
  return (
    `no provider login found (claude: ${logins.claude}, codex: ${logins.codex}), so no profile can be chosen. ` +
    `Log in to at least one provider, then run "factory install" again: ` +
    `for Claude, start Claude Code (\`claude\`) and run /login; ` +
    `for Codex, start Pi (\`"${process.execPath}" "${piCli}"\`), run /login and choose ChatGPT`
  );
}

/** Creates `config.json` when it does not exist; an existing file is never touched. */
async function ensurePersonalConfig(
  paths: FactoryPaths,
  root: string,
  requested: string | undefined,
  logins: { claude: LoginState; codex: LoginState },
  piCli: string,
): Promise<void> {
  if (existsSync(paths.config)) return;
  const profiles = await loadProfiles(join(root, "profiles"));
  let name: string;
  if (requested !== undefined) {
    if (!profiles.some((p) => p.name === requested)) {
      throw new Error(`Unknown profile "${requested}". Available profiles: ${profiles.map((p) => p.name).join(", ")}`);
    }
    name = requested;
  } else {
    const proposed = proposeProfile(logins, profiles);
    if (!proposed) throw new Error(loginInstructions(logins, piCli));
    name = proposed.name;
  }
  await writePersonalConfig(paths, { schema: 1, profile: name });
}

/**
 * Applies the planned migrations. Every document except `state.json` is rewritten now; `state.json` is
 * only migrated in memory and returned, because it may be written only as the last step.
 */
async function migrate(paths: FactoryPaths, manifest: ReleaseManifest, registry: readonly Migration[]): Promise<unknown | undefined> {
  const plan = planMigrations(await docSchemas(paths), registry, manifest.stateSchemas);
  const docs = new Map<StateDoc, unknown>();
  for (const m of plan) {
    const current = docs.has(m.doc) ? docs.get(m.doc) : await readJson(stateDocPath(paths, m.doc));
    docs.set(m.doc, m.up(current));
  }
  for (const [doc, value] of docs) {
    if (doc !== "state.json") await writeJsonAtomic(stateDocPath(paths, doc), value);
  }
  return docs.get("state.json");
}

export async function applyRelease(ctx: ApplyContext, opts: ApplyOptions): Promise<void> {
  const { paths, env, manifest, io, pi } = ctx;
  const root = ctx.root ?? PACKAGE_ROOT;
  const deps: ApplyDeps = { detectLogins, runDoctor, migrations: MIGRATIONS, clearTxn, ...ctx.deps };
  const now = ctx.now();

  let lock: Lock | undefined;
  /** proper-lockfile may report the lock lost mid-run (R5): never mutate after that. */
  const live = () => {
    if (lock?.compromised) throw lock.compromised;
  };
  let failure: unknown;
  /** True once state.json is written: the release is installed even if a later step fails. */
  let committed = false;
  try {
    lock = await acquireLock(paths, { ownerPid: opts.parentLockPid });
    live();
    if (opts.reason === "install" && existsSync(paths.txn)) throw new InstallBlockedByTxn();
    await installGuard(root, paths);
    live();
    const piCli = await pi.ensurePinned(paths, manifest.pi.version, { env });
    live();
    await pi.installPackage(piCli, packageRef(manifest, env), { env, cwd: paths.home });
    const logins = await deps.detectLogins({ piCli, env });
    const bridge = manifest.companions["pi-claude-bridge"];
    if (logins.claude === "present") {
      live();
      await pi.installPackage(piCli, bridge.source, { env, cwd: paths.home });
    }
    live();
    await applyManagedPiSettings(paths, manifest.factory);
    live();
    await ensurePersonalConfig(paths, root, opts.profile, logins, piCli);
    live();
    const migratedState = await migrate(paths, manifest, deps.migrations);
    const previous = migratedState === undefined ? await readState(paths) : FactoryState.parse(migratedState);
    const entry = { version: manifest.factory, at: now.toISOString(), reason: opts.reason, ...(opts.from === undefined ? {} : { from: opts.from }) };
    live();
    await writeState(paths, {
      ...previous,
      schema: 1,
      version: manifest.factory,
      // Ruling R9: the first-install time; later applies only append history.
      installedAt: previous?.installedAt ?? now.toISOString(),
      source: effectiveSource(manifest, env),
      piVersion: manifest.pi.version,
      piCli,
      history: [...(previous?.history ?? []), entry],
    });
    committed = true;
    // The journal belongs to the update/rollback that holds (or lent us) the lock: remove it while the
    // lock is still ours, never after release (another transaction may own the journal by then).
    if (opts.reason !== "install") {
      live();
      await deps.clearTxn(paths);
    }
  } catch (e) {
    failure = e;
  }

  // Release in every case; a release error (e.g. a compromised lock) is reported, never swallowed.
  let releaseError: unknown;
  try {
    await lock?.release();
  } catch (e) {
    releaseError = e;
  }
  const releaseNote = releaseError === undefined || releaseError === failure ? "" : ` (and the factory lock could not be released: ${msg(releaseError)})`;

  if (failure instanceof InstallBlockedByTxn) {
    io.err(`${TXN_PENDING_MESSAGE}${releaseNote}`);
    throw new ApplyFailed(msg(failure), { cause: failure });
  }
  if (failure !== undefined && !committed) {
    io.err(`Install did not complete: ${stripPeriod(msg(failure))}${releaseNote}. Previous state kept. Run "factory doctor"; after an update run "factory rollback".`);
    throw new ApplyFailed(msg(failure), { cause: failure });
  }
  if (failure !== undefined) {
    io.err(
      `factory ${manifest.factory} is installed, but the journal ${paths.txn} could not be removed: ${stripPeriod(msg(failure))}${releaseNote}. ` +
        `Make sure no other factory command is running, remove it, then run "factory doctor".`,
    );
    throw new ApplyFailed(msg(failure), { cause: failure });
  }
  if (releaseError !== undefined) {
    io.err(`factory ${manifest.factory} is installed, but the factory lock could not be released cleanly: ${msg(releaseError)}. Run "factory doctor".`);
  }
  io.out(`factory ${manifest.factory} installed.`);
  try {
    io.out(formatDoctor(await deps.runDoctor({ paths, env, offline: true, manifest, root })));
  } catch (e) {
    io.err(`The installation finished, but "factory doctor" could not run: ${msg(e)}. Run "factory doctor" to check it.`);
  }
}
