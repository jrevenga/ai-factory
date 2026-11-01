import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installWarningFilter } from "../../bin/warning-filter.mjs";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { runDoctor, type DoctorCheck } from "../../src/cli/commands/doctor.ts";
import { main } from "../../src/cli/main.ts";
import { packageRef, ReleaseManifest } from "../../src/core/release/manifest.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

const manifest = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));
// The first node:sqlite import prints an ExperimentalWarning; the CLI entry hides it, so do the same here.
let restoreEmit: typeof process.emitWarning;
beforeAll(() => {
  restoreEmit = process.emitWarning;
  installWarningFilter(process);
});
afterAll(() => {
  process.emitWarning = restoreEmit;
});

let tmp: Tmp;
let env: NodeJS.ProcessEnv;
let paths: FactoryPaths;

beforeEach(async () => {
  tmp = await makeTmp("doctor");
  env = { ...isolatedEnv(tmp.dir), FACTORY_SOURCE: "http://127.0.0.1:1/x/y.git", PI_OFFLINE: "1" };
  paths = factoryPaths(env);
});
afterEach(async () => {
  await tmp.cleanup();
});

const byId = (checks: DoctorCheck[], id: string): DoctorCheck | undefined => checks.find((c) => c.id === id);
const throwingFetch: typeof fetch = () => {
  throw new Error("network call");
};

describe("doctor on an empty environment", () => {
  it("fails state and pi-pinned, every failure has a fix without sudo", async () => {
    const checks = await runDoctor({ paths, env, offline: true, manifest });
    expect(byId(checks, "state")?.status).toBe("fail");
    expect(byId(checks, "pi-pinned")?.status).toBe("fail");
    for (const c of checks.filter((x) => x.status === "fail")) {
      expect(c.fix, c.id).toBeTruthy();
      expect(c.fix, c.id).not.toMatch(/sudo|administrator/i);
    }
  });

  it("node-sqlite-fts5 is ok", async () => {
    expect(byId(await runDoctor({ paths, env, offline: true, manifest }), "node-sqlite-fts5")?.status).toBe("ok");
  });

  it("warns about the source override", async () => {
    expect(byId(await runDoctor({ paths, env, offline: true, manifest }), "source-override")?.status).toBe("warn");
  });

  it("an empty FACTORY_SOURCE is no override, and the package ref uses the release's source", async () => {
    const checks = await runDoctor({ paths, env: { ...env, FACTORY_SOURCE: "" }, offline: true, manifest });
    expect(byId(checks, "source-override")?.status).toBe("ok");
    expect(byId(checks, "factory-package")?.message).toContain("git:https://github.com/jrevenga/ai-factory.git@v0.1.0");
  });
});

describe("offline", () => {
  it("offline doctor makes no network call", async () => {
    const t0 = Date.now();
    const checks = await runDoctor({ paths, env, offline: true, manifest, fetchFn: throwingFetch });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(byId(checks, "repo-access")).toBeUndefined();
    expect(byId(checks, "provider-reachability")).toBeUndefined();
  });

  it("online doctor reports repo-access network failure with a fix", async () => {
    const t0 = Date.now();
    const checks = await runDoctor({ paths, env, offline: false, manifest, fetchFn: async () => new Response(null) });
    expect(Date.now() - t0).toBeLessThan(20_000);
    const repo = byId(checks, "repo-access");
    expect(repo?.status).toBe("fail");
    expect(repo?.fix).toMatch(/network/i);
    expect(byId(checks, "provider-reachability")?.status).toBe("ok");
  });
});

describe("installed pieces", () => {
  it("factory-package is ok when Pi settings contain the ref built from the override", async () => {
    mkdirSync(paths.piAgentDir, { recursive: true });
    writeFileSync(paths.piSettings, JSON.stringify({ packages: [packageRef(manifest, env)] }));
    const checks = await runDoctor({ paths, env, offline: true, manifest });
    expect(byId(checks, "factory-package")?.status).toBe("ok");
    expect(byId(checks, "pi-settings")?.status).toBe("ok");
  });

  it("guard: matching file ok, modified file fails with factory install", async () => {
    mkdirSync(paths.piExtensions, { recursive: true });
    const target = join(paths.piExtensions, "factory-guard.ts");
    copyFileSync("guard/factory-guard.ts", target);
    expect(byId(await runDoctor({ paths, env, offline: true, manifest }), "guard")?.status).toBe("ok");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n// tampered\n`);
    const guard = byId(await runDoctor({ paths, env, offline: true, manifest }), "guard");
    expect(guard?.status).toBe("fail");
    expect(guard?.fix).toBe("factory install");
  });

  it("a pending txn.json fails txn with factory rollback", async () => {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.txn, JSON.stringify({ id: "a", kind: "update", from: "0.1.0", to: "0.2.0", snapshot: "a", startedAt: "2026-11-01T00:00:00Z" }));
    const txn = byId(await runDoctor({ paths, env, offline: true, manifest }), "txn");
    expect(txn?.status).toBe("fail");
    expect(txn?.fix).toBe("factory rollback");
  });

  it("managed-settings warns on a non-sse transport and never writes", async () => {
    mkdirSync(paths.piAgentDir, { recursive: true });
    writeFileSync(paths.piSettings, JSON.stringify({ transport: "websocket" }));
    const checks = await runDoctor({ paths, env, offline: true, manifest });
    const m = byId(checks, "managed-settings");
    expect(m?.status).toBe("warn");
    expect(m?.message).toMatch(/Codex limits will be unknown/);
    expect(JSON.parse(readFileSync(paths.piSettings, "utf8"))).toEqual({ transport: "websocket" });
    expect(() => readFileSync(paths.managedSettings)).toThrow();
  });
});

