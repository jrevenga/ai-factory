import { describe, expect, it } from "vitest";
import { declaredCommands, declaredNameOf, planCheck, SIMPLE_COMMANDS_ONLY } from "../../../src/core/evidence/check-plan.ts";
import { ProjectConfig } from "../../../src/core/config/schema.ts";

const OK = ["node", "scripts/ok.mjs"];

describe("planCheck", () => {
  it("runs the lexer's segments: `&&` joins steps in order, allowed assignments become the step env", () => {
    const p = planCheck("CI=1 npm test && node scripts/ok.mjs", [OK]);
    expect(p).toEqual({
      ok: true,
      steps: [
        { argv: ["npm", "test"], env: { CI: "1" } },
        { argv: OK, env: {} },
      ],
    });
  });

  it("rejects pipelines, other operators and redirections with the simple-commands message", () => {
    for (const cmd of ["node scripts/ok.mjs | cat", "npm test; npm test", "npm test || npm test", "npm test\nnpm test", "npm test > out.txt", "npm test 2>&1", "cat < README.md"]) {
      const p = planCheck(cmd, [OK]);
      expect(p.ok, cmd).toBe(false);
      if (!p.ok) expect(p.error, cmd).toContain(SIMPLE_COMMANDS_ONLY);
    }
  });

  it("rejects what the lexer cannot tokenize", () => {
    const p = planCheck("echo $(git push)", []);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain(SIMPLE_COMMANDS_ONLY);
  });

  it("allows read-only and allowlisted segments, refuses unknown ones (node -e), local writes that are not allowlisted and hard classes", () => {
    expect(planCheck("git status", []).ok).toBe(true);
    expect(planCheck("npm run lint && npx --no-install tsc --noEmit", []).ok).toBe(true);
    for (const cmd of ["node -e \"process.exit\"", "node scripts/ok.mjs", "git push", "rm -rf dist", "npm test && git push"]) {
      const p = planCheck(cmd, []);
      expect(p.ok, cmd).toBe(false);
      if (!p.ok) expect(p.error).toContain("run_check runs only read-only, allowlisted or project-declared commands");
    }
  });

  it("decision 7: a declared command matches only by exact argv, never by prefix, and never lifts a hard class", () => {
    expect(planCheck("node scripts/ok.mjs", [OK]).ok).toBe(true);
    expect(planCheck("node 'scripts/ok.mjs'", [OK]).ok).toBe(true);
    expect(planCheck("node scripts/ok.mjs --extra", [OK]).ok).toBe(false);
    expect(planCheck("node scripts/ok.mjs", [["node", "scripts/ok.mjs", "--extra"]]).ok).toBe(false);
    expect(planCheck("node", [OK]).ok).toBe(false);
    expect(planCheck("git push", [["git", "push"]]).ok).toBe(false);
    expect(planCheck("rm -rf dist", [["rm", "-rf", "dist"]]).ok).toBe(false);
  });
});

describe("declaredCommands", () => {
  it("tokenizes test|build|lint|typecheck with the gate's lexer; ignores anything but one simple command", () => {
    const r = declaredCommands({
      test: "node scripts/ok.mjs",
      build: "npm run build && npm test",
      lint: "CI=1 eslint .",
      typecheck: "tsc > out.txt",
      other: "node x.mjs",
    });
    expect(r.declared).toEqual([{ name: "test", argv: OK }]);
    expect(r.ignored).toHaveLength(3);
    expect(r.ignored.join("\n")).toContain("commands.build");
    expect(r.ignored.join("\n")).toContain("commands.lint");
    expect(r.ignored.join("\n")).toContain("commands.typecheck");
    expect(declaredCommands({ test: "echo $HOME" }).declared).toEqual([]);
    expect(declaredCommands({ test: 1 }).ignored).toEqual(["commands.test: not a string"]);
    expect(declaredCommands(undefined)).toEqual({ declared: [], ignored: [] });
  });

  it("ProjectConfig accepts commands as an optional loose field", () => {
    expect(ProjectConfig.parse({ schema: 1, commands: { test: "npm test", e2e: "npm run e2e" } }).commands).toEqual({ test: "npm test", e2e: "npm run e2e" });
    expect(ProjectConfig.parse({ schema: 1 }).commands).toBeUndefined();
    expect(ProjectConfig.safeParse({ schema: 1, commands: { test: 3 } }).success).toBe(false);
  });

  it("declaredNameOf names a single-step plan whose argv equals a declaration", () => {
    const declared = [{ name: "test", argv: OK }];
    expect(declaredNameOf([{ argv: OK, env: {} }], declared)).toBe("test");
    expect(declaredNameOf([{ argv: OK, env: {} }, { argv: OK, env: {} }], declared)).toBeUndefined();
    expect(declaredNameOf([{ argv: ["npm", "test"], env: {} }], declared)).toBeUndefined();
  });
});
