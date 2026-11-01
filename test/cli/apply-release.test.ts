import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARD_FILE_NAME } from "../../guard/factory-guard.ts";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { PiRuntime, UnresolvableRef, type PiRunOptions } from "../../src/adapters/pi/runtime.ts";
import { acquireLock, readLockHolder } from "../../src/adapters/store/lock.ts";
import { applyRelease, type ApplyContext, type ApplyDeps } from "../../src/cli/commands/apply-release.ts";
import type { CliIO } from "../../src/cli/io.ts";
import type { LoginState } from "../../src/core/profiles/propose.ts";
import { ReleaseManifest } from "../../src/core/release/manifest.ts";
import type { Migration } from "../../src/core/state/migrations.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const manifest = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));
const SOURCE = "http://127.0.0.1:1/fixture/ai-factory.git";
const FACTORY_REF = `git:${SOURCE}@v0.1.0`;
const BRIDGE_REF = "npm:pi-claude-bridge@0.9.3";
const FAKE_CLI = "/fake/pi/cli.js";

const TXN = JSON.stringify({ id: "t", kind: "update", from: "0.0.9", to: "0.1.0", snapshot: "s", startedAt: "2026-11-01T09:00:00.000Z" });
const PREVIOUS_STATE = `{"schema":1,"version":"0.0.9","installedAt":"2026-10-01T00:00:00.000Z","source":"x","piVersion":"1.4.0","piCli":"/old/cli.js","history":[{"version":"0.0.9","at":"2026-10-01T00:00:00.000Z","reason":"install"}]}`;

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;
let log: string[];
let out: string[];
let err: string[];

beforeEach(async () => {
  tmp = await makeTmp("apply-release");
  env = { ...isolatedEnv(tmp.dir), FACTORY_SOURCE: SOURCE, PI_OFFLINE: "1" };
  paths = factoryPaths(env);
  log = [];
  out = [];
  err = [];
});
afterEach(async () => {
  await tmp.cleanup();
});

const guardPath = () => join(paths.piExtensions, GUARD_FILE_NAME);

/** Records each call with what was true at that moment (guard copied, factory lock held by us). */
class FakePi extends PiRuntime {
  private readonly failInstall: ((ref: string) => Error | undefined) | undefined;
  constructor(failInstall?: (ref: string) => Error | undefined) {
    super();
    this.failInstall = failInstall;
  }
  override async ensurePinned(p: FactoryPaths, version: string): Promise<string> {
    log.push(`ensurePinned ${version} guard=${existsSync(join(p.piExtensions, GUARD_FILE_NAME))}`);
    return FAKE_CLI;
  }
  override async installPackage(cli: string, ref: string, opts: PiRunOptions = {}): Promise<void> {
    const holder = await readLockHolder(paths);
    log.push(`install ${ref} cli=${cli} locked=${holder?.pid === process.pid} cwd=${opts.cwd === paths.home}`);
    const e = this.failInstall?.(ref);
    if (e) throw e;
  }
}

function io(): CliIO {
  return { out: (s) => void out.push(s), err: (s) => void err.push(s), confirm: async () => false, isTTY: false };
}

function ctx(pi: PiRuntime, logins: { claude: LoginState; codex: LoginState }, extra: Partial<ApplyDeps> = {}, m: ReleaseManifest = manifest): ApplyContext {
  const deps: Partial<ApplyDeps> = {
    detectLogins: async (o) => {
      log.push(`detectLogins piCli=${o?.piCli}`);
      return logins;
    },
    runDoctor: async (c) => {
      log.push(`doctor offline=${c.offline}`);
      return [{ id: "fake", status: "ok", message: "fake doctor ran" }];
    },
    ...extra,
  };
  return { paths, env, manifest: m, io: io(), pi, now: () => new Date("2026-11-01T10:00:00.000Z"), deps };
}

