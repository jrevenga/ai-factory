import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLogins } from "../../../src/adapters/providers/logins.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

const isWindows = process.platform === "win32";
let tmp: Tmp;

beforeEach(async () => {
  tmp = await makeTmp("logins");
});

afterEach(async () => {
  await tmp.cleanup();
});

/** A fake executable `name` on a fresh bin dir that runs `script` (an .mjs) with node. */
async function fakeBin(name: string, script: string): Promise<string> {
  const bin = join(tmp.dir, "bin dir");
  await mkdir(bin, { recursive: true });
  const js = join(tmp.dir, `${name} impl.mjs`);
  await writeFile(js, script);
  if (isWindows) {
    await writeFile(join(bin, `${name}.cmd`), `@"${process.execPath}" "${js}" %*\r\n`);
  } else {
    const sh = join(bin, name);
    await writeFile(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
    await chmod(sh, 0o755);
  }
  return bin;
}

const ARGV_LOG = "process.env.ARGV_LOG && (await import('node:fs')).writeFileSync(process.env.ARGV_LOG, JSON.stringify({ argv: process.argv.slice(2), telemetry: process.env.PI_TELEMETRY ?? null }));";

const FAKE_CLAUDE = `${ARGV_LOG}
const mode = process.env.FAKE_MODE;
if (mode === "in") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
if (mode === "out") { console.log(JSON.stringify({ loggedIn: false, authMethod: "none" })); process.exit(1); }
if (mode === "hang") { setInterval(() => {}, 1000); }
else { console.log("not json"); process.exit(0); }
`;

const FAKE_PI = `${ARGV_LOG}
const mode = process.env.FAKE_MODE;
const out = (status, code) => { console.log(JSON.stringify({ status, provider: "openai-codex" })); process.exit(code); };
if (mode === "ready") out("ready", 0);
else if (mode === "not_ready") out("not_ready", 1);
else if (mode === "invalid") out("invalid", 2);
else if (mode === "hang") setInterval(() => {}, 1000);
else { console.error("boom"); process.exit(1); }
`;

describe("detectLogins: claude", () => {
  it("PATH without claude → absent", async () => {
    const empty = join(tmp.dir, "empty bin");
    await mkdir(empty);
    const r = await detectLogins({ env: { ...isolatedEnv(tmp.dir), PATH: empty } });
    expect(r.claude).toBe("absent");
  });

  it("maps claude auth status --json", async () => {
    const bin = await fakeBin("claude", FAKE_CLAUDE);
    const log = join(tmp.dir, "argv.json");
    const env = (mode: string) => ({ ...isolatedEnv(tmp.dir), PATH: bin + delimiter + (process.env.PATH ?? ""), FAKE_MODE: mode, ARGV_LOG: log });
    expect((await detectLogins({ env: env("in") })).claude).toBe("present");
    expect(JSON.parse(await readFile(log, "utf8")).argv).toEqual(["auth", "status", "--json"]);
    expect((await detectLogins({ env: env("out") })).claude).toBe("absent");
    expect((await detectLogins({ env: env("garbage") })).claude).toBe("unknown");
  });

  it("a hanging claude → unknown within the timeout", async () => {
    const bin = await fakeBin("claude", FAKE_CLAUDE);
    const env = { ...isolatedEnv(tmp.dir), PATH: bin + delimiter + (process.env.PATH ?? ""), FAKE_MODE: "hang" };
    const t0 = Date.now();
    expect((await detectLogins({ env, timeoutMs: 500 })).claude).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});

describe("detectLogins: codex", () => {
  it("no piCli → unknown", async () => {
    expect((await detectLogins({ env: isolatedEnv(tmp.dir) })).codex).toBe("unknown");
  });

  it("maps pinned Pi auth check, never passing --credentials", async () => {
    const cli = join(tmp.dir, "fake pi cli.mjs");
    await writeFile(cli, FAKE_PI);
    const log = join(tmp.dir, "argv.json");
    const env = (mode: string) => ({ ...isolatedEnv(tmp.dir), FAKE_MODE: mode, ARGV_LOG: log });
    expect((await detectLogins({ piCli: cli, env: env("ready") })).codex).toBe("present");
    const seen = JSON.parse(await readFile(log, "utf8")) as { argv: string[]; telemetry: string };
    expect(seen.argv).toEqual(["auth", "check", "--provider", "openai-codex", "--json", "--no-refresh"]);
    expect(seen.telemetry).toBe("0");
    expect((await detectLogins({ piCli: cli, env: env("not_ready") })).codex).toBe("absent");
    expect((await detectLogins({ piCli: cli, env: env("invalid") })).codex).toBe("invalid");
    expect((await detectLogins({ piCli: cli, env: env("error") })).codex).toBe("unknown");
  });

  it("a hanging or missing Pi → unknown", async () => {
    const cli = join(tmp.dir, "fake pi cli.mjs");
    await writeFile(cli, FAKE_PI);
    const env = { ...isolatedEnv(tmp.dir), FAKE_MODE: "hang" };
    expect((await detectLogins({ piCli: cli, env, timeoutMs: 500 })).codex).toBe("unknown");
    expect((await detectLogins({ piCli: join(tmp.dir, "missing.js"), env })).codex).toBe("unknown");
  });
});
