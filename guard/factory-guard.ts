// Self-contained Pi guard extension, installed into <agentDir>/extensions/ by the factory CLI.
// Until the factory extension reports a successful handshake (`factory:handshake`, ruling 8) it
// blocks every tool except the read-only ones. Guardrail, not a boundary: any extension can emit
// the event. Imports only types from Pi and nothing from src/ so it works as a single copied file.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GUARD_FILE_NAME = "factory-guard.ts";
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

const REASON = 'factory guard: factory extension not loaded or handshake failed — run "factory doctor"';

export function guardDecision(
  toolName: string,
  handshake: { ok: boolean } | undefined,
): { block: true; reason: string } | undefined {
  if (handshake?.ok === true) return undefined;
  if (READ_ONLY_TOOLS.includes(toolName)) return undefined;
  return { block: true, reason: REASON };
}

export default function factoryGuard(pi: ExtensionAPI): void {
  let handshake: { ok: boolean } | undefined;
  pi.events.on("factory:handshake", (data) => {
    const ok = typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === true;
    handshake = { ok };
  });
  pi.on("tool_call", (event) => guardDecision(event.toolName, handshake));
}
