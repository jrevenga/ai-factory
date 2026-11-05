import { describe, expect, it, vi } from "vitest";
import { checkReachability } from "../../../src/adapters/providers/reachability.ts";

describe("checkReachability", () => {
  it("a resolving fetch → reachable, with HTTPS HEAD to each provider endpoint and a timeout signal", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
    const r = await checkReachability(["claude", "codex"], fetchFn as unknown as typeof fetch);
    expect(r).toEqual({ claude: "reachable", codex: "reachable" });
    const calls = fetchFn.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, signal: init?.signal instanceof AbortSignal }));
    expect(calls).toEqual(
      expect.arrayContaining([
        { url: "https://api.anthropic.com/", method: "HEAD", signal: true },
        { url: "https://chatgpt.com/", method: "HEAD", signal: true },
      ]),
    );
    expect(calls).toHaveLength(2);
  });

  it("any HTTP response counts as reachable", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
    expect(await checkReachability(["codex"], fetchFn as unknown as typeof fetch)).toEqual({ codex: "reachable" });
  });

  it("a rejecting fetch → unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await checkReachability(["claude", "codex"], fetchFn as unknown as typeof fetch)).toEqual({ claude: "unreachable", codex: "unreachable" });
  });

  it("only checks the requested providers", async () => {
    const fetchFn = vi.fn(async () => new Response(null));
    expect(await checkReachability([], fetchFn as unknown as typeof fetch)).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
