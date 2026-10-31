// The factory's Pi package extension (package.json "pi.extensions"). Runs inside Pi.
// On session_start it checks that the installed factory (state.json) matches this package, that the
// personal config parses and that FACTORY_HOME is writable, then emits `factory:handshake` for the
// guard (ruling 8). While the handshake has failed, its own tool_call handler blocks every tool except
// the read-only ones, which covers "loaded but handshake failed" even without the guard file.
import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PersonalConfig } from "../../../core/config/schema.ts";
import {
  evaluateHandshake,
  HANDSHAKE_EVENT,
  handshakeFailureMessage,
  READ_ONLY_TOOLS,
  type HandshakeResult,
} from "../../../core/handshake.ts";
import { FactoryState } from "../../../core/state/schema.ts";

const PACKAGE_JSON = fileURLToPath(new URL("../../../../package.json", import.meta.url));

/** Same resolution as src/adapters/platform/paths.ts (which the extension may not import). */
function factoryHome(env: NodeJS.ProcessEnv): string {
  const p = env.FACTORY_HOME;
  if (!p) return join(homedir(), ".factory");
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return join(homedir(), p.slice(2));
  return resolve(p);
}

type Read = { kind: "missing" } | { kind: "json"; value: unknown } | { kind: "error" };

async function readJson(path: string): Promise<Read> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "error" };
  }
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    return { kind: "error" };
  }
}

/** Missing or invalid state both mean "not installed" for the handshake. */
async function installedVersion(home: string): Promise<string | undefined> {
  const r = await readJson(join(home, "state.json"));
  if (r.kind !== "json") return undefined;
  const parsed = FactoryState.safeParse(r.value);
  return parsed.success ? parsed.data.version : undefined;
}

/** An unreadable package.json yields "unknown", which never matches a state version (fails closed). */
async function packageVersion(): Promise<string> {
  const r = await readJson(PACKAGE_JSON);
  if (r.kind === "json" && typeof r.value === "object" && r.value !== null) {
    const v = (r.value as { version?: unknown }).version;
    if (typeof v === "string" && v !== "") return v;
  }
  return "unknown";
}

/** No personal config yet is fine (defaults apply); one that exists must parse. */
async function configOk(home: string): Promise<boolean> {
  const r = await readJson(join(home, "config.json"));
  if (r.kind === "missing") return true;
  return r.kind === "json" && PersonalConfig.safeParse(r.value).success;
}

async function storeWritable(home: string): Promise<boolean> {
  const probe = join(home, `.handshake-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch {
    return false;
  }
  await unlink(probe).catch(() => undefined);
  return true;
}

async function runHandshake(env: NodeJS.ProcessEnv = process.env): Promise<HandshakeResult> {
  const home = factoryHome(env);
  const [expectedVersion, version, config, writable] = await Promise.all([
    installedVersion(home),
    packageVersion(),
    configOk(home),
    storeWritable(home),
  ]);
  return evaluateHandshake({ expectedVersion, packageVersion: version, configOk: config, storeWritable: writable });
}

function report(ctx: ExtensionContext, result: HandshakeResult): void {
  const message = handshakeFailureMessage(result);
  // Print and JSON modes have no UI (Pi docs/extensions.md); stderr keeps stdout clean there.
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else process.stderr.write(`${message}\n`);
}

export default function factoryExtension(pi: ExtensionAPI): void {
  let current: Promise<HandshakeResult> | undefined;

  const start = (ctx: ExtensionContext): Promise<HandshakeResult> => {
    current = runHandshake().then((result) => {
      pi.events.emit(HANDSHAKE_EVENT, result);
      if (!result.ok) report(ctx, result);
      return result;
    });
    return current;
  };

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const result = await (current ?? start(ctx));
    if (result.ok || READ_ONLY_TOOLS.includes(event.toolName)) return undefined;
    return { block: true, reason: handshakeFailureMessage(result) };
  });
}
