// Ruling R13 / ruling 11: v0.1.0's readers are frozen once tagged, so they must read documents that a
// newer release extended additively (new enum members) and keep the unknown values when they rewrite.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { listSnapshots } from "../../../src/adapters/store/snapshots.ts";
import { inspectStateDocs, readPersonalConfig, readState, writePersonalConfig, writeState } from "../../../src/adapters/store/state-store.ts";
import { readTxn } from "../../../src/adapters/store/transaction.ts";
import { CoreConfig, PersonalConfig } from "../../../src/core/config/schema.ts";
import { resolveConfig } from "../../../src/core/config/resolve.ts";
import { ReleaseManifest } from "../../../src/core/release/manifest.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const manifest = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));
const core = CoreConfig.parse(JSON.parse(readFileSync("defaults/config.json", "utf8")));

/** A config.json written by a future release that added a soft gate, an autonomy level and a provider. */
const FUTURE_CONFIG = {
  schema: 1,
  profile: "codex-only",
  autonomy: "autopilot",
  gates: { soften: ["design-approval", "future-gate"] },
  budgets: { claude: { weeklyTokens: 10 }, gemini: { weeklyTokens: 20 } },
};
const FUTURE_STATE = {
  schema: 1,
  version: "0.1.0",
  installedAt: "2026-10-01T00:00:00.000Z",
  source: "https://github.com/jrevenga/ai-factory.git",
  piVersion: "1.4.0",
  piCli: "/x/cli.js",
  history: [
    { version: "0.1.0", at: "2026-10-01T00:00:00.000Z", reason: "install" },
    { version: "0.3.0", at: "2026-10-05T00:00:00.000Z", reason: "reinstall-from-backup" },
    { version: "0.1.0", at: "2026-10-06T00:00:00.000Z", reason: "rollback", from: "0.3.0" },
  ],
};

let tmp: Tmp;
let paths: FactoryPaths;
beforeEach(async () => {
  tmp = await makeTmp("forward-compat");
  paths = factoryPaths(isolatedEnv(tmp.dir));
  await mkdir(paths.home, { recursive: true });
});
afterEach(async () => {
  await tmp.cleanup();
});

describe("forward compatibility of persisted documents (R13)", () => {
  it("config.json with a future soft gate, autonomy level and budget provider parses, passes the preflight and is preserved on rewrite", async () => {
    await writeFile(paths.config, JSON.stringify(FUTURE_CONFIG));
    expect(PersonalConfig.safeParse(FUTURE_CONFIG).success).toBe(true); // the handshake's configOk
    const read = await readPersonalConfig(paths);
    expect(read).toEqual(FUTURE_CONFIG);
    expect((await inspectStateDocs(paths, manifest.stateSchemas)).problems).toEqual([]);
    await writePersonalConfig(paths, read!);
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual(FUTURE_CONFIG);
  });

  it("effective config ignores unknown values with a violation each and keeps the lower layer's value", () => {
    const r = resolveConfig({ core, personal: PersonalConfig.parse(FUTURE_CONFIG) });
    expect(r.value.autonomy).toBe(core.autonomy);
    expect(r.provenance.get("autonomy")?.source).toBe("core");
    expect(r.value.gates.soften).toEqual(["design-approval"]);
    expect(r.value.budgets).toEqual({ claude: { weeklyTokens: 10 } });
    expect(r.violations).toEqual(
      expect.arrayContaining([
        { key: "autonomy", source: "personal", reason: "unknown" },
        { key: "gates.soften", source: "personal", reason: "unknown" },
        { key: "budgets.gemini", source: "personal", reason: "unknown" },
      ]),
    );
    expect(r.violations).toHaveLength(3);
  });

  it("state.json with a future history reason parses and keeps it on rewrite", async () => {
    await writeFile(paths.state, JSON.stringify(FUTURE_STATE));
    const state = await readState(paths);
    expect(state?.history[1]?.reason).toBe("reinstall-from-backup");
    await writeState(paths, { ...state!, history: [...state!.history, { version: "0.1.0", at: "2026-10-07T00:00:00.000Z", reason: "install" }] });
    expect(JSON.parse(readFileSync(paths.state, "utf8")).history[1].reason).toBe("reinstall-from-backup");
  });

  it("a journal and a snapshot with a future transaction kind are read, not rejected", async () => {
    await writeFile(paths.txn, JSON.stringify({ id: "s1", kind: "migrate", from: "0.3.0", to: "0.3.1", snapshot: "s1", startedAt: "2026-10-05T00:00:00.000Z" }));
    expect((await readTxn(paths))?.kind).toBe("migrate");
    const dir = join(paths.backups, "s1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "snapshot.json"), JSON.stringify({ id: "s1", from: "0.3.0", to: "0.3.1", kind: "migrate", at: "2026-10-05T00:00:00.000Z", files: [] }));
    expect((await listSnapshots(paths)).map((s) => s.kind)).toEqual(["migrate"]);
  });
});
