// Online-only provider reachability (plan ruling 17): an HTTPS HEAD with a 5 s timeout per required
// provider; any HTTP response, whatever its status, means the endpoint is reachable. `fetch` is
// injected so tests never touch the network.
export type Provider = "claude" | "codex";
export type Reachability = "reachable" | "unreachable";

export const PROVIDER_ENDPOINTS: Readonly<Record<Provider, string>> = {
  claude: "https://api.anthropic.com/",
  codex: "https://chatgpt.com/",
};

const TIMEOUT_MS = 5_000;

async function probe(url: string, fetchFn: typeof fetch): Promise<Reachability> {
  try {
    const res = await fetchFn(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel().catch(() => {});
    return "reachable";
  } catch {
    return "unreachable";
  }
}

export async function checkReachability(providers: Provider[], fetchFn: typeof fetch): Promise<Record<string, Reachability>> {
  const unique = [...new Set(providers)];
  const results = await Promise.all(unique.map(async (p) => [p, await probe(PROVIDER_ENDPOINTS[p], fetchFn)] as const));
  return Object.fromEntries(results);
}