const readJsonFile = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("applyRelease happy path", () => {
  it("copies the guard first, then ensurePinned, then installs the factory ref, and writes state last", async () => {
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" });

    expect(log).toEqual([
      "ensurePinned 1.4.0 guard=true",
      `install ${FACTORY_REF} cli=${FAKE_CLI} locked=true cwd=true`,
      `detectLogins piCli=${FAKE_CLI}`,
      "doctor offline=true",
    ]);
    expect(readFileSync(guardPath()).equals(readFileSync(join("guard", GUARD_FILE_NAME)))).toBe(true);
    const state = readJsonFile(paths.state);
    expect(state).toMatchObject({ schema: 1, version: "0.1.0", piVersion: "1.4.0", piCli: FAKE_CLI, source: SOURCE, installedAt: "2026-11-01T10:00:00.000Z" });
    expect(state.history).toEqual([{ version: "0.1.0", at: "2026-11-01T10:00:00.000Z", reason: "install" }]);
    expect(readJsonFile(paths.config)).toEqual({ schema: 1, profile: "codex-only" });
    expect(existsSync(paths.managedSettings)).toBe(true);
    expect(readJsonFile(paths.piSettings).transport).toBe("sse");
    expect(out.join("\n")).toContain("fake doctor ran");
    expect(await readLockHolder(paths)).toBeUndefined();
  });

  it("claude absent → no bridge install", async () => {
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" });
    expect(log.some((l) => l.includes(BRIDGE_REF))).toBe(false);
  });

  it("claude present → installs the bridge after the factory package and proposes claude-codex", async () => {
    await applyRelease(ctx(new FakePi(), { claude: "present", codex: "present" }), { reason: "install" });
    const installs = log.filter((l) => l.startsWith("install "));
    expect(installs).toEqual([`install ${FACTORY_REF} cli=${FAKE_CLI} locked=true cwd=true`, `install ${BRIDGE_REF} cli=${FAKE_CLI} locked=true cwd=true`]);
    expect(readJsonFile(paths.config).profile).toBe("claude-codex");
  });

  it("appends to the previous history and records --from", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, PREVIOUS_STATE);
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "update", from: "0.0.9" });
    const history = readJsonFile(paths.state).history as Array<Record<string, unknown>>;
    expect(history.map((h) => h.reason)).toEqual(["install", "update"]);
    expect(history[1]).toEqual({ version: "0.1.0", at: "2026-11-01T10:00:00.000Z", reason: "update", from: "0.0.9" });
  });

  it.each(["update", "rollback"] as const)("--reason %s removes the journal after writing state, while still holding the lock", async (reason) => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.txn, TXN);
    const clearTxnSpy: ApplyDeps["clearTxn"] = async (p) => {
      const holder = await readLockHolder(p);
      log.push(`clearTxn state=${existsSync(p.state)} locked=${holder?.pid === process.pid}`);
      await rm(p.txn, { force: true });
    };
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }, { clearTxn: clearTxnSpy }), { reason, from: "0.0.9" });
    expect(log).toContain("clearTxn state=true locked=true");
    expect(existsSync(paths.txn)).toBe(false);
    expect(await readLockHolder(paths)).toBeUndefined();
  });

  it("keeps a history reason written by a newer release when it rewrites state.json (R13)", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, PREVIOUS_STATE.replace('"reason":"install"', '"reason":"reinstall-from-backup"'));
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "rollback", from: "0.2.0" });
    const history = readJsonFile(paths.state).history as Array<Record<string, unknown>>;
    expect(history.map((h) => h.reason)).toEqual(["reinstall-from-backup", "rollback"]);
  });

  it("a second apply keeps the first installedAt and appends history", async () => {
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" });
    const later = { ...ctx(new FakePi(), { claude: "absent", codex: "present" }), now: () => new Date("2026-11-05T08:00:00.000Z") };
    await applyRelease(later, { reason: "update", from: "0.0.9" });
    const state = readJsonFile(paths.state);
    expect(state.installedAt).toBe("2026-11-01T10:00:00.000Z");
    expect((state.history as Array<{ at: string }>).map((h) => h.at)).toEqual(["2026-11-01T10:00:00.000Z", "2026-11-05T08:00:00.000Z"]);
  });
});

describe("unfinished transaction (ruling R8)", () => {
  it("--reason install refuses while txn.json exists and touches nothing", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, PREVIOUS_STATE);
    await writeFile(paths.txn, TXN);
    const e = await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(err.join("\n")).toBe('A previous update did not finish. Run "factory rollback".');
    expect(readFileSync(paths.txn, "utf8")).toBe(TXN);
    expect(readFileSync(paths.state, "utf8")).toBe(PREVIOUS_STATE);
    expect(existsSync(guardPath())).toBe(false);
    expect(log).toEqual([]);
    expect(await readLockHolder(paths)).toBeUndefined();
  });
});

