// Fix round 4 (task-3-codex-review.md, rulings R40-R44): every review input goes through the real adapter facts
// (`toToolAction`) and the gate, in a harmless fixture world. Nothing here executes a command under review: the
// commands are only classified; the fixture files hold dummy text.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toToolAction } from "../../../../src/adapters/pi/extension/enforce.ts";
import { canonicalDir, trackedSecretFact } from "../../../../src/adapters/pi/extension/facts.ts";
import { evaluateGate, type GateContext } from "../../../../src/core/policy/gate.ts";
import type { RouteState } from "../../../../src/core/route/types.ts";
import { GATE_CORPUS } from "../../../fixtures/gate-corpus.ts";
import { makeTmp, type Tmp } from "../../../helpers/tmp.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const DUMMY = "dummy fixture text, not a secret\n";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", ...args], {
    cwd,
    env: GIT_ENV,
    stdio: "ignore",
  });
}

interface World {
  tmp: Tmp;
  home: string;
  project: string;
  outside: string;
  ledger: string;
}

/**
 * <tmp>/home                    fake home: .aws/credentials, .ssh/id_rsa (dummy text)
 * <tmp>/home/proj               project (git, tracks a dummy .env, README.md, notes.txt)
 *   auth -> ../.aws/credentials, sub/auth -> ../../.aws/credentials   neutral-name links to a home secret
 *   a/.env, b/.env, src/.env, src/a.ts                                 directories with secret descendants
 *   out/safe.txt -> <tmp>/outside/result.txt                           a destination child that leaves the root
 *   rel/l -> ../.aws/credentials                                       R28: proj/.aws/credentials (absent) in place
 *   safe.txt, input.txt, notes, format.txt, names, -input, mods/leak.jq
 * <tmp>/outside/result.txt      outside the project
 * <tmp>/state/runs              the ledger directory
 */
async function makeWorld(trackSecret: boolean): Promise<World> {
  const tmp = await makeTmp("classifier-gate");
  const home = join(tmp.dir, "home");
  const project = join(home, "proj");
  const outside = join(tmp.dir, "outside");
  const ledger = join(tmp.dir, "state", "runs");
  for (const d of [join(home, ".aws"), join(home, ".ssh"), project, outside, ledger]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".aws", "credentials"), DUMMY);
  writeFileSync(join(home, ".ssh", "id_rsa"), DUMMY);
  writeFileSync(join(outside, "result.txt"), DUMMY);
  for (const d of ["a", "b", "src", "out", "mods", "sub"]) mkdirSync(join(project, d));
  writeFileSync(join(project, "a", ".env"), "A=1\n");
  writeFileSync(join(project, "b", ".env"), "B=2\n");
  writeFileSync(join(project, "src", ".env"), "S=3\n");
  writeFileSync(join(project, "src", "a.ts"), "export {};\n");
  for (const f of ["safe.txt", "input.txt", "notes", "format.txt", "names", "-input", "README.md", "notes.txt"]) writeFileSync(join(project, f), DUMMY);
  writeFileSync(join(project, "mods", "leak.jq"), "def leak: 1;\n");
  symlinkSync(join("..", ".aws", "credentials"), join(project, "auth"));
  symlinkSync(join("..", "..", ".aws", "credentials"), join(project, "sub", "auth"));
  symlinkSync(join(outside, "result.txt"), join(project, "out", "safe.txt"));
  // R28 relative-symlink fixture (Task 12): harmless in rel/, the home secret once copied to the project root.
  mkdirSync(join(project, "rel"));
  symlinkSync(join("..", ".aws", "credentials"), join(project, "rel", "l"));
  git(project, "init", "-q");
  if (trackSecret) writeFileSync(join(project, ".env"), "DUMMY=1\n");
  git(project, "add", "--", "README.md", "notes.txt", ...(trackSecret ? [".env"] : []));
  git(project, "commit", "-q", "-m", "init");
  return { tmp, home, project, outside, ledger };
}

const quote = (p: string) => `'${p}'`;

/** Maps the review's absolute paths into the fixture (single-quoted: the temporary directory contains a space). */
function localize(cmd: string, w: World): string {
  return cmd
    .replaceAll("/h/", `${quote(w.home)}/`)
    .replaceAll("/outside/", `${quote(w.outside)}/`)
    .replaceAll("/state/runs", quote(w.ledger));
}

function contexts(w: World) {
  const project = canonicalDir(w.project);
  const base = {
    mode: "unattended" as const,
    autonomy: "medium" as const,
    home: canonicalDir(w.home),
    piAgentDir: canonicalDir(join(w.home, ".pi", "agent")),
    projectRoot: project,
    tmpRoots: [],
    ledgerDir: canonicalDir(w.ledger),
    projectCommands: [],
    taskFileExists: true,
    gitDirs: [join(project, ".git")],
  };
  const small: RouteState = { route: "small", tier: "small", taskId: "small-1", reason: "test", writeRoots: [project], needsReclassification: false };
  const answer: RouteState = { route: "answer", writeRoots: [], needsReclassification: false };
  return { small: { ...base, route: small } satisfies GateContext, answer: { ...base, route: answer } satisfies GateContext };
}

function decide(cmd: string, w: World, ctx: GateContext) {
  const action = toToolAction(
    { toolName: "bash", toolCallId: "c1", input: { command: localize(cmd, w) } },
    { cwd: w.project, home: w.home, projectCommands: [], piAgentDir: ctx.piAgentDir },
  );
  return evaluateGate(action, ctx);
}

