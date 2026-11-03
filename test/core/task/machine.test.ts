import { describe, expect, it } from "vitest";
import {
  MACHINE_CLOSE,
  MACHINE_OPEN,
  parseMachine,
  renderMachine,
  replaceMachine,
  touchesMachine,
} from "../../../src/core/task/machine.ts";

const fields = { phase: "build", base: "abc123", checkpoint: "def456", worktree: "/w/t1", run: "r-1" };

describe("machine section", () => {
  it("uses the exact markers", () => {
    expect(MACHINE_OPEN).toBe("<!-- machine: written by code only -->");
    expect(MACHINE_CLOSE).toBe("<!-- /machine -->");
  });
  it("renders in spec order", () => {
    const out = renderMachine({ run: "r-1", worktree: "/w/t1", checkpoint: "def456", base: "abc123", phase: "build" });
    expect(out).toBe(
      `${MACHINE_OPEN}\nphase: build · base: abc123 · checkpoint: def456 · worktree: /w/t1 · run: r-1\n${MACHINE_CLOSE}`,
    );
  });
  it("round-trips parse/render", () => {
    const md = `# Task\n\n${renderMachine(fields)}\n\nbody\n`;
    const p = parseMachine(md);
    expect(p?.fields).toEqual(fields);
    expect(md.slice(p!.start, p!.end)).toBe(renderMachine(fields));
  });
  it("returns undefined when absent or unclosed", () => {
    expect(parseMachine("# nothing")).toBeUndefined();
    expect(parseMachine(`${MACHINE_OPEN}\nphase: x\n`)).toBeUndefined();
  });
  it("replaces an existing block and leaves the rest", () => {
    const md = `# T\n\n${renderMachine(fields)}\n\nbody\n`;
    const out = replaceMachine(md, { ...fields, phase: "review" });
    expect(parseMachine(out)?.fields.phase).toBe("review");
    expect(out.endsWith("\n\nbody\n")).toBe(true);
    expect(out.startsWith("# T\n\n")).toBe(true);
  });
  it("inserts after frontmatter when absent", () => {
    const md = "---\nid: t1\n---\n# T\n";
    const out = replaceMachine(md, fields);
    expect(out.startsWith("---\nid: t1\n---\n")).toBe(true);
    expect(out.indexOf(MACHINE_OPEN)).toBeGreaterThanOrEqual("---\nid: t1\n---\n".length);
    expect(out.indexOf(MACHINE_OPEN)).toBeLessThan(out.indexOf("# T"));
    expect(parseMachine(out)?.fields).toEqual(fields);
  });
  it("inserts at the top without frontmatter", () => {
    const out = replaceMachine("# T\n", fields);
    expect(out.startsWith(MACHINE_OPEN)).toBe(true);
    expect(out.endsWith("# T\n")).toBe(true);
  });
  it("touchesMachine is true only when the block changes", () => {
    const before = `# T\n\n${renderMachine(fields)}\n\nbody\n`;
    expect(touchesMachine(before, replaceMachine(before, { ...fields, phase: "x" }))).toBe(true);
    expect(touchesMachine(before, before.replace("body", "other body"))).toBe(false);
    expect(touchesMachine(before, before.replace(MACHINE_CLOSE, ""))).toBe(true);
    expect(touchesMachine("# T\n", before)).toBe(true);
    expect(touchesMachine("a", "b")).toBe(false);
  });
});
