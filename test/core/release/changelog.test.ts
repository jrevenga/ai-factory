import { describe, expect, it } from "vitest";
import { changelogBetween, changelogVersions } from "../../../src/core/release/changelog.ts";

const MD = `# Changelog

## [0.3.0] - 2026-03-01

- three

## [0.2.0] - 2026-02-01

- two

## [0.1.0] - 2026-01-01

- one
`;

describe("changelog", () => {
  it("returns sections in (from, to] newest first", () => {
    const out = changelogBetween(MD, "0.1.0", "0.3.0");
    expect(out.indexOf("[0.3.0]")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("[0.3.0]")).toBeLessThan(out.indexOf("[0.2.0]"));
    expect(out).not.toContain("[0.1.0]");
    expect(out).toContain("- two");
  });
  it("is empty when nothing is newer, and handles CRLF", () => {
    expect(changelogBetween(MD, "0.3.0", "0.3.0")).toBe("");
    expect(changelogBetween(MD.replace(/\n/g, "\r\n"), "0.2.0", "0.3.0")).toBe("## [0.3.0] - 2026-03-01\n\n- three");
  });
  it("does not attach non-version level-two sections to the preceding release", () => {
    const md = "# Changelog\n\n## [Unreleased]\n\n- wip\n\n## [0.2.0] - x\n\n- two\n\n## [Unreleased-notes]\n\n- stray\n\n## [0.1.0] - y\n\n- one\n";
    const out = changelogBetween(md, "0.1.0", "0.2.0");
    expect(out).toBe("## [0.2.0] - x\n\n- two");
  });
  it("lists versions", () => {
    expect(changelogVersions(MD)).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
  });
});