describe("classifier to gate through adapter facts (fix round 4)", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld(true);
  });
  afterAll(async () => {
    await w.tmp.cleanup();
  });

  for (const entry of GATE_CORPUS.filter((e) => e.gate !== undefined)) {
    const g = entry.gate!;
    it(`${JSON.stringify(entry.cmd)}: small ${g.decision}${g.hardGate ? ` (${g.hardGate})` : ""}, answer ${g.answer}`, () => {
      const { small, answer } = contexts(w);
      const s = decide(entry.cmd, w, small);
      expect(s.decision, s.reason).toBe(g.decision);
      expect(s.hardGate, s.reason).toBe(g.hardGate);
      const a = decide(entry.cmd, w, answer);
      expect(a.decision, a.reason).toBe(g.answer);
      expect(a.hardGate, a.reason).toBe(g.answerHardGate);
    });
  }

  it("R48: git fetch <name> is unknown when <name>, <name>.git or <name>.bundle exists; plain remotes keep their class", () => {
    const { small, answer } = contexts(w);
    for (const entry of ["backup", "backup.git", "backup.bundle"]) {
      writeFileSync(join(w.project, entry), "not a remote\n");
      for (const ctx of [small, answer]) expect(decide("git fetch backup", w, ctx).decision, entry).not.toBe("allow");
      rmSync(join(w.project, entry));
    }
    for (const ctx of [small, answer]) expect(decide("git fetch origin", w, ctx).decision).toBe("allow");
  });

  it("R48: git show --stat with a ref selector asks for a tracked secret", () => {
    const { small } = contexts(w);
    expect(decide("git show --stat --tags", w, small)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(decide("git show --stat HEAD", w, small).decision).toBe("allow");
  });

  it("bash facts carry whether each path is a directory (R43)", () => {
    const action = toToolAction({ toolName: "bash", toolCallId: "c2", input: { command: "diff a safe.txt" } }, { cwd: w.project, home: w.home, projectCommands: [] });
    if (action.kind !== "command") throw new Error("expected a command");
    expect(action.pathFacts.find((f) => f.input === "a")?.directory).toBe(true);
    expect(action.pathFacts.find((f) => f.input === "safe.txt")?.directory).toBe(false);
  });

  it("the tracked-secret fact is supplied only for content-printing git commands (R41)", () => {
    const facts = { cwd: w.project, home: w.home, projectCommands: [] };
    const diff = toToolAction({ toolName: "bash", toolCallId: "c3", input: { command: "git diff HEAD" } }, facts);
    const status = toToolAction({ toolName: "bash", toolCallId: "c4", input: { command: "git status" } }, facts);
    expect(diff).toMatchObject({ kind: "command", trackedSecret: true });
    expect(status).not.toHaveProperty("trackedSecret");
  });

  it("the grep tool on a mixed-case secret directory asks (R27)", () => {
    const { answer } = contexts(w);
    const upper = canonicalDir(w.home).replace(/home$/, "HOME");
    for (const p of [join(canonicalDir(w.home), ".AWS"), join(upper, ".aws")]) {
      const action = toToolAction({ toolName: "grep", toolCallId: "c5", input: { pattern: "x", path: p } }, { cwd: w.project, home: w.home, projectCommands: [] });
      expect(evaluateGate(action, answer), p).toMatchObject({ decision: "ask", hardGate: "secrets" });
    }
  });
});

describe("tracked-secret fact (R41)", () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const w of worlds) await w.tmp.cleanup();
  });

  it("is false in a repository that tracks no secret path, so content-printing git is allowed", async () => {
    const w = await makeWorld(false);
    worlds.push(w);
    const { small, answer } = contexts(w);
    expect(trackedSecretFact(w.project, w.home, small.piAgentDir)).toBe(false);
    for (const cmd of ["git diff HEAD", "git show HEAD", "git log -p -1"]) {
      expect(decide(cmd, w, answer), cmd).toMatchObject({ decision: "allow", reconcile: false });
      expect(decide(cmd, w, small).decision, cmd).toBe("allow");
    }
    // A named secret blob still asks without being tracked (it may exist in history).
    expect(decide("git show HEAD^:.env", w, answer)).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("fix round 5: without a tracked secret, --no-index behind an option value and a bare -U still do not run (N1, N2)", async () => {
    const w = await makeWorld(false);
    worlds.push(w);
    const { small, answer } = contexts(w);
    for (const cmd of ["git diff --src-prefix --no-index a b", "git diff --line-prefix --no-index src out", "git diff -U --no-index a b", "git diff --unified --no-index a b"]) {
      expect(decide(cmd, w, small), cmd).toMatchObject({ decision: "ask" });
      expect(decide(cmd, w, answer).decision, cmd).toBe("deny");
    }
    for (const cmd of ["git show -U HEAD:.env", "git diff -U HEAD:.env HEAD:notes.txt"]) {
      expect(decide(cmd, w, answer), cmd).toMatchObject({ decision: "ask", hardGate: "secrets" });
    }
    // Nothing secret is tracked: a stat-only show and --check are allowed.
    expect(decide("git show --stat", w, answer).decision).toBe("allow");
    expect(decide("git log --check", w, answer).decision).toBe("allow");
  });

  it("is true when a secret path is tracked, from a subdirectory too", async () => {
    const w = await makeWorld(true);
    worlds.push(w);
    expect(trackedSecretFact(w.project, w.home, join(w.home, ".pi", "agent"))).toBe(true);
    expect(trackedSecretFact(join(w.project, "src"), w.home, join(w.home, ".pi", "agent"))).toBe(true);
  });

  it("is undefined outside a repository (the gate then asks)", async () => {
    const t = await makeTmp("classifier-gate-norepo");
    worlds.push({ tmp: t, home: t.dir, project: t.dir, outside: t.dir, ledger: t.dir });
    expect(trackedSecretFact(t.dir, t.dir, join(t.dir, ".pi", "agent"))).toBeUndefined();
  });
});
