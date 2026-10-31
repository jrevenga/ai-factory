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
  let value: unknown = resolved.value;
  for (const part of key.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return {
    key,
    value,
    source: prov.source,
    overridden: prov.overridden,
    violations: resolved.violations.filter((v) => v.key === key),
  };
}
