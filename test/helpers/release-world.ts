// A fake release world for `factory update` / `factory rollback` unit tests: remote tags, cloneable
// releases, npm, and the child `_apply-release` are all fakes; the factory home is a real temp dir.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RunResult } from "../../src/adapters/platform/process.ts";
import { factoryPaths, type FactoryPaths } from "../../src/adapters/platform/paths.ts";
import { clearTxn } from "../../src/adapters/store/transaction.ts";
import { readState, writeState } from "../../src/adapters/store/state-store.ts";
import { GitError } from "../../src/adapters/vcs/git.ts";
import type { ReleaseContext, ReleaseDeps } from "../../src/cli/commands/release-txn.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { ReleaseManifest } from "../../src/core/release/manifest.ts";
import type { FactoryState, StateDoc } from "../../src/core/state/schema.ts";
import { isolatedEnv } from "./isolated-env.ts";
import { makeTmp, type Tmp } from "./tmp.ts";

export const SOURCE = "http://127.0.0.1:1/fixture/ai-factory.git";
const BASE = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));

export interface FakeRelease {
  stateSchemas?: Partial<Record<StateDoc, number>>;
  nodeMin?: string;
  changelog?: string;
}

export function manifestFor(version: string, rel: FakeRelease = {}): ReleaseManifest {
  return {
    ...BASE,
    factory: version,
    stateSchemas: { ...BASE.stateSchemas, ...rel.stateSchemas },
    node: { ...BASE.node, min: rel.nodeMin ?? BASE.node.min },
  };
}

export interface World {
  tmp: Tmp;
  env: NodeJS.ProcessEnv;
  paths: FactoryPaths;
  log: string[];
  out: string[];
  err: string[];
  confirms: string[];
  confirmAnswer: boolean;
  /** Remote tag names returned by ls-remote. */
  tags: string[];
  /** Releases cloneTag can check out, keyed by tag. */
  releases: Record<string, FakeRelease>;
  /** Version of the last `npm install -g` spec, i.e. the CLI the child apply runs as. */
  installed: string | undefined;
  /** Fake child `_apply-release`; defaults to `realisticApply`. */
  onApply: (args: string[], w: World) => Promise<number>;
  npmFails: boolean;
  globalCli: string;
  ctx(over?: Partial<ReleaseDeps>): ReleaseContext;
  cleanup(): Promise<void>;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** What a real child does on success: writes state.json for its version, then clears the journal. */
export async function realisticApply(args: string[], w: World, opts: { clear?: boolean } = {}): Promise<number> {
  const prev = await readState(w.paths);
  if (prev === undefined || w.installed === undefined) throw new Error("fake apply needs a state and an installed version");
  const reason = flag(args, "--reason") as "update" | "rollback";
  const from = flag(args, "--from");
  await writeState(w.paths, {
    ...prev,
    version: w.installed,
    history: [...prev.history, { version: w.installed, at: "2026-11-01T10:00:00.000Z", reason, ...(from === undefined ? {} : { from }) }],
  });
  if (opts.clear !== false) await clearTxn(w.paths);
  return 0;
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, orphans: false });

export async function makeWorld(prefix: string): Promise<World> {
  const tmp = await makeTmp(prefix);
  const env = { ...isolatedEnv(tmp.dir), FACTORY_SOURCE: SOURCE, PI_OFFLINE: "1" };
  const globalRoot = join(tmp.dir, "global root");
  const globalCli = join(globalRoot, "ai-factory", "bin", "factory.mjs");
  await mkdir(join(globalCli, ".."), { recursive: true });
  await writeFile(globalCli, "// stand-in for the globally installed CLI\n");

  const w: World = {
    tmp,
    env,
    paths: factoryPaths(env),
    log: [],
    out: [],
    err: [],
    confirms: [],
    confirmAnswer: false,
    tags: [],
    releases: {},
    installed: undefined,
    onApply: (args, world) => realisticApply(args, world),
    npmFails: false,
    globalCli,
    ctx(over = {}) {
      const io: CliIO = {
        out: (s) => void w.out.push(s),
        err: (s) => void w.err.push(s),
        confirm: async (q) => {
          w.confirms.push(q);
          return w.confirmAnswer;
        },
        isTTY: false,
      };
      const deps: Partial<ReleaseDeps> = {
        lsRemoteTags: async (url) => {
          w.log.push(`ls-remote ${url}`);
          return [...w.tags];
        },
        cloneTag: async (url, tag, dest) => {
          w.log.push(`clone ${tag}`);
          const rel = w.releases[tag];
          if (rel === undefined) {
            throw new GitError(["clone", url], { code: 128, stderr: `fatal: Remote branch ${tag} not found in upstream origin`, timedOut: false });
          }
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, "release.json"), JSON.stringify(manifestFor(tag.slice(1), rel), null, 2));
          if (rel.changelog !== undefined) await writeFile(join(dest, "CHANGELOG.md"), rel.changelog);
        },
        npm: async (args) => {
          w.log.push(`npm ${args.join(" ")}`);
          if (args[0] === "root") return ok(`${globalRoot}\n`);
          if (w.npmFails) return { code: 1, stdout: "", stderr: "npm ERR! could not clone", timedOut: false, orphans: false };
          const spec = args[args.length - 1] ?? "";
          w.installed = spec.slice(spec.lastIndexOf("#v") + 2);
          return ok();
        },
        runNode: async (args) => {
          w.log.push(`node ${args.join(" ")}`);
          return w.onApply(args, w);
        },
        ...over,
      };
      return { paths: w.paths, env, manifest: BASE, io, now: () => new Date("2026-11-01T10:00:00.000Z"), deps };
    },
    cleanup: () => tmp.cleanup(),
  };
  return w;
}

export function stateAt(version: string, history: FactoryState["history"]): FactoryState {
  return {
    schema: 1,
    version,
    installedAt: "2026-10-01T00:00:00.000Z",
    source: SOURCE,
    piVersion: "1.4.0",
    piCli: "/fake/cli.js",
    history,
  };
}

/** Every file under `dir` (relative path → bytes as base64), for byte-for-byte comparisons. */
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}