describe("main doctor", () => {
  it("exits 1 on a failing check and emits JSON", async () => {
    const out: string[] = [];
    const code = await main(["doctor", "--offline", "--json"], { out: (s) => void out.push(s), err: () => {}, confirm: async () => false, isTTY: false }, { env });
    expect(code).toBe(1);
    expect((JSON.parse(out.join("")) as DoctorCheck[]).some((c) => c.id === "state" && c.status === "fail")).toBe(true);
  });
});

describe("bin", () => {
  it("prints the version with empty stderr", () => {
    const r = spawnSync(process.execPath, ["bin/factory.mjs", "version"], { encoding: "utf8", env });
    expect(r.stdout.trim()).toBe("0.1.0");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("configuration diagnostics", () => {
  const fakeRoot = (profiles: Record<string, string>): string => {
    const root = join(tmp.dir, "root");
    mkdirSync(join(root, "defaults"), { recursive: true });
    mkdirSync(join(root, "profiles"), { recursive: true });
    copyFileSync("defaults/config.json", join(root, "defaults", "config.json"));
    for (const [name, text] of Object.entries(profiles)) writeFileSync(join(root, "profiles", name), text);
    return root;
  };

  it("missing personal config warns and points to factory install", async () => {
    const c = byId(await runDoctor({ paths, env, offline: true, manifest }), "config");
    expect(c?.status).toBe("warn");
    expect(c?.message + (c?.fix ?? "")).toMatch(/factory install/);
  });

  it("malformed personal config fails with its path and skips dependent checks", async () => {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.config, "{ not json");
    const checks = await runDoctor({ paths, env, offline: false, manifest, fetchFn: async () => new Response(null) });
    const c = byId(checks, "config");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain(paths.config);
    expect(c?.fix).toBeTruthy();
    for (const id of ["parallelism", "provider-reachability"]) {
      expect(byId(checks, id)?.status, id).toBe("warn");
      expect(byId(checks, id)?.message, id).toMatch(/config/);
    }
  });

  it("schema-invalid personal config fails", async () => {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ schema: 1 }));
    expect(byId(await runDoctor({ paths, env, offline: true, manifest }), "config")?.status).toBe("fail");
  });

  it("a malformed profile file fails profiles with its path", async () => {
    const root = fakeRoot({ "bad.json": "{ nope" });
    const checks = await runDoctor({ paths, env, offline: true, manifest, root });
    const p = byId(checks, "profiles");
    expect(p?.status).toBe("fail");
    expect(p?.message).toContain("bad.json");
    expect(p?.fix).toBeTruthy();
  });

  it("valid profiles pass", async () => {
    const root = fakeRoot({ "claude-codex.json": readFileSync("profiles/claude-codex.json", "utf8") });
    expect(byId(await runDoctor({ paths, env, offline: true, manifest, root }), "profiles")?.status).toBe("ok");
  });
});

describe("git child environment", () => {
  it.skipIf(process.platform === "win32")("the git version probe runs non-interactively", async () => {
    const bin = join(tmp.dir, "fake bin");
    mkdirSync(bin, { recursive: true });
    const dump = join(tmp.dir, "git-env.txt");
    const script = join(bin, "git");
    writeFileSync(script, `#!/bin/sh\n[ -e "${dump}" ] || env > "${dump}"\necho "git version 0.0.0"\n`, { mode: 0o755 });
    await runDoctor({ paths, env: { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ""}` }, offline: true, manifest });
    const dumped = readFileSync(dump, "utf8");
    expect(dumped).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
    expect(dumped).toMatch(/^GCM_INTERACTIVE=never$/m);
  });
});