describe("preflight before any change (I2)", () => {
  const NEWER_STATE = PREVIOUS_STATE.replaceAll("0.0.9", "0.2.0");

  it("--reason install refuses when the installed factory is newer than this release; guard, Pi and state untouched", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, NEWER_STATE);
    const e = await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    const text = err.join("\n");
    expect(text).toContain("Installed factory 0.2.0 is newer than this release (0.1.0). Nothing was changed.");
    expect(text).toContain('use "factory rollback 0.1.0"');
    expect(readFileSync(paths.state, "utf8")).toBe(NEWER_STATE);
    expect(existsSync(guardPath())).toBe(false);
    expect(log).toEqual([]);
    expect(await readLockHolder(paths)).toBeUndefined();
  });

  it("--reason rollback applies an older release over a newer state (the parent decided)", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, NEWER_STATE);
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "rollback", from: "0.2.0" });
    expect(readJsonFile(paths.state).version).toBe("0.1.0");
  });

  it("no migration path → refuses before the guard copy and any Pi change", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, PREVIOUS_STATE);
    await writeFile(paths.config, JSON.stringify({ schema: 2, profile: "codex-only" }));
    const e = await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    const text = err.join("\n");
    expect(text).toContain("No migration path for config.json from schema 2 to schema 1.");
    expect(text).toContain("Nothing was changed.");
    expect(existsSync(guardPath())).toBe(false);
    expect(log).toEqual([]);
    expect(readFileSync(paths.state, "utf8")).toBe(PREVIOUS_STATE);
  });
});

describe("after state is written", () => {
  it("a doctor that throws does not turn a completed install into a failure", async () => {
    const throwing: Partial<ApplyDeps> = {
      runDoctor: async () => {
        throw new Error("doctor exploded");
      },
    };
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }, throwing), { reason: "install" });
    expect(readJsonFile(paths.state).version).toBe("0.1.0");
    expect(err.join("\n")).not.toContain("Install did not complete");
    expect(err.join("\n")).toContain("doctor exploded");
  });
});

describe("personal config", () => {
  it("existing config.json bytes unchanged", async () => {
    await mkdir(paths.home, { recursive: true });
    const bytes = `{ "schema": 1,   "profile": "codex-only", "mine": true }\n`;
    await writeFile(paths.config, bytes);
    await applyRelease(ctx(new FakePi(), { claude: "present", codex: "present" }), { reason: "install", profile: "claude-codex" });
    expect(readFileSync(paths.config, "utf8")).toBe(bytes);
  });

  it("--profile is used when no config exists", async () => {
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "absent" }), { reason: "install", profile: "claude-codex" });
    expect(readJsonFile(paths.config)).toEqual({ schema: 1, profile: "claude-codex" });
  });

  it("an unknown --profile fails before state is written", async () => {
    const e = await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install", profile: "nope" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(err.join("\n")).toMatch(/Unknown profile "nope".*claude-codex, codex-only/);
    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.config)).toBe(false);
  });

  it("no login and no --profile → stops with both login instructions, state untouched", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, PREVIOUS_STATE);
    const e = await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "unknown" }), { reason: "install" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    const text = err.join("\n");
    expect(text).toContain("Install did not complete:");
    expect(text).toMatch(/Claude Code.*\/login/);
    expect(text).toMatch(/\/login.*ChatGPT/);
    expect(readFileSync(paths.state, "utf8")).toBe(PREVIOUS_STATE);
    expect(existsSync(paths.config)).toBe(false);
    expect(await readLockHolder(paths)).toBeUndefined();
  });
});

