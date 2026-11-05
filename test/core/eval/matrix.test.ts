import { describe, expect, it } from "vitest";
import type { ContenderId } from "../../../src/core/eval/contenders.ts";
import { hash32, mulberry32, planMatrix, selectTasks, shuffle } from "../../../src/core/eval/matrix.ts";
import type { EvalTask } from "../../../src/core/eval/task.ts";

function task(id: string, split: "dev" | "heldout", suites: EvalTask["suites"]): EvalTask {
  return { id, split, suites } as EvalTask;
}

const TASKS = [
  task("zeta", "dev", ["smoke", "full"]),
  task("alpha", "dev", ["full"]),
  task("mem", "dev", ["memory"]),
  task("hs", "heldout", ["smoke"]),
  task("hf", "heldout", ["full"]),
];
const ids = (ts: EvalTask[]) => ts.map((t) => t.id);

describe("selectTasks", () => {
  it("smoke dev takes tagged dev tasks sorted by id", () => {
    expect(ids(selectTasks(TASKS, { suite: "smoke", heldout: false }))).toEqual(["zeta"]);
  });
  it("full dev takes every dev task", () => {
    expect(ids(selectTasks(TASKS, { suite: "full", heldout: false }))).toEqual(["alpha", "mem", "zeta"]);
  });
  it("memory dev takes tagged dev tasks", () => {
    expect(ids(selectTasks(TASKS, { suite: "memory", heldout: false }))).toEqual(["mem"]);
  });
  it("heldout takes only heldout tasks tagged with the suite", () => {
    expect(ids(selectTasks(TASKS, { suite: "smoke", heldout: true }))).toEqual(["hs"]);
  });
  it("heldout full takes all heldout tasks", () => {
    expect(ids(selectTasks(TASKS, { suite: "full", heldout: true }))).toEqual(["hf", "hs"]);
  });
  it("taskIds filters further", () => {
    expect(ids(selectTasks(TASKS, { suite: "full", heldout: false, taskIds: ["zeta", "alpha"] }))).toEqual(["alpha", "zeta"]);
  });
  it("a requested task outside the selected suite or split throws instead of being dropped", () => {
    expect(() => selectTasks(TASKS, { suite: "smoke", heldout: false, taskIds: ["alpha"] })).toThrow(
      "task alpha is not in suite smoke (dev)",
    );
    expect(() => selectTasks(TASKS, { suite: "full", heldout: false, taskIds: ["hf"] })).toThrow("task hf is not in suite full (dev)");
  });
  it("unknown task id throws", () => {
    expect(() => selectTasks(TASKS, { suite: "full", heldout: false, taskIds: ["nope"] })).toThrow("unknown task: nope");
  });
});

describe("mulberry32", () => {
  it("matches the standard first outputs for seed 1", () => {
    const r = mulberry32(1);
    expect([r(), r(), r()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  });
});

describe("hash32", () => {
  it("is stable and sensitive to every input", () => {
    expect(hash32(42, "a", 1)).toBe(hash32(42, "a", 1));
    expect(hash32(42, "a", 1)).not.toBe(hash32(43, "a", 1));
    expect(hash32(42, "a", 1)).not.toBe(hash32(42, "b", 1));
    expect(hash32(42, "a", 1)).not.toBe(hash32(42, "a", 2));
  });
  it("pins a known value", () => {
    expect(hash32(42, "a", 1)).toBe(1652516279);
  });
});

describe("shuffle", () => {
  it("does not mutate and returns a permutation", () => {
    const xs = [1, 2, 3, 4, 5];
    const out = shuffle(xs, mulberry32(7));
    expect(xs).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual(xs);
  });
});

describe("planMatrix", () => {
  const cs: ContenderId[] = ["claude-code", "codex", "noop"];
  it("orders rep, then task, with each block a permutation", () => {
    const m = planMatrix(["b", "a"], cs, 2, 42);
    expect(m).toHaveLength(12);
    const keys: string[] = [];
    for (let i = 0; i < m.length; i += 3) {
      const block = m.slice(i, i + 3);
      expect(new Set(block.map((s) => `${s.rep}:${s.taskId}`)).size).toBe(1);
      expect(block.map((s) => s.contender).sort()).toEqual([...cs].sort());
      keys.push(`${block[0]!.rep}:${block[0]!.taskId}`);
    }
    expect(keys).toEqual(["1:b", "1:a", "2:b", "2:a"]);
  });
  it("is deterministic for a seed", () => {
    expect(planMatrix(["a", "b"], cs, 2, 42)).toEqual(planMatrix(["a", "b"], cs, 2, 42));
  });
  it("differs between seeds 42 and 43 in at least one block", () => {
    expect(planMatrix(["a", "b"], cs, 2, 42)).not.toEqual(planMatrix(["a", "b"], cs, 2, 43));
  });
});
