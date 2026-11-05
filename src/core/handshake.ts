// Startup handshake between the installed factory (state.json) and the Pi package actually loaded.
// `policy` names the GatePolicy version the loaded package enforces in its `tool_call` hook (Phase 2: "v1").

export type HandshakeReason = "not-installed" | "version-mismatch" | "config-invalid" | "store-unwritable";

export interface HandshakeInput {
  /** `state.json` version; undefined when the factory is not installed (missing or invalid state). */
  expectedVersion: string | undefined;
  /** Version of the Pi package that is running (its own package.json). */
  packageVersion: string;
  configOk: boolean;
  storeWritable: boolean;
}

export interface HandshakeResult {
  ok: boolean;
  version: string;
  policy: "v1";
  reasons: HandshakeReason[];
}

/** Tools allowed while a handshake has failed (or has not succeeded yet): read-only inspection. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export const HANDSHAKE_EVENT = "factory:handshake";

export function evaluateHandshake(input: HandshakeInput): HandshakeResult {
  const reasons: HandshakeReason[] = [];
  if (input.expectedVersion === undefined) reasons.push("not-installed");
  else if (input.expectedVersion !== input.packageVersion) reasons.push("version-mismatch");
  if (!input.configOk) reasons.push("config-invalid");
  if (!input.storeWritable) reasons.push("store-unwritable");
  return { ok: reasons.length === 0, version: input.packageVersion, policy: "v1", reasons };
}

export function handshakeFailureMessage(result: HandshakeResult): string {
  return `factory handshake failed: ${result.reasons.join(", ")}`;
}
