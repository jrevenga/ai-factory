import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Profile } from "../../../src/core/profiles/schema.ts";
import { proposeProfile } from "../../../src/core/profiles/propose.ts";

const load = (n: string) =>
  Profile.parse(JSON.parse(readFileSync(new URL(`../../../profiles/${n}.json`, import.meta.url), "utf8")));
const profiles = [load("codex-only"), load("claude-codex")];

describe("shipped profiles", () => {
  it("parse with the expected models", () => {
    expect(profiles.map((p) => p.name).sort()).toEqual(["claude-codex", "codex-only"]);
    expect(load("claude-codex").roles.reviewer.model).toBe("openai-codex/gpt-6.1-sol");
    expect(load("codex-only").roles.reviewer.options).toEqual({ freshContext: true });
  });
});

describe("proposeProfile", () => {
  it("both present -> claude-codex", () => {
    expect(proposeProfile({ claude: "present", codex: "present" }, profiles)?.name).toBe("claude-codex");
  });
  it("claude absent -> codex-only", () => {
    expect(proposeProfile({ claude: "absent", codex: "present" }, profiles)?.name).toBe("codex-only");
  });
  it("claude unknown + codex absent -> undefined", () => {
    expect(proposeProfile({ claude: "unknown", codex: "absent" }, profiles)).toBeUndefined();
  });
  it("codex invalid -> undefined", () => {
    expect(proposeProfile({ claude: "present", codex: "invalid" }, profiles)).toBeUndefined();
  });
});