describe("profile proposal (R15)", () => {
  function tty(answer: boolean, asked: string[]): CliIO {
    return {
      out: (s) => void out.push(s),
      err: (s) => void err.push(s),
      confirm: async (q) => {
        asked.push(q);
        return answer;
      },
      isTTY: true,
    };
  }

  it("on a terminal it shows the proposed profile and writes it once confirmed", async () => {
    const asked: string[] = [];
    const c = { ...ctx(new FakePi(), { claude: "absent", codex: "present" }), io: tty(true, asked) };
    await applyRelease(c, { reason: "install" });
    expect(out.join("\n")).toContain("Proposed profile: codex-only (logins: claude absent, codex present)");
    expect(asked).toEqual(['Use profile "codex-only"?']);
    expect(readJsonFile(paths.config)).toEqual({ schema: 1, profile: "codex-only" });
  });

  it("declining stops before config.json and state.json are written and names --profile", async () => {
    const asked: string[] = [];
    const c = { ...ctx(new FakePi(), { claude: "present", codex: "present" }), io: tty(false, asked) };
    const e = await applyRelease(c, { reason: "install" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(asked).toEqual(['Use profile "claude-codex"?']);
    expect(err.join("\n")).toMatch(/no profile was chosen.*factory install --profile <name>.*claude-codex, codex-only/);
    expect(existsSync(paths.config)).toBe(false);
    expect(existsSync(paths.state)).toBe(false);
  });

  it.each([
    [{ yes: true }, "codex-only"],
    [{ profile: "claude-codex" }, "claude-codex"],
  ] as const)("on a terminal %j skips the question", async (extra, profile) => {
    const asked: string[] = [];
    const c = { ...ctx(new FakePi(), { claude: "absent", codex: "present" }), io: tty(false, asked) };
    await applyRelease(c, { reason: "install", ...extra });
    expect(asked).toEqual([]);
    expect(readJsonFile(paths.config).profile).toBe(profile);
  });

  it("without a terminal the proposal is shown and applied", async () => {
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" });
    expect(out.join("\n")).toContain("Proposed profile: codex-only");
    expect(readJsonFile(paths.config).profile).toBe("codex-only");
  });
});

describe("failure handling", () => {
  it("apply failure leaves previous state.json", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, PREVIOUS_STATE);
    const txn = JSON.stringify({ id: "t", kind: "update", from: "0.0.9", to: "0.1.0", snapshot: "s", startedAt: "2026-11-01T09:00:00.000Z" });
    await writeFile(paths.txn, txn);
    const pi = new FakePi((ref) => new UnresolvableRef(ref, "not-found", `tag v0.1.0 does not exist at ${SOURCE}`));

    const e = await applyRelease(ctx(pi, { claude: "absent", codex: "present" }), { reason: "update", from: "0.0.9" }).catch((x: unknown) => x);

    expect(e).toBeInstanceOf(Error);
    expect(readFileSync(paths.state, "utf8")).toBe(PREVIOUS_STATE);
    expect(readFileSync(paths.txn, "utf8")).toBe(txn);
    const text = err.join("\n");
    expect(text).toContain("Install did not complete: Cannot resolve package ref");
    expect(text).toContain('Previous state kept. Run "factory doctor"; after an update run "factory rollback".');
    expect(existsSync(guardPath())).toBe(true);
    expect(existsSync(paths.managedSettings)).toBe(false);
    expect(log.some((l) => l.startsWith("doctor"))).toBe(false);
    expect(await readLockHolder(paths)).toBeUndefined();
    const again = await acquireLock(paths);
    await again.release();
  });

  it("a lock held by another holder → fails without touching anything", async () => {
    const held = await acquireLock(paths);
    try {
      const e = await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "install" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(err.join("\n")).toMatch(/Install did not complete: Another factory process/);
      expect(existsSync(guardPath())).toBe(false);
      expect(log).toEqual([]);
    } finally {
      await held.release();
    }
  });

  it("--parent-lock borrows the parent's lock and leaves it held", async () => {
    const held = await acquireLock(paths);
    try {
      await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }), { reason: "update", from: "0.0.9", parentLockPid: process.pid });
      expect(readJsonFile(paths.state).version).toBe("0.1.0");
      expect((await readLockHolder(paths))?.pid).toBe(process.pid);
    } finally {
      await held.release();
    }
  });
});

describe("migrations", () => {
  it("applies the planned migrations to present documents before writing state", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.config, JSON.stringify({ schema: 1, profile: "codex-only" }));
    const bump: Migration = { id: "config-1-2", doc: "config.json", from: 1, to: 2, up: (d) => ({ ...(d as object), schema: 2, migrated: true }) };
    const m = ReleaseManifest.parse({ ...manifest, stateSchemas: { ...manifest.stateSchemas, "config.json": 2 } });
    await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }, { migrations: [bump] }, m), { reason: "install" });
    expect(readJsonFile(paths.config)).toEqual({ schema: 2, profile: "codex-only", migrated: true });
    expect(readJsonFile(paths.state).version).toBe("0.1.0");
  });

  it("no migration path → fails and state is untouched", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.state, PREVIOUS_STATE);
    await writeFile(paths.config, JSON.stringify({ schema: 1, profile: "codex-only" }));
    const m = ReleaseManifest.parse({ ...manifest, stateSchemas: { ...manifest.stateSchemas, "config.json": 3 } });
    const e = await applyRelease(ctx(new FakePi(), { claude: "absent", codex: "present" }, {}, m), { reason: "install" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(err.join("\n")).toContain("No migration path for config.json");
    expect(readFileSync(paths.state, "utf8")).toBe(PREVIOUS_STATE);
  });
});
