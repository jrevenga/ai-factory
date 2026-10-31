// Pi extension used by e2e tests: registers the offline faux provider `factory-test/faux`.
// FAUX_SCRIPT (JSON array of { tool, args }) becomes one tool-call message per entry, then "done".
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ScriptStep {
  tool: string;
  args: ToolCall["arguments"];
}

function script(): ScriptStep[] {
  const raw = process.env.FAUX_SCRIPT;
  if (raw === undefined || raw === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("FAUX_SCRIPT must be a JSON array of { tool, args }");
  return parsed as ScriptStep[];
}

export default function (pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "factory-test", models: [{ id: "faux" }] });
  faux.setResponses([
    ...script().map((s) => fauxAssistantMessage(fauxToolCall(s.tool, s.args), { stopReason: "toolUse" })),
    fauxAssistantMessage("done"),
  ]);
  pi.registerProvider(faux.provider);
}
