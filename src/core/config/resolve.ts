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
type Path = string[];
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);
const display = (path: Path): string => path.join(".");

/** Leaf entries by literal key segments; arrays, primitives and empty objects are leaves. */
function leaves(v: unknown, path: Path = [], out: [Path, unknown][] = []): [Path, unknown][] {
  if (isRec(v) && Object.keys(v).length > 0) {
    for (const k of Object.keys(v)) leaves(v[k], [...path, k], out);
  } else if (v !== undefined) {
    out.push([path, v]);
  }
  return out;
}

function getOwn(root: unknown, path: Path): unknown {
  let cur = root;
  for (const p of path) {
    if (!isRec(cur) || !Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function defineOwn(target: Rec, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function setPath(target: Rec, path: Path, value: unknown): void {
  let cur = target;
  for (const p of path.slice(0, -1)) {
    const next = Object.hasOwn(cur, p) ? cur[p] : undefined;
    if (isRec(next)) cur = next;
    else {
      const fresh: Rec = {};
      defineOwn(cur, p, fresh);
      cur = fresh;
    }
  }
  defineOwn(cur, path[path.length - 1] as string, value);
}

const KNOWN_PERSONAL = ["profile", "autonomy", "parallelism", "language", "radar", "maintainer", "budgets", "machine"];

export function resolveConfig(layers: { core: CoreConfig; personal?: PersonalConfig; project?: ProjectConfig }): ResolvedConfig {
  const value = clone(layers.core) as Rec;
  const prov = new Map<string, { path: Path; p: Provenance }>();
  const violations: ConfigViolation[] = [];
  const keyOf = (path: Path): string => JSON.stringify(path);
  for (const [path] of leaves(layers.core)) prov.set(keyOf(path), { path, p: { source: "core", overridden: [] } });

  const apply = (source: "personal" | "project", path: Path, next: unknown): void => {
    const existing = getOwn(value, path);
    // An empty object merges into whatever object is already there; it only adds a leaf when nothing exists.
    if (isRec(next) && Object.keys(next).length === 0 && isRec(existing)) return;
    const prev = prov.get(keyOf(path));
    const overridden = prev ? [...prev.p.overridden, { source: prev.p.source, value: clone(existing) }] : [];
    // Replacing a former leaf with children (or vice versa) drops stale ancestor/descendant leaves.
    for (const [k, e] of prov) {
      const shared = Math.min(e.path.length, path.length);
      if (e.path.length !== path.length && e.path.slice(0, shared).every((s, i) => s === path[i])) prov.delete(k);
    }
    setPath(value, path, clone(next));
    prov.set(keyOf(path), { path, p: { source, overridden } });
  };

  const personal = layers.personal as Rec | undefined;
  if (personal) {
    if (personal.schema !== layers.core.schema) violations.push({ key: "schema", source: "personal", reason: "locked" });
    const pg = Object.hasOwn(personal, "gates") ? personal.gates : undefined;
    if (isRec(pg) && Object.hasOwn(pg, "hard")) violations.push({ key: "gates.hard", source: "personal", reason: "locked" });
    const picked: Rec = {};
    for (const k of KNOWN_PERSONAL) if (Object.hasOwn(personal, k) && personal[k] !== undefined) defineOwn(picked, k, personal[k]);
    if (isRec(pg) && Object.hasOwn(pg, "soften") && pg.soften !== undefined) defineOwn(picked, "gates", { soften: pg.soften });
    for (const [path, v] of leaves(picked)) apply("personal", path, v);
  }

  const project = layers.project as Rec | undefined;
  if (project) {
    if (project.schema !== layers.core.schema) violations.push({ key: "schema", source: "project", reason: "locked" });
    const ov = Object.hasOwn(project, "overrides") && isRec(project.overrides) ? project.overrides : {};
    const gates = Object.hasOwn(ov, "gates") && isRec(ov.gates) ? ov.gates : undefined;
    if (gates && Object.hasOwn(gates, "hard")) violations.push({ key: "gates.hard", source: "project", reason: "locked" });
    if (Object.hasOwn(ov, "language") && ov.language !== undefined) apply("project", ["language"], ov.language);
    if (gates && Array.isArray(gates.soften)) {
      const base = (getOwn(value, ["gates", "soften"]) as SoftGateId[] | undefined) ?? [];
      apply("project", ["gates", "soften"], base.filter((g) => (gates.soften as unknown[]).includes(g)));
    }
  }

  const provenance = new Map<string, Provenance>();
  for (const { path, p } of prov.values()) provenance.set(display(path), p);
  return { value: value as EffectiveConfig, provenance, violations };
}
