// Pi extension used by the resume e2e (Task 13): a `hold` tool call that writes the HOLD_SENTINEL file and never
// resolves, so the test can kill Pi mid-run at a known point. The factory gate denies a tool it does not classify
// in print mode (ask without a UI), so the hold happens in this extension's own `tool_call` hook, which Pi runs
// before the factory's when this extension is loaded first; `execute` holds the same way when no gate is loaded.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** A pending promise alone does not keep Node's event loop alive (Pi would exit 0): an interval does. */
const forever = () =>
  new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });

function hold(): Promise<never> {
  const sentinel = process.env.HOLD_SENTINEL;
  if (sentinel) writeFileSync(sentinel, `${process.pid}\n`);
  return forever();
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "hold",
    label: "Hold",
    description: "Test-only tool: writes the sentinel file and never returns.",
    parameters: Type.Object({}),
    execute: () => hold(),
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName === "hold") await hold();
    return undefined;
  });
}
