// Pi extension used by e2e tests: registers the offline faux provider `factory-test/faux`.
// FAUX_SCRIPT (JSON array of { tool, args, hold? } or { batch: [{ tool, args }, …] }) becomes one tool-call message
// per entry (a batch entry: one message with several tool calls; a `{ text }` entry: a final text answer that ends
// that agent run, so a later prompt of the same process gets the next entries), then "done".
// A step with `hold: { signal, release }` writes the `signal` file when its LLM call starts and answers only
// once the `release` file exists (60 s cap), which keeps the agent run open for steering tests.
// FAUX_CAPTURE, when set, receives one JSON line per LLM call with the messages the provider was given.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ScriptStep {
  tool: string;
  args: ToolCall["arguments"];
  hold?: { signal: string; release: string };
  /** One assistant message with several tool calls (Pi may run them in parallel); `tool`/`args` are then ignored. */
  batch?: Array<{ tool: string; args: ToolCall["arguments"] }>;
  /** A text answer (no tool call): the agent run ends here; `tool`/`args` are then ignored. */
  text?: string;
}

const HOLD_LIMIT_MS = 60_000;

function script(): ScriptStep[] {
  const raw = process.env.FAUX_SCRIPT;
  if (raw === undefined || raw === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("FAUX_SCRIPT must be a JSON array of { tool, args }");
  return parsed as ScriptStep[];
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + HOLD_LIMIT_MS;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`faux hold: ${file} did not appear within ${HOLD_LIMIT_MS} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export default function (pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "factory-test", models: [{ id: "faux" }] });
  const capture = process.env.FAUX_CAPTURE;
  const step =
    (make: () => AssistantMessage, hold?: ScriptStep["hold"]) =>
    async (context: { messages: unknown[] }): Promise<AssistantMessage> => {
      if (capture) appendFileSync(capture, `${JSON.stringify({ messages: context.messages })}\n`);
      if (hold) {
        writeFileSync(hold.signal, "");
        await waitForFile(hold.release);
      }
      return make();
    };
  faux.setResponses([
    ...script().map((s) =>
      step(
        () =>
          s.text !== undefined
            ? fauxAssistantMessage(s.text)
            : fauxAssistantMessage(s.batch ? s.batch.map((b) => fauxToolCall(b.tool, b.args)) : fauxToolCall(s.tool, s.args), {
                stopReason: "toolUse",
              }),
        s.hold,
      ),
    ),
    step(() => fauxAssistantMessage("done")),
  ]);
  pi.registerProvider(faux.provider);
}
