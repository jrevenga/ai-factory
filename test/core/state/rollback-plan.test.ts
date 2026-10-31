import { describe, expect, it } from "vitest";
import { planRollback } from "../../../src/core/state/rollback-plan.ts";

const TARGET_1 = { "config.json": 1, "state.json": 1, "managed-settings.json": 1 } as const;

describe("planRollback", () => {
  it("keeps every document whose schema equals the target", () => {
    expect(
      planRollback({ current: { "config.json": 1, "state.json": 1, "managed-settings.json": 1 }, target: TARGET_1, snapshotHas: {} }),
    ).toEqual({ keep: ["config.json", "state.json", "managed-settings.json"], restore: [], refuse: [] });
  });

  it("keeps a document older than the target and an absent document", () => {
    expect(
      planRollback({ current: { "config.json": 1 }, target: { ...TARGET_1, "config.json": 2 }, snapshotHas: {} }),
    ).toEqual({ keep: ["config.json", "state.json", "managed-settings.json"], restore: [], refuse: [] });
  });

  it("restores a newer document the snapshot has", () => {
    expect(
      planRollback({
        current: { "config.json": 2, "state.json": 1, "managed-settings.json": 1 },
        target: TARGET_1,
        snapshotHas: { "config.json": true },
      }),
    ).toEqual({ keep: ["state.json", "managed-settings.json"], restore: ["config.json"], refuse: [] });
  });

  it("refuses a newer document the snapshot does not have", () => {
    expect(
      planRollback({
        current: { "config.json": 2, "state.json": 1, "managed-settings.json": 1 },
        target: TARGET_1,
        snapshotHas: { "config.json": false },
      }),
    ).toEqual({ keep: ["state.json", "managed-settings.json"], restore: [], refuse: ["config.json"] });
  });
});
