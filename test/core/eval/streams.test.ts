import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  endsWithQuestion,
  mergeParsed,
  parseClaudeStream,
  parseCodexStream,
  parsePiStream,
} from "../../../src/core/eval/streams.ts";

const fx = (name: string) => readFileSync(new URL(`../../fixtures/eval/streams/${name}.jsonl`, import.meta.url), "utf8");

describe("parseClaudeStream", () => {
  it("maps usage, session, final message and known quota", () => {
    const p = parseClaudeStream(fx("claude-ok"));
    expect(p.usage).toEqual({ claude: { input: 100, output: 50, cacheRead: 300, cacheWrite: 20 } });
    expect(p.sessionId).toBe("sess-claude-1");
    expect(p.finalMessage).toBe("All done.");
    expect(p.error).toBeNull();
    expect(p.limitHit).toBeNull();
    expect(p.malformedLines).toBe(0);
    expect(p.quota.claude).toEqual({
      state: "known",
      utilization: 0.42,
      window: "five_hour",
      resetsAt: new Date(1767225600 * 1000).toISOString(),
    });
  });
  it("keeps the question text", () => {
    const p = parseClaudeStream(fx("claude-question"));
    expect(endsWithQuestion(p.finalMessage)).toBe(true);
    expect(p.quota.claude).toEqual({ state: "unknown" });
  });
  it("rejected rate limit event means exhausted and limitHit", () => {
    const p = parseClaudeStream(fx("claude-ratelimit-rejected"));
    expect(p.quota.claude).toEqual({ state: "exhausted" });
    expect(p.limitHit).toBe("claude");
    expect(p.error).not.toBeNull();
  });
  it("non-success subtype is an error", () => {
    const p = parseClaudeStream(fx("claude-error"));
    expect(p.error).toBe("error_max_turns");
    expect(p.limitHit).toBeNull();
    expect(p.usage.claude?.input).toBe(1000);
  });
  it("counts malformed and torn lines, ignores unknown types", () => {
    const p = parseClaudeStream(fx("truncated"));
    expect(p.malformedLines).toBe(2);
    expect(p.sessionId).toBe("sess-trunc");
    expect(p.usage).toEqual({});
    expect(p.finalMessage).toBeNull();
  });
});

describe("parseCodexStream", () => {
  it("sums turns and splits cached input", () => {
    const p = parseCodexStream(fx("codex-ok"));
    expect(p.usage).toEqual({ codex: { input: 600, output: 100, cacheRead: 900, cacheWrite: 0 } });
    expect(p.sessionId).toBe("thread-1");
    expect(p.finalMessage).toBe("Finished the task.");
    expect(p.error).toBeNull();
    expect(p.quota.codex).toEqual({ state: "unknown" });
  });
  it("turn failure sets error and limitHit", () => {
    const p = parseCodexStream(fx("codex-failed"));
    expect(p.error).toMatch(/usage limit/);
    expect(p.limitHit).toBe("codex");
    expect(p.usage).toEqual({});
    expect(p.sessionId).toBe("thread-2");
  });
});

describe("parsePiStream", () => {
  it("sums bridge usage and joins last assistant text", () => {
    const p = parsePiStream(fx("pi-bridge-ok"));
    expect(p.usage).toEqual({ claude: { input: 15, output: 12, cacheRead: 150, cacheWrite: 20 } });
    expect(p.sessionId).toBe("pi-sess-1");
    expect(p.finalMessage).toBe("Part one. Part two.");
    expect(p.error).toBeNull();
  });
  it("maps openai-codex and ignores other providers", () => {
    const p = parsePiStream(fx("pi-codex-ok"));
    expect(p.usage).toEqual({ codex: { input: 200, output: 30, cacheRead: 400, cacheWrite: 0 } });
    expect(p.finalMessage).toBe("ignored provider");
  });
  it("stopReason error sets error and limitHit", () => {
    const p = parsePiStream(fx("pi-error"));
    expect(p.error).toBe("Claude usage limit reached");
    expect(p.limitHit).toBe("claude");
    expect(p.finalMessage).toBeNull();
  });
  it("a stream without usage-bearing events has no provider entry", () => {
    expect(parsePiStream('{"type":"session","version":3,"id":"x"}\n').usage).toEqual({});
  });
});

describe("mergeParsed", () => {
  it("sums usage, last non-null wins, sums malformed", () => {
    const a = parseClaudeStream(fx("claude-ok"));
    const b = parseClaudeStream(fx("claude-question"));
    const m = mergeParsed([a, { ...b, malformedLines: 2 }]);
    expect(m.usage.claude).toEqual({ input: 110, output: 57, cacheRead: 305, cacheWrite: 20 });
    expect(m.sessionId).toBe("sess-claude-q");
    expect(m.finalMessage).toBe(b.finalMessage);
    expect(m.error).toBeNull();
    expect(m.malformedLines).toBe(2);
  });
  it("keeps an earlier error when later turns have none", () => {
    const m = mergeParsed([parseClaudeStream(fx("claude-error")), parseClaudeStream(fx("claude-ok"))]);
    expect(m.error).toBe("error_max_turns");
  });
});

describe("endsWithQuestion", () => {
  it("checks the last non-empty line", () => {
    expect(endsWithQuestion("Which option?\n\n")).toBe(true);
    expect(endsWithQuestion("Done. Why? Because.")).toBe(false);
    expect(endsWithQuestion(null)).toBe(false);
  });
});
