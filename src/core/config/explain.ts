import type { ConfigViolation, ResolvedConfig, Source } from "./resolve.ts";

export interface Explanation {
  key: string;
  value: unknown;
  source: Source;
  overridden: { source: string; value: unknown }[];
  violations: ConfigViolation[];
}

/** Explains where a dotted leaf key's effective value comes from; `undefined` for unknown keys. */
export function explainKey(resolved: ResolvedConfig, key: string): Explanation | undefined {
  const prov = resolved.provenance.get(key);
  if (!prov) return undefined;
  const value = lookup(resolved.value, key.split("."));
  return {
    key,
    value,
    source: prov.source,
    overridden: prov.overridden,
    violations: resolved.violations.filter((v) => v.key === key),
  };
}

/** Walks own properties; segments may be joined back when a literal key contains a dot. */
function lookup(cur: unknown, parts: string[]): unknown {
  if (parts.length === 0) return cur;
  if (typeof cur !== "object" || cur === null) return undefined;
  for (let i = 1; i <= parts.length; i++) {
    const k = parts.slice(0, i).join(".");
    if (Object.hasOwn(cur, k)) {
      const r = lookup((cur as Record<string, unknown>)[k], parts.slice(i));
      if (r !== undefined) return r;
    }
  }
  return undefined;
}
