import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSchemas, generateSchemas } from "../../scripts/gen-schemas.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("gen-schemas", () => {
  it("generates all schemas", () => {
    expect(Object.keys(generateSchemas()).sort()).toEqual([
      "check-record.schema.json",
      "eval-contenders.schema.json",
      "eval-run-manifest.schema.json",
      "eval-run-record.schema.json",
      "eval-task.schema.json",
      "eval-thresholds.schema.json",
      "eval-tools-lock.schema.json",
      "managed-settings.schema.json",
      "personal-config.schema.json",
      "profile.schema.json",
      "project-config.schema.json",
      "release.schema.json",
      "review-disposition.schema.json",
      "run-event.schema.json",
      "state.schema.json",
    ]);
  });
  it("committed schemas are fresh", () => {
    expect(checkSchemas(resolve(root, "schemas"))).toEqual([]);
  });
  it("reports a stale directory", () => {
    expect(checkSchemas(resolve(root, "test"))).toHaveLength(15);
  });
});
