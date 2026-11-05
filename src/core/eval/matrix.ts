// Task selection and the seeded run matrix (Phase 3 rulings 11, 12). Pure: no effects.
import type { ContenderId } from "./contenders.ts";
import type { EvalTask, TASK_SUITES } from "./task.ts";

export type TaskSuite = (typeof TASK_SUITES)[number];

export type TaskSelection = { suite: TaskSuite; heldout: boolean; taskIds?: string[] };

export function selectTasks(tasks: EvalTask[], sel: TaskSelection): EvalTask[] {
  const split = sel.heldout ? "heldout" : "dev";
  let out = tasks.filter((t) => t.split === split && (sel.suite === "full" || t.suites.includes(sel.suite)));
  if (sel.taskIds) {
    const known = new Set(tasks.map((t) => t.id));
    for (const id of sel.taskIds) if (!known.has(id)) throw new Error(`unknown task: ${id}`);
    // An explicitly requested task outside the selection is an error, never silently dropped.
    const selected = new Set(out.map((t) => t.id));
    for (const id of sel.taskIds) if (!selected.has(id)) throw new Error(`task ${id} is not in suite ${sel.suite} (${split})`);
    const wanted = new Set(sel.taskIds);
    out = out.filter((t) => wanted.has(t.id));
  }
  return [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type RunSpec = { taskId: string; contender: ContenderId; rep: number };

/** FNV-1a 32-bit over the UTF-8 bytes of `${seed}:${taskId}:${rep}`. */
export function hash32(seed: number, taskId: string, rep: number): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(`${seed}:${taskId}:${rep}`)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Standard mulberry32 PRNG; returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates; returns a new array. */
export function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function planMatrix(taskIds: readonly string[], contenders: readonly ContenderId[], reps: number, seed: number): RunSpec[] {
  const specs: RunSpec[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const taskId of taskIds) {
      for (const contender of shuffle(contenders, mulberry32(hash32(seed, taskId, rep)))) {
        specs.push({ taskId, contender, rep });
      }
    }
  }
  return specs;
}
