// Throwaway S4/S5/S6 probe. Env: SPIKE_TOOLLOG, SPIKE_INVENTORY, SPIKE_BLOCK_WRITES, SPIKE_HEADERLOG.
import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED = new Set(["write", "edit", "bash"]);

export default function gateProbe(pi: ExtensionAPI) {
	const log = (o: object) => process.env.SPIKE_TOOLLOG && appendFileSync(process.env.SPIKE_TOOLLOG, JSON.stringify(o) + "\n");

	pi.on("session_start", () => {
		if (!process.env.SPIKE_INVENTORY) return;
		const tools = pi.getAllTools().map((t) => ({ name: t.name, exposure: t.exposure, annotations: t.annotations, source: t.sourceInfo }));
		writeFileSync(process.env.SPIKE_INVENTORY, JSON.stringify({ active: pi.getActiveTools(), tools }, null, 2));
	});

	pi.on("tool_call", (event) => {
		const block = process.env.SPIKE_BLOCK_WRITES === "1" && BLOCKED.has(event.toolName);
		log({ ts: Date.now(), event: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, inputKeys: Object.keys(event.input ?? {}), decision: block ? "blocked" : "allowed" });
		return block ? { block: true, reason: "spike gate" } : undefined;
	});

	pi.on("tool_execution_end", (event) => {
		const text = (Array.isArray(event.result?.content) ? event.result.content : []).map((c: any) => c?.text ?? "").join("");
		log({ event: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, textHead: text.slice(0, 200) });
	});

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections["spike-role"] = "End every final answer with the word PINEAPPLE.";
	});

	// S6: response header NAMES plus values of rate-limit headers only. Never request headers, never tokens.
	pi.on("after_provider_response", (event, ctx) => {
		if (!process.env.SPIKE_HEADERLOG) return;
		const headers = (event.headers ?? {}) as Record<string, string>;
		const rateLimit: Record<string, string> = {};
		for (const [k, v] of Object.entries(headers)) if (/ratelimit|rate-limit|retry-after|usage|quota|^x-codex-(active-limit|plan-type|primary|secondary|credits)/i.test(k)) rateLimit[k] = String(v);
		appendFileSync(process.env.SPIKE_HEADERLOG, JSON.stringify({ ts: Date.now(), provider: ctx?.model?.provider, model: ctx?.model?.id, status: event.status, headerNames: Object.keys(headers), rateLimit }) + "\n");
	});
}
