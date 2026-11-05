import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../../src/cli/commands/init.ts";
import type { CliIO } from "../../src/cli/io.ts";
import { tree } from "../helpers/release-world.ts";
import { makeTmp, type Tmp } from "../helpers/tmp.ts";

let tmp: Tmp;
let repo: string;
let outs: string[];
let errs: string[];
let asked: string[];
let answer: boolean;

beforeEach(async () => {
  tmp = await makeTmp("init");
  repo = join(tmp.dir, "repo");
  mkdirSync(join(repo, "sub dir"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  outs = [];
  errs = [];
  asked = [];
  answer = false;
});
afterEach(async () => {
  await tmp.cleanup();
});

const io = (): CliIO => ({
  out: (s) => void outs.push(s),
  err: (s) => void errs.push(s),
  confirm: async (q) => {
    asked.push(q);
    return answer;
  },
  isTTY: false,
});
const run = (yes = false, cwd = repo): Promise<number> => init({ io: io(), env: process.env }, { yes, cwd });
const read = (rel: string): string => readFileSync(join(repo, ".factory", rel), "utf8");

describe("init", () => {
  it("creates the scaffold with frontmatter at the git root, even from a subdirectory", async () => {
    expect(await run(false, join(repo, "sub dir"))).toBe(0);
    expect(JSON.parse(read("config.json"))).toEqual({ schema: 1 });
    expect(read("knowledge/index.md")).toMatch(/^---\ntype: index\nschema: 1\n---\n/);
    expect(read("knowledge/conventions.md")).toMatch(/^---\ntype: conventions\nschema: 1\n---\n/);
    for (const d of ["specs", "tasks", "decisions", "plans", "ideas"]) expect(existsSync(join(repo, ".factory/knowledge", d, ".gitkeep"))).toBe(true);
    expect(read(".gitignore")).toBe("worktrees/\n");
    expect(asked).toEqual([]);
  });

  it("a second run leaves every byte unchanged and asks nothing", async () => {
    await run();
    const before = tree(join(repo, ".factory"));
    expect(await run()).toBe(0);
    expect(tree(join(repo, ".factory"))).toEqual(before);
    expect(asked).toEqual([]);
  });

  it("never overwrites an edited file; lists additions and asks before adding", async () => {
    mkdirSync(join(repo, ".factory"));
    writeFileSync(join(repo, ".factory/config.json"), '{"schema":1,"context":"mine"}');
    expect(await run()).toBe(1); // declined (confirm answers false)
    expect(asked).toHaveLength(1);
    expect(outs.join("\n")).toContain("+ .factory/knowledge/index.md");
    expect(outs.join("\n")).not.toContain("+ .factory/config.json");
    expect(existsSync(join(repo, ".factory/knowledge"))).toBe(false);

    answer = true;
    expect(await run()).toBe(0);
    expect(read("config.json")).toBe('{"schema":1,"context":"mine"}');
    expect(existsSync(join(repo, ".factory/knowledge/index.md"))).toBe(true);
  });

  it("--yes accepts without asking", async () => {
    mkdirSync(join(repo, ".factory"));
    expect(await run(true)).toBe(0);
    expect(asked).toEqual([]);
    expect(existsSync(join(repo, ".factory/.gitignore"))).toBe(true);
  });

  it("outside a git repository exits 1 and creates nothing", async () => {
    const plain = join(tmp.dir, "plain");
    mkdirSync(plain);
    expect(await run(false, plain)).toBe(1);
    expect(errs.join("")).toMatch(/not inside a git repository/);
    expect(existsSync(join(plain, ".factory"))).toBe(false);
  });
});
