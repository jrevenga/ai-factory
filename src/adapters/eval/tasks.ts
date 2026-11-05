// Task store: loads `<root>/<id>/task.json` snapshots and hashes task trees for the run manifest (ruling 16).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { EvalTask } from "../../core/eval/task.ts";

export type TaskSource = "public" | "private";

export interface LoadedTask {
  task: EvalTask;
  /** The task directory `<root>/<id>`. */
  dir: string;
  source: TaskSource;
  hasSolution: boolean;
}

export interface TaskRoot {
  dir: string;
  source: TaskSource;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function loadOne(dir: string, id: string, source: TaskSource): LoadedTask {
  const file = join(dir, "task.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`${file}: cannot read task definition: ${(e as Error).message}`, { cause: e });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file}: not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  const parsed = EvalTask.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${file}: invalid task definition: ${issues}`);
  }
  const task = parsed.data;
  if (task.id !== id) throw new Error(`${file}: task id "${task.id}" must equal its directory name "${id}"`);
  if (task.snapshot.kind === "dir" && !isDir(join(dir, "repo"))) {
    throw new Error(`${file}: a dir snapshot needs a repo/ directory (${join(dir, "repo")} is missing)`);
  }
  return { task, dir, source, hasSolution: isDir(join(dir, "solution")) };
}

/** Loads every task of the given roots (a missing root is skipped); an id may appear once across all roots. Sorted by id. */
export function loadTasks(roots: TaskRoot[]): LoadedTask[] {
  const byId = new Map<string, LoadedTask>();
  for (const root of roots) {
    if (!isDir(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const dir = join(root.dir, entry.name);
      if (!isDir(dir)) continue;
      const loaded = loadOne(dir, entry.name, root.source);
      const prior = byId.get(loaded.task.id);
      if (prior) throw new Error(`duplicate task id "${loaded.task.id}": ${prior.dir} and ${dir}`);
      byId.set(loaded.task.id, loaded);
    }
  }
  return [...byId.values()].sort((a, b) => (a.task.id < b.task.id ? -1 : 1));
}

interface HashEntry {
  rel: string;
  kind: "F" | "L";
  data: Buffer;
}

function collect(dir: string, prefix: string, out: HashEntry[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.push({ rel, kind: "L", data: Buffer.from(readlinkSync(abs).replace(/\\/g, "/")) });
    else if (st.isDirectory()) collect(abs, rel, out);
    else if (st.isFile()) out.push({ rel, kind: "F", data: readFileSync(abs) });
  }
}

/**
 * sha256 over the entries of a tree sorted by POSIX relative path. Each entry is `relpath\0<bytes>` (a
 * symlink contributes its target text and is never followed; directories are implied), framed with a kind
 * tag and the byte length so that file boundaries cannot be confused with file content.
 */
export function hashTree(dir: string): string {
  if (!existsSync(dir)) throw new Error(`cannot hash a missing directory: ${dir}`);
  const entries: HashEntry[] = [];
  collect(dir, "", entries);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash("sha256");
  for (const e of entries) {
    h.update(`${e.kind}${e.rel}\0${e.data.length}\0`);
    h.update(e.data);
  }
  return h.digest("hex");
}
