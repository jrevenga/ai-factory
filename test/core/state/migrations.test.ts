import { describe, expect, it } from "vitest";
import {
  InvalidMigration,
  MIGRATIONS,
  type Migration,
  NoMigrationPath,
  planMigrations,
} from "../../../src/core/state/migrations.ts";

const m = (doc: Migration["doc"], from: number, to: number): Migration => ({
  id: `${doc}-${from}-${to}`,
  doc,
  from,
  to,
  up: (d) => d,
});

const TARGET_1 = { "config.json": 1, "state.json": 1, "managed-settings.json": 1 } as const;

describe("planMigrations", () => {
  it("ships an empty registry in 0.1.0", () => {
    expect(MIGRATIONS).toEqual([]);
  });

  it("plans only the config 1→2 migration when config targets 2", () => {
    const registry = [m("config.json", 1, 2), m("state.json", 1, 2)];
    const plan = planMigrations(
      { "config.json": 1, "state.json": 1, "managed-settings.json": 1 },
      registry,
      { ...TARGET_1, "config.json": 2 },
    );
    expect(plan.map((x) => x.id)).toEqual(["config.json-1-2"]);
  });

  it("throws NoMigrationPath with doc, from and to when the target is unreachable", () => {
    const registry = [m("config.json", 1, 2)];
    let err: unknown;
    try {
      planMigrations({ "config.json": 1 }, registry, { ...TARGET_1, "config.json": 3 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoMigrationPath);
    expect(err).toMatchObject({ doc: "config.json", from: 1, to: 3 });
  });

  it("needs nothing for documents already at their target or absent", () => {
    expect(planMigrations({ "config.json": 1 }, [m("config.json", 1, 2)], TARGET_1)).toEqual([]);
    expect(planMigrations({}, [m("config.json", 1, 2)], { ...TARGET_1, "config.json": 2 })).toEqual([]);
  });

  it("chains steps in order and picks the shortest path", () => {
    const registry = [m("config.json", 2, 3), m("config.json", 1, 2), m("config.json", 1, 3), m("config.json", 3, 4)];
    const plan = planMigrations({ "config.json": 1 }, registry, { ...TARGET_1, "config.json": 4 });
    expect(plan.map((x) => x.id)).toEqual(["config.json-1-3", "config.json-3-4"]);
  });

  it("never overshoots the target", () => {
    const registry = [m("config.json", 1, 3)];
    expect(() => planMigrations({ "config.json": 1 }, registry, { ...TARGET_1, "config.json": 2 })).toThrow(NoMigrationPath);
  });

  it("refuses a document newer than its target (that is a rollback, not a migration)", () => {
    expect(() => planMigrations({ "state.json": 2 }, [], TARGET_1)).toThrow(NoMigrationPath);
  });

  it("orders plans per document in STATE_DOCS order", () => {
    const registry = [m("managed-settings.json", 1, 2), m("config.json", 1, 2)];
    const plan = planMigrations(
      { "config.json": 1, "managed-settings.json": 1 },
      registry,
      { "config.json": 2, "state.json": 1, "managed-settings.json": 2 },
    );
    expect(plan.map((x) => x.doc)).toEqual(["config.json", "managed-settings.json"]);
  });

  it("rejects registry entries whose to is not greater than from", () => {
    expect(() => planMigrations({ "config.json": 1 }, [m("config.json", 2, 1)], TARGET_1)).toThrow(InvalidMigration);
    expect(() => planMigrations({ "config.json": 1 }, [m("config.json", 1, 1)], TARGET_1)).toThrow(InvalidMigration);
  });

  it("rejects duplicate migration ids", () => {
    const a = m("config.json", 1, 2);
    expect(() => planMigrations({ "config.json": 1 }, [a, { ...a, from: 2, to: 3 }], TARGET_1)).toThrow(InvalidMigration);
  });
});
