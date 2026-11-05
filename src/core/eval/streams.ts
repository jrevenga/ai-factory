// Pure parsers of contender output streams: usage, quota, session, final message (Phase 3 ruling 13).
import type { ProviderId } from "./contenders.ts";
import type { QuotaStatus, Usage } from "./records.ts";

export type ParsedStream = {
  usage: Partial<Record<ProviderId, Usage>>;
  quota: Partial<Record<ProviderId, QuotaStatus>>;
  sessionId: string | null;
  finalMessage: string | null;
  error: string | null;
  limitHit: ProviderId | null;
  malformedLines: number;
};

type Json = Record<string, unknown>;

const LIMIT_RE = /usage limit|rate limit|quota/i;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
function validCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function emptyParsed(): ParsedStream {
  return { usage: {}, quota: {}, sessionId: null, finalMessage: null, error: null, limitHit: null, malformedLines: 0 };
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return { ...b };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** Parse JSONL: objects only; non-empty lines failing JSON.parse (or not objects) count as malformed. */
function readEvents(text: string): { events: Json[]; malformed: number } {
  const events: Json[] = [];
  let malformed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObj(v)) events.push(v);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

export function parseClaudeStream(text: string): ParsedStream {
  const out = emptyParsed();
  const { events, malformed } = readEvents(text);
  out.malformedLines = malformed;
  let rate: Json | null = null;
  let usage: Usage | undefined;
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      out.sessionId = str(e.session_id) ?? out.sessionId;
    } else if (e.type === "rate_limit_event" && isObj(e.rate_limit_info)) {
      rate = e.rate_limit_info;
    } else if (e.type === "result") {
      out.sessionId = str(e.session_id) ?? out.sessionId;
      out.finalMessage = typeof e.result === "string" ? e.result : out.finalMessage;
      if (isObj(e.usage) && validCount(e.usage.input_tokens) && validCount(e.usage.output_tokens)) {
        usage = {
          input: num(e.usage.input_tokens),
          output: num(e.usage.output_tokens),
          cacheRead: num(e.usage.cache_read_input_tokens),
          cacheWrite: num(e.usage.cache_creation_input_tokens),
        };
      }
      if (e.is_error === true || (e.subtype !== undefined && e.subtype !== "success")) {
        const sub = e.subtype !== "success" ? str(e.subtype) : null;
        const text = str(e.result);
        out.error = sub !== null && text !== null ? `${sub}: ${text}` : (sub ?? text ?? "error");
      }
    }
  }
  if (usage) out.usage.claude = usage;
  if (rate) {
    if (rate.status === "rejected") out.quota.claude = { state: "exhausted" };
    else if (typeof rate.utilization === "number") {
      const q: QuotaStatus = { state: "known", utilization: rate.utilization };
      if (typeof rate.rateLimitType === "string") q.window = rate.rateLimitType;
      if (typeof rate.resetsAt === "number" && Number.isFinite(rate.resetsAt)) {
        const d = new Date(rate.resetsAt * 1000);
        if (!Number.isNaN(d.getTime())) q.resetsAt = d.toISOString();
      }
      out.quota.claude = q;
    } else out.quota.claude = { state: "unknown" };
  } else if (usage) out.quota.claude = { state: "unknown" };
  if (out.quota.claude?.state === "exhausted" || (out.error !== null && LIMIT_RE.test(out.error))) {
    out.limitHit = "claude";
  }
  return out;
}

export function parseCodexStream(text: string): ParsedStream {
  const out = emptyParsed();
  const { events, malformed } = readEvents(text);
  out.malformedLines = malformed;
  let usage: Usage | undefined;
  for (const e of events) {
    if (e.type === "thread.started") {
      out.sessionId = str(e.thread_id) ?? out.sessionId;
    } else if (e.type === "item.completed" && isObj(e.item) && e.item.type === "agent_message") {
      if (typeof e.item.text === "string") out.finalMessage = e.item.text;
    } else if (e.type === "turn.completed" && isObj(e.usage) && validCount(e.usage.input_tokens) && validCount(e.usage.output_tokens)) {
      const cached = num(e.usage.cached_input_tokens);
      usage = addUsage(usage, {
        input: Math.max(0, num(e.usage.input_tokens) - cached),
        output: num(e.usage.output_tokens),
        cacheRead: cached,
        cacheWrite: 0,
      });
    } else if (e.type === "turn.failed") {
      out.error = (isObj(e.error) ? str(e.error.message) : null) ?? "turn failed";
    } else if (e.type === "error") {
      out.error = str(e.message) ?? out.error ?? "error";
    }
  }
  if (usage) {
    out.usage.codex = usage;
    out.quota.codex = { state: "unknown" };
  }
  if (out.error !== null && LIMIT_RE.test(out.error)) out.limitHit = "codex";
  return out;
}

const PI_PROVIDERS: Record<string, ProviderId> = { "claude-bridge": "claude", "openai-codex": "codex" };

export function parsePiStream(text: string): ParsedStream {
  const out = emptyParsed();
  const { events, malformed } = readEvents(text);
  out.malformedLines = malformed;
  for (const e of events) {
    if (e.type === "session") {
      out.sessionId = str(e.id) ?? out.sessionId;
      continue;
    }
    if (e.type !== "message_end" || !isObj(e.message) || e.message.role !== "assistant") continue;
    const m = e.message;
    const provider = typeof m.provider === "string" ? PI_PROVIDERS[m.provider] : undefined;
    if (provider && isObj(m.usage) && validCount(m.usage.input) && validCount(m.usage.output)) {
      out.usage[provider] = addUsage(out.usage[provider], {
        input: num(m.usage.input),
        output: num(m.usage.output),
        cacheRead: num(m.usage.cacheRead),
        cacheWrite: num(m.usage.cacheWrite),
      });
      out.quota[provider] = { state: "unknown" };
    }
    if (Array.isArray(m.content)) {
      const texts = m.content.filter((b): b is Json => isObj(b) && b.type === "text" && typeof b.text === "string");
      if (texts.length > 0) out.finalMessage = texts.map((b) => b.text as string).join("");
    }
    if (m.stopReason === "error") {
      out.error = str(m.errorMessage) ?? "error";
      if (provider && LIMIT_RE.test(out.error)) out.limitHit = provider;
    }
  }
  return out;
}

export function mergeParsed(turns: ParsedStream[]): ParsedStream {
  const out = emptyParsed();
  for (const t of turns) {
    for (const p of Object.keys(t.usage) as ProviderId[]) {
      const u = t.usage[p];
      if (u) out.usage[p] = addUsage(out.usage[p], u);
    }
    Object.assign(out.quota, t.quota);
    out.sessionId = t.sessionId ?? out.sessionId;
    out.finalMessage = t.finalMessage ?? out.finalMessage;
    out.error = t.error ?? out.error;
    out.limitHit = t.limitHit ?? out.limitHit;
    out.malformedLines += t.malformedLines;
  }
  return out;
}

export function endsWithQuestion(message: string | null): boolean {
  if (message === null) return false;
  const lines = message.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines[lines.length - 1];
  return last !== undefined && last.endsWith("?");
}
