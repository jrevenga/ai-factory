// Pi extension used by the gate e2e suite (Task 12). It registers two tools that the factory gate classifies as
// `unknown` (they are not Pi's built-in tools and not the factory's own):
// - `dangerous_tool` writes a marker file when it runs; the gate must block it before it runs.
// - `nested_call` runs other tools through Pi's nested-call API (`ctx.executeTool`, Pi 1.4.0 docs/extensions.md),
//   one after another or all at once, and reports each nested outcome as one JSON line. Nested calls carry the
//   parent's id as `parentToolCallId` and pass through the same `tool_call` hook as model-issued calls.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface NestedCall {
  tool: string;
  args: Record<string, unknown>;
}

function text(outcome: { result: { content: Array<{ type: string; text?: string }> } }): string {
  return outcome.result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dangerous_tool",
    label: "Dangerous tool",
    description: "Test-only tool: writes a marker file at `path` when it runs.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params: { path: string }) {
      writeFileSync(params.path, "dangerous_tool ran\n");
      return { content: [{ type: "text", text: `wrote ${params.path}` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "nested_call",
    label: "Nested call",
    description: "Test-only tool: runs `calls` through ctx.executeTool, in order or all at once (`parallel`).",
    parameters: Type.Object({
      calls: Type.Array(Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) })),
      parallel: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params: { calls: NestedCall[]; parallel?: boolean }, _signal, _onUpdate, ctx) {
      const run = (c: NestedCall) => ctx.executeTool(c.tool, c.args);
      const outcomes = [];
      if (params.parallel === true) {
        outcomes.push(...(await Promise.all(params.calls.map(run))));
      } else {
        for (const c of params.calls) outcomes.push(await run(c));
      }
      const lines = outcomes.map((o) => JSON.stringify({ id: o.toolCall.id, tool: o.toolCall.name, isError: o.isError, text: text(o) }));
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  });
}
