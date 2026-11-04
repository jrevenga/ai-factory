import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GUARD_FILE_NAME } from "../../guard/factory-guard.ts";
import { isolatedEnv } from "../helpers/isolated-env.ts";
import { ensureTestPi, runPiPrint } from "../helpers/pi-harness.ts";
import { makeTmp } from "../helpers/tmp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAUX = join(ROOT, "test", "fixtures", "faux-provider.ts");
const EXTENSION = join(ROOT, "src", "adapters", "pi", "extension", "index.ts");
const OBSERVER = join(ROOT, "test", "fixtures", "observer.ts");
const GUARD = join(ROOT, "guard", GUARD_FILE_NAME);

type Result = { event: "tool_result"; toolName: string; isError: boolean; text: string };
function results(file: string): Result[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { event: string })
    .filter((o): o is Result => o.event === "tool_result");
}

let cli: string;
beforeAll(async () => {
  cli = await ensureTestPi();
}, 600_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(opts: { stateVersion?: string; script: unknown[] }) {
  const t = await makeTmp("guard-e2e");
  cleanups.push(t.cleanup);
  const env = isolatedEnv(t.dir);
  const home = env.FACTORY_HOME as string;
  const agentDir = env.PI_CODING_AGENT_DIR as string;
  mkdirSync(home, { recursive: true });
  // Pi auto-discovers global extensions in <agentDir>/extensions, which is what the test proves.
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  copyFileSync(GUARD, join(agentDir, "extensions", GUARD_FILE_NAME));
  if (opts.stateVersion !== undefined) {
    const v = opts.stateVersion;
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        schema: 1,
        version: v,
        installedAt: "2026-10-31T00:00:00.000Z",
        source: "https://github.com/jrevenga/ai-factory.git",
        piVersion: "1.4.0",
        piCli: "/nonexistent/cli.js",
        history: [{ version: v, at: "2026-10-31T00:00:00.000Z", reason: "install" }],
      }),
    );
  }
  const log = join(t.dir, "observed.jsonl");
  env.OBSERVE_FILE = log;
  env.FAUX_SCRIPT = JSON.stringify(opts.script);
  return { dir: t.dir, env, agentDir, log };
}

async function run(s: Awaited<ReturnType<typeof setup>>, extensions: string[]) {
  const r = await runPiPrint({ cli, agentDir: s.agentDir, cwd: s.dir, env: s.env, extensions: [...extensions, OBSERVER] });
  expect(r.timedOut).toBe(false);
  expect(r.code, r.stderr).toBe(0);
  return results(s.log);
}

describe("factory guard (e2e, faux provider)", () => {
  it("without the factory extension a write is blocked by the guard", async () => {
    const s = await setup({ script: [] });
    const target = join(s.dir, "out.txt");
    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "write", args: { path: target, content: "x" } }]);
    const res = await run(s, [FAUX]);
    expect(existsSync(target)).toBe(false);
    expect(res).toHaveLength(1);
    expect(res[0]?.isError).toBe(true);
    expect(res[0]?.text).toContain("factory guard:");
  }, 120_000);

  it("without the factory extension a bash redirect is blocked", async () => {
    const s = await setup({ script: [] });
    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "bash", args: { command: "echo x > out2.txt" } }]);
    const res = await run(s, [FAUX]);
    expect(existsSync(join(s.dir, "out2.txt"))).toBe(false);
    expect(res[0]?.isError).toBe(true);
    expect(res[0]?.text).toContain("factory guard:");
  }, 120_000);

  it("without the factory extension a read of an existing file is not blocked", async () => {
    const s = await setup({ script: [] });
    const f = join(s.dir, "exists.txt");
    writeFileSync(f, "hello");
    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "read", args: { path: f } }]);
    const res = await run(s, [FAUX]);
    expect(res).toHaveLength(1);
    expect(res[0]?.isError).toBe(false);
    expect(res[0]?.text).not.toContain("factory guard");
  }, 120_000);

  it("with the factory extension and a valid state the guard steps aside and the factory gate decides", async () => {
    const s = await setup({ stateVersion: "0.1.0", script: [] });
    const target = join(s.dir, "out.txt");
    s.env.FAUX_SCRIPT = JSON.stringify([
      { tool: "bash", args: { command: "echo guard-ok" } },
      { tool: "write", args: { path: target, content: "x" } },
    ]);
    const res = await run(s, [FAUX, EXTENSION]);
    // The guard blocks bash without a handshake; here the read-only command runs.
    expect(res[0]).toMatchObject({ toolName: "bash", isError: false });
    expect(res[0]?.text).toContain("guard-ok");
    // The write is now decided by the GatePolicy (answer route), not by the guard.
    expect(res[1]).toMatchObject({ toolName: "write", isError: true });
    expect(res[1]?.text).toContain("the answer route cannot write");
    expect(res[1]?.text).not.toContain("factory guard:");
    expect(existsSync(target)).toBe(false);
  }, 120_000);

  it("with the factory extension and a mismatched state the write is blocked", async () => {
    const s = await setup({ stateVersion: "9.9.9", script: [] });
    const target = join(s.dir, "out.txt");
    s.env.FAUX_SCRIPT = JSON.stringify([{ tool: "write", args: { path: target, content: "x" } }]);
    const res = await run(s, [FAUX, EXTENSION]);
    expect(existsSync(target)).toBe(false);
    expect(res[0]?.isError).toBe(true);
    expect(res[0]?.text).toMatch(/factory (guard|handshake failed)/);
  }, 120_000);
});
