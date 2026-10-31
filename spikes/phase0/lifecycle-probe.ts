// Throwaway S8 probe. Env: SPIKE_EVENTLOG (absolute path). Appends {ts, event, detail} per lifecycle event.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function lifecycleProbe(pi: ExtensionAPI) {
	const log = (event: string, detail: unknown = null) => {
		if (process.env.SPIKE_EVENTLOG) appendFileSync(process.env.SPIKE_EVENTLOG, JSON.stringify({ ts: Date.now(), event, detail }) + "\n");
	};
	pi.on("input", (e) => {
		log("input", { source: e.source, streamingBehavior: e.streamingBehavior ?? null, textHead: e.text.slice(0, 40) });
		return { action: "continue" }; // observe only
	});
	pi.on("before_agent_start", () => log("before_agent_start"));
	pi.on("agent_start", () => log("agent_start"));
	pi.on("turn_start", () => log("turn_start"));
	pi.on("message_start", (e) => log("message_start", { role: (e as any).message?.role }));
	pi.on("message_end", (e) => log("message_end", { role: (e as any).message?.role }));
	pi.on("tool_execution_start", (e) => log("tool_execution_start", { toolName: (e as any).toolName }));
	pi.on("tool_execution_end", (e) => log("tool_execution_end", { toolName: (e as any).toolName }));
	pi.on("turn_end", () => log("turn_end"));
	pi.on("agent_end", () => log("agent_end"));
	pi.on("agent_settled", () => log("agent_settled"));
}
