import type { CoreConfig, PersonalConfig, ProjectConfig, SoftGateId } from "./schema.ts";

export type Source = "core" | "personal" | "project";
export interface Provenance {
  source: Source;
  overridden: { source: string; value: unknown }[];
}
export interface ConfigViolation {
  key: string;
  source: "personal" | "project";
  reason: "locked";
}
export type EffectiveConfig = CoreConfig & { profile?: string; machine?: Record<string, string> };
export interface ResolvedConfig {
  value: EffectiveConfig;
  provenance: Map<string, Provenance>;
  violations: ConfigViolation[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

/** Dotted leaf entries; arrays and primitives are leaves. */
function leaves(v: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (isRec(v)) {
    for (const [k, child] of Object.entries(v)) leaves(child, prefix === "" ? k : `${prefix}.${k}`, out);
  } else if (v !== undefined) {
    out.set(prefix, v);
  }
  return out;
}

function setPath(target: Rec, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur = target;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (isRec(next)) cur = next;
    else {
      const fresh: Rec = {};
      cur[p] = fresh;
      cur = fresh;
    }
  }
  cur[parts[parts.length - 1] as string] = value;
}

const KNOWN_PERSONAL = ["profile", "autonomy", "parallelism", "language", "radar", "maintainer", "budgets", "machine"];

export function resolveConfig(layers: { core: CoreConfig; personal?: PersonalConfig; project?: ProjectConfig }): ResolvedConfig {
  const value = clone(layers.core) as Rec;
  const provenance = new Map<string, Provenance>();
  const violations: ConfigViolation[] = [];
  for (const [k, v] of leaves(layers.core)) provenance.set(k, { source: "core", overridden: [] });

  const apply = (source: "personal" | "project", key: string, next: unknown): void => {
    const prev = provenance.get(key);
    const overridden = prev ? [...prev.overridden, { source: prev.source, value: leafValue(value, key) }] : [];
    setPath(value, key, clone(next));
    provenance.set(key, { source, overridden });
  };

  const personal = layers.personal as Rec | undefined;
  if (personal) {
    if (personal.schema !== layers.core.schema) violations.push({ key: "schema", source: "personal", reason: "locked" });
    if (isRec(personal.gates) && personal.gates.hard !== undefined)
      violations.push({ key: "gates.hard", source: "personal", reason: "locked" });
    const picked: Rec = {};
    for (const k of KNOWN_PERSONAL) if (personal[k] !== undefined) picked[k] = personal[k];
    if (isRec(personal.gates) && personal.gates.soften !== undefined) picked.gates = { soften: personal.gates.soften };
    for (const [k, v] of leaves(picked)) apply("personal", k, v);
  }

  const project = layers.project as Rec | undefined;
  if (project) {
    if (project.schema !== layers.core.schema) violations.push({ key: "schema", source: "project", reason: "locked" });
    const ov = isRec(project.overrides) ? project.overrides : {};
    const gates = isRec(ov.gates) ? ov.gates : undefined;
    if (gates && gates.hard !== undefined) violations.push({ key: "gates.hard", source: "project", reason: "locked" });
    if (ov.language !== undefined) apply("project", "language", ov.language);
    if (gates && Array.isArray(gates.soften)) {
      const base = (leafValue(value, "gates.soften") as SoftGateId[]) ?? [];
      apply("project", "gates.soften", base.filter((g) => (gates.soften as unknown[]).includes(g)));
    }
  }

  return { value: value as EffectiveConfig, provenance, violations };
}

function leafValue(root: Rec, key: string): unknown {
  let cur: unknown = root;
  for (const p of key.split(".")) {
    if (!isRec(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}
