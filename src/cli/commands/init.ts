// `factory init`: scaffolds `<git root>/.factory/`. Never overwrites an existing file.
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git, GitError } from "../../adapters/vcs/git.ts";
import type { CliIO } from "../io.ts";

export interface InitContext {
  io: CliIO;
  env: NodeJS.ProcessEnv;
}

const front = (type: string): string => `---\ntype: ${type}\nschema: 1\n---\n\n`;

const FILES: [string, string][] = [
  ["config.json", `${JSON.stringify({ schema: 1 }, null, 2)}\n`],
  ["knowledge/index.md", `${front("index")}# Knowledge index\n\nShort map of this project's knowledge files, linked relatively.\n`],
  ["knowledge/conventions.md", `${front("conventions")}# Conventions\n\nProject conventions the factory should follow.\n`],
  ...["specs", "tasks", "decisions", "plans", "ideas"].map((d): [string, string] => [`knowledge/${d}/.gitkeep`, ""]),
  [".gitignore", "worktrees/\n"],
];

/** The repository root containing `cwd`, or undefined outside a git repository. */
export async function gitRoot(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return resolve((await git(["rev-parse", "--show-toplevel"], { cwd, env, timeoutMs: 15_000 })).stdout.trim());
  } catch (e) {
    if (e instanceof GitError) return undefined;
    throw e;
  }
}

export async function init(ctx: InitContext, opts: { yes: boolean; cwd: string }): Promise<number> {
  const { io } = ctx;
  let root: string | undefined;
  try {
    root = await gitRoot(opts.cwd, ctx.env);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (root === undefined) {
    io.err(`${opts.cwd} is not inside a git repository. Run \`git init\` first, then \`factory init\`.`);
    return 1;
  }
  const dir = join(root, ".factory");
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    io.err(`${dir} exists and is not a directory.`);
    return 1;
  }
  const additions = FILES.filter(([rel]) => !existsSync(join(dir, rel)));
  if (additions.length === 0) {
    io.out(`${dir} is already set up; nothing to add.`);
    return 0;
  }
  if (existsSync(dir)) {
    io.out(`${dir} already exists. Missing files that would be added (existing files are never changed):\n${additions.map(([r]) => `  + .factory/${r}`).join("\n")}`);
    if (!opts.yes && !(await io.confirm("Add these files?"))) {
      io.err("Nothing was changed.");
      return 1;
    }
  }
  for (const [rel, content] of additions) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  }
  io.out(`Created ${additions.length} file(s) in ${dir}. Review and commit them.`);
  return 0;
}
