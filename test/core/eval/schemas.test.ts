import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PersonalConfig } from "../../../src/core/config/schema.ts";
import {
  baselineModel,
  baselinesFor,
  ContenderPins,
  expectedProvider,
  referenceContender,
  ToolsLock,
} from "../../../src/core/eval/contenders.ts";
import { EvalRunManifest, EvalRunRecord } from "../../../src/core/eval/records.ts";
import { DEFAULT_GATE_REPLY, EvalTask } from "../../../src/core/eval/task.ts";
import { EvalThresholds } from "../../../src/core/eval/thresholds.ts";
import { Profile } from "../../../src/core/profiles/schema.ts";

const readJson = (rel: string): unknown => JSON.parse(readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8"));
const sha40 = "a".repeat(40);
const sha64 = "b".repeat(64);

const task = () => ({
  schema: 1,
  id: "fix-off-by-one",
  title: "Fix an off-by-one",
  tier: "small",
  split: "dev",
  suites: ["smoke"],
  snapshot: { kind: "git", url: "https://example.com/r.git", ref: sha40 },
  prompt: "Fix it.",
  checks: [{ name: "unit", argv: ["npm", "test"] }],
  budget: { wallSec: 600 },
});

const record = () => ({
  v: 1,
  evalRunId: "20261105T101010Z-ab12",
  taskId: "fix-off-by-one",
  contender: "claude-code",
  rep: 0,
  startedAt: "2026-11-05T10:10:10.000Z",
  wallMs: 1234,
  exit: "ok",
  exitCode: 0,
  turns: 1,
  gatesHit: 0,
  checks: [{ name: "unit", pass: true, exitCode: 0, timedOut: false, ms: 50 }],
  pass: true,
  escapedDefects: 0,
  usage: { claude: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
  usageMissing: false,
  quota: { claude: { state: "known", utilization: 0.4 }, codex: { state: "unknown" } },
  diffStat: { files: 1, insertions: 2, deletions: 1 },
  reviewFindings: null,
  corrections: null,
  authWriteBack: "unchanged",
  leakSuspect: false,
  errorSummary: null,
});

const manifest = () => ({
  v: 1,
  evalRunId: "20261105T101010Z-ab12",
  createdAt: "2026-11-05T10:10:10.000Z",
  suite: "smoke",
  profile: "claude-codex",
  contenders: [
    { id: "claude-code", model: "claude-opus-5-5", provider: "claude", argvTemplate: ["claude", "<secret>"], envKeys: ["HOME"] },
    { id: "noop", model: null, provider: null, argvTemplate: [], envKeys: [] },
  ],
  reps: 1,
  seed: 7,
  tasks: [
    {
      id: "fix-off-by-one",
      tier: "small",
      split: "dev",
      source: "public",
      exposure: "public",
      snapshotSha: sha40,
      taskSha256: sha64,
      checksSha256: sha64,
      solutionSha256: null,
    },
  ],
  pins: { claude: "2.1.318", pi: "1.0.0", bridge: "0.3.0" },
  drift: [],
  factory: { version: "0.2.0", commit: null },
  host: { platform: "linux", bwrap: null },
  thresholds: readJson("defaults/eval-thresholds.json"),
  confirms: null,
});

describe("EvalTask", () => {
  it("accepts a valid task and fills the gate and timeout defaults", () => {
    const t = EvalTask.parse(task());
    expect(t.gate).toEqual({ reply: DEFAULT_GATE_REPLY, maxContinuations: 3 });
    expect(t.checks[0]?.timeoutSec).toBe(300);
    expect(EvalTask.parse({ ...task(), snapshot: { kind: "dir" } }).snapshot).toEqual({ kind: "dir" });
  });
  it.each([
    ["bad id", { id: "Bad_ID" }],
    ["empty checks", { checks: [] }],
    ["zero timeout", { checks: [{ name: "u", argv: ["x"], timeoutSec: 0 }] }],
    ["empty argv", { checks: [{ name: "u", argv: [] }] }],
    ["short git ref", { snapshot: { kind: "git", url: "u", ref: "abc123" } }],
    ["unknown key", { extra: 1 }],
    ["too many continuations", { gate: { reply: "ok", maxContinuations: 11 } }],
    ["no suites", { suites: [] }],
    ["short wall budget", { budget: { wallSec: 59 } }],
  ])("rejects %s", (_n, patch) => {
    expect(EvalTask.safeParse({ ...task(), ...patch }).success).toBe(false);
  });
});

describe("EvalRunRecord", () => {
  it("accepts a valid record and rejects drift", () => {
    expect(EvalRunRecord.safeParse(record()).success).toBe(true);
    expect(EvalRunRecord.safeParse({ ...record(), extra: true }).success).toBe(false);
    expect(EvalRunRecord.safeParse({ ...record(), contender: "gpt" }).success).toBe(false);
    expect(EvalRunRecord.safeParse({ ...record(), errorSummary: "x".repeat(501) }).success).toBe(false);
    expect(EvalRunRecord.safeParse({ ...record(), reviewFindings: 0 }).success).toBe(false);
    expect(EvalRunRecord.safeParse({ ...record(), usage: { claude: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } } }).success).toBe(false);
  });
});

describe("EvalRunManifest", () => {
  it("accepts a valid manifest and rejects bad hashes and unknown keys", () => {
    expect(EvalRunManifest.safeParse(manifest()).success).toBe(true);
    const m = manifest();
    m.tasks[0]!.taskSha256 = "abc";
    expect(EvalRunManifest.safeParse(m).success).toBe(false);
    expect(EvalRunManifest.safeParse({ ...manifest(), extra: 1 }).success).toBe(false);
  });
});

describe("data files", () => {
  it("thresholds parse with the ruling 14 values", () => {
    expect(EvalThresholds.parse(readJson("defaults/eval-thresholds.json"))).toEqual({
      schema: 1,
      passRatePp: 5,
      usageReductionPct: 15,
      secondary: { escapedDefectsIncrease: 0, wallTimeIncreasePct: 25, usageIncreasePct: 10 },
    });
    expect(EvalThresholds.safeParse({ ...(readJson("defaults/eval-thresholds.json") as object), passRatePp: -1 }).success).toBe(false);
  });
  it("contender pins parse", () => {
    const p = ContenderPins.parse(readJson("evals/contenders.json"));
    expect(p.claude.version).toBe("2.1.318");
    expect(p.codex.version).toBe("0.166.0");
    expect(p.superpowers.tag).toBe("v7.0.0");
  });
  it("tools lock needs a 40-hex commit", () => {
    const ok = { schema: 1, superpowers: { tag: "v7.0.0", commit: sha40 }, bridge: { version: "0.3.0" } };
    expect(ToolsLock.safeParse(ok).success).toBe(true);
    expect(ToolsLock.safeParse({ ...ok, superpowers: { tag: "v7.0.0", commit: "abc" } }).success).toBe(false);
  });
});

describe("contender helpers", () => {
  it("baselines, reference and providers", () => {
    expect(baselinesFor("codex-only")).toEqual(["codex", "codex-superpowers", "pi-codex"]);
    expect(baselinesFor("claude-codex")).toEqual(["claude-code", "claude-code-superpowers", "pi-bridge"]);
    expect(referenceContender("claude-codex")).toBe("claude-code");
    expect(referenceContender("codex-only")).toBe("codex");
    expect(expectedProvider("pi-bridge")).toBe("claude");
    expect(expectedProvider("pi-codex")).toBe("codex");
    expect(expectedProvider("noop")).toBeNull();
    expect(expectedProvider("oracle")).toBeNull();
  });
  it("baselineModel strips the provider prefix", () => {
    expect(baselineModel(Profile.parse(readJson("profiles/claude-codex.json")))).toBe("claude-opus-5-5");
    expect(baselineModel(Profile.parse(readJson("profiles/codex-only.json")))).toBe("gpt-6.1-sol");
  });
});

describe("PersonalConfig.eval", () => {
  it("accepts the eval block and rejects quotaStopAt above 1", () => {
    const base = { schema: 1, profile: "claude-codex" };
    expect(PersonalConfig.safeParse({ ...base, eval: { tokenBudget: { claude: 10 }, quotaStopAt: 0.8 } }).success).toBe(true);
    expect(PersonalConfig.safeParse({ ...base, eval: { quotaStopAt: 1.5 } }).success).toBe(false);
  });
});
