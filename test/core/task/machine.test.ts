import { describe, expect, it } from "vitest";
import {
  MACHINE_CLOSE,
  MACHINE_OPEN,
  MachineSectionError,
  parseMachine,
  renderMachine,
  replaceMachine,
  touchesMachine,
} from "../../../src/core/task/machine.ts";

const valid = (md: string) => {
  const p = parseMachine(md);
  if (p && "invalid" in p) throw new Error(`invalid: ${p.reason}`);
  return p;
};
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
    const p = valid(md);
    expect(p?.fields).toEqual(fields);
    expect(md.slice(p!.start, p!.end)).toBe(renderMachine(fields));
  });
  it("returns undefined when absent", () => {
    expect(parseMachine("# nothing")).toBeUndefined();
  });
  it("replaces an existing block and leaves the rest", () => {
    const md = `# T\n\n${renderMachine(fields)}\n\nbody\n`;
    const out = replaceMachine(md, { ...fields, phase: "review" });
    expect(valid(out)?.fields.phase).toBe("review");
    expect(out.endsWith("\n\nbody\n")).toBe(true);
    expect(out.startsWith("# T\n\n")).toBe(true);
  });
  it("inserts after frontmatter when absent", () => {
    const md = "---\nid: t1\n---\n# T\n";
    const out = replaceMachine(md, fields);
    expect(out.startsWith("---\nid: t1\n---\n")).toBe(true);
    expect(out.indexOf(MACHINE_OPEN)).toBeGreaterThanOrEqual("---\nid: t1\n---\n".length);
    expect(out.indexOf(MACHINE_OPEN)).toBeLessThan(out.indexOf("# T"));
    expect(valid(out)?.fields).toEqual(fields);
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

describe("machine section fail-closed handling", () => {
  const block = renderMachine(fields);
  it("reports invalid for a second complete block and touchesMachine flags it", () => {
    const before = `# T\n\n${block}\n`;
    const after = `${before}\n${block}\n`;
    expect(parseMachine(after)).toMatchObject({ invalid: true });
    expect(touchesMachine(before, after)).toBe(true);
    expect(() => replaceMachine(after, fields)).toThrow(MachineSectionError);
  });
  it("reports invalid for an unclosed open, a stray close, and reversed order", () => {
    expect(parseMachine(`# T\n${MACHINE_OPEN}\nphase: x\n`)).toMatchObject({ invalid: true });
    expect(parseMachine(`# T\n${MACHINE_CLOSE}\n`)).toMatchObject({ invalid: true });
    expect(parseMachine(`${MACHINE_CLOSE}\n${MACHINE_OPEN}\n`)).toMatchObject({ invalid: true });
    expect(() => replaceMachine(`# T\n${MACHINE_OPEN}\nphase: x\n`, fields)).toThrow(MachineSectionError);
  });
  it("ignores markers inside frontmatter, so they cannot hijack the block", () => {
    const md = `---\nnote: ${MACHINE_OPEN}\n---\n# T\n`;
    expect(parseMachine(md)).toBeUndefined();
    const out = replaceMachine(md, fields);
    expect(out.startsWith(`---\nnote: ${MACHINE_OPEN}\n---\n`)).toBe(true);
    expect(valid(out)?.fields).toEqual(fields);
    expect(valid(replaceMachine(out, { ...fields, phase: "z" }))?.fields.phase).toBe("z");
  });
  it("does not let a marker in a code block before the real block hijack it", () => {
    const md = `# T\n\n\`\`\`\n${MACHINE_OPEN}\n\`\`\`\n\n${block}\n`;
    expect(parseMachine(md)).toMatchObject({ invalid: true });
    expect(() => replaceMachine(md, fields)).toThrow(MachineSectionError);
  });
  it("touchesMachine is true when either side is invalid", () => {
    const bad = `${MACHINE_OPEN}\n`;
    expect(touchesMachine(bad, bad)).toBe(true);
    expect(touchesMachine("# T\n", bad)).toBe(true);
  });
  it("handles empty frontmatter", () => {
    const out = replaceMachine("---\n---\n# T\n", fields);
    expect(out.startsWith("---\n---\n")).toBe(true);
    expect(valid(out)?.fields).toEqual(fields);
  });
  it("preserves CRLF line endings", () => {
    const md = "---\r\nid: t1\r\n---\r\n# T\r\n";
    const out = replaceMachine(md, fields);
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(valid(out)?.fields).toEqual(fields);
    const out2 = replaceMachine(out, { ...fields, phase: "z" });
    expect(out2.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(touchesMachine(out, out2)).toBe(true);
  });
  it("rejects values that cannot round-trip and keeps empty values", () => {
    expect(() => renderMachine({ ...fields, phase: "a · b" })).toThrow();
    expect(() => renderMachine({ ...fields, phase: "a\nb" })).toThrow();
    expect(() => renderMachine({ ...fields, phase: "a --> b" })).toThrow();
    expect(() => renderMachine({ ...fields, phase: " pad" })).toThrow();
    expect(() => renderMachine({ "bad key": "x" })).toThrow();
    const f = { phase: "build", base: "", checkpoint: "c", worktree: "w", run: "" };
    expect(valid(`${renderMachine(f)}\n`)?.fields).toEqual(f);
  });
});
