// Pi extension used by e2e tests: appends one JSON line per observed event to OBSERVE_FILE
// (`factory:handshake` payloads and tool results), so tests can assert what happened inside Pi.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const file = process.env.OBSERVE_FILE;
  if (!file) return;
  const record = (entry: unknown) => appendFileSync(file, `${JSON.stringify(entry)}\n`);
  pi.events.on("factory:handshake", (data) => record({ event: "handshake", data }));
  // message_end sees every tool result, including calls that a tool_call handler blocked.
  pi.on("message_end", (event) => {
    const m = event.message;
    if (m.role !== "toolResult") return;
    const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    record({ event: "tool_result", toolName: m.toolName, isError: m.isError, text });
  });
}
