import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CoreConfig, PersonalConfig, ProjectConfig } from "../../../src/core/config/schema.ts";
import { resolveConfig } from "../../../src/core/config/resolve.ts";
import { explainKey } from "../../../src/core/config/explain.ts";

const core = CoreConfig.parse(
  JSON.parse(readFileSync(new URL("../../../defaults/config.json", import.meta.url), "utf8")),
);

describe("resolveConfig", () => {
  it("core only: autonomy medium from core", () => {
    const r = resolveConfig({ core });
    expect(r.value.autonomy).toBe("medium");
    expect(r.provenance.get("autonomy")).toEqual({ source: "core", overridden: [] });
    expect(r.violations).toEqual([]);
  });

  it("personal overrides core and records the overridden value", () => {
    const personal = PersonalConfig.parse({ schema: 1, profile: "x", autonomy: "high" });
    const r = resolveConfig({ core, personal });
    expect(r.value.autonomy).toBe("high");
    expect(r.provenance.get("autonomy")).toEqual({
      source: "personal",
      overridden: [{ source: "core", value: "medium" }],
    });
    expect(r.value.profile).toBe("x");
  });

  it("locked gates.hard is dropped and reported", () => {
    const personal = PersonalConfig.parse({ schema: 1, profile: "x", gates: { hard: [] } });
    const r = resolveConfig({ core, personal });
    expect(r.value.gates.hard).toEqual(core.gates.hard);
    expect(r.violations).toEqual([{ key: "gates.hard", source: "personal", reason: "locked" }]);
  });

  it("project soften can only make gates stricter", () => {
    const personal = PersonalConfig.parse({ schema: 1, profile: "x", gates: { soften: [] } });
    const project = ProjectConfig.parse({ schema: 1, overrides: { gates: { soften: ["design-approval"] } } });
    expect(resolveConfig({ core, personal, project }).value.gates.soften).toEqual([]);
    const p2 = PersonalConfig.parse({ schema: 1, profile: "x", gates: { soften: ["design-approval", "quota-low"] } });
    const r = resolveConfig({ core, personal: p2, project });
    expect(r.value.gates.soften).toEqual(["design-approval"]);
    expect(r.provenance.get("gates.soften")?.source).toBe("project");
  });

  it("project falls back to core soften when personal has none", () => {
    const project = ProjectConfig.parse({ schema: 1, overrides: { gates: { soften: ["quota-low"] } } });
    expect(resolveConfig({ core, project }).value.gates.soften).toEqual([]);
  });

  it("project language override wins", () => {
    const personal = PersonalConfig.parse({ schema: 1, profile: "x", language: "es" });
    const project = ProjectConfig.parse({ schema: 1, overrides: { language: "en" } });
    const r = resolveConfig({ core, personal, project });
    expect(r.value.language).toBe("en");
    expect(r.provenance.get("language")?.overridden).toEqual([{ source: "personal", value: "es" }]);
  });

  it("merges budgets deeply", () => {
    const personal = PersonalConfig.parse({ schema: 1, profile: "x", budgets: { claude: { weeklyTokens: 5 } } });
    const r = resolveConfig({ core, personal });
    expect(r.value.budgets).toEqual({ claude: { weeklyTokens: 5 } });
    expect(r.provenance.get("budgets.claude.weeklyTokens")?.source).toBe("personal");
  });
});

describe("schemas", () => {
  it("rejects unknown override keys", () => {
    expect(() => ProjectConfig.parse({ schema: 1, overrides: { autonomy: "high" } })).toThrow();
  });
  it("preserves unknown personal fields", () => {
    const p = PersonalConfig.parse({ schema: 1, profile: "x", futureField: 1 }) as Record<string, unknown>;
    expect(p.futureField).toBe(1);
  });
  it("defaults", () => {
    expect(CoreConfig.parse({ schema: 1 })).toMatchObject({ autonomy: "medium", parallelism: 3, radar: false });
    expect(() => CoreConfig.parse({ schema: 1, parallelism: 17 })).toThrow();
  });
});

describe("explainKey", () => {
  it("explains a core key", () => {
    const r = resolveConfig({ core });
    expect(explainKey(r, "parallelism")).toEqual({
      key: "parallelism",
      value: 3,
      source: "core",
      overridden: [],
      violations: [],
    });
  });
  it("returns undefined for unknown keys", () => {
    expect(explainKey(resolveConfig({ core }), "nope.nothing")).toBeUndefined();
  });
  it("includes violations for the key", () => {
    const personal = PersonalConfig.parse({ schema: 1, profile: "x", gates: { hard: [] } });
    const e = explainKey(resolveConfig({ core, personal }), "gates.hard");
    expect(e?.violations).toHaveLength(1);
    expect(e?.source).toBe("core");
  });
});
