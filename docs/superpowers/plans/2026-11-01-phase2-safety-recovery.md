# Phase 2 — Safety and Recovery Basics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Code-enforced guardrails and durable progress: `GatePolicy` with a fail-closed command policy enforced in Pi's `tool_call` hook, route state with `set_route` and reclassification on new user input, a redacted run ledger with gate and decision events, incremental task state with checkpoints, startup reconciliation that resumes interrupted work, `run_check` check records bound to a content fingerprint, and review dispositions.

**Architecture:** Every decision is a pure function in `src/core` (path policy, command classification, gate evaluation, route reducer, machine-section parser, record schemas). The Pi extension (`src/adapters/pi/extension/`) gathers facts (paths, git state, UI availability), calls core, performs the effect (block/ask/allow, append ledger events, run checks, write the machine section) and registers the factory tools. Nothing model-written can produce machine-owned state.

**Tech Stack:** as Phase 1, plus `shell-quote` 1.12.0 (tokenizer only) and Pi's host-provided `typebox` for tool parameter schemas.

**Spec:** `docs/superpowers/specs/2026-10-31-ai-factory-design.md` (A) §8, §10.5, §11, §13; `docs/superpowers/specs/2026-10-31-factory-methodology-design.md` (M) §3.4, §7.0–7.1, §10, §11, §14. Phase row: A §15 "2. Safety and recovery basics". Builds on Phase 1 (branch `phase1-foundations`, plan `2026-10-31-phase1-foundations.md`, ledger rulings R1–R16).

**Acceptance (A §15):** gate suite including bypass attempts passes on both OSes; killing a session mid-task resumes from the last checkpoint.

## Builder rulings taken while planning

`ruling — why — cost if wrong`. Pi facts verified on 2026-11-01 against Pi 1.4.0 `dist/core/extensions/types.d.ts` and `dist/core/tools/*.d.ts`.

1. **Fail-closed, allowlist-first command policy.** Commands are tokenized with `shell-quote` 1.12.0 `parse` and classified only when every token is a plain word, a quoted string, a list operator (`&&`, `||`, `;`, `|`, newline) or a file redirection (`>`, `>>`, `<`, `2>`, `2>&1`, `&>`). Anything else is `unknown`: command or process substitution, backticks, any `$` expansion, globs in command position, heredocs, subshells or braces, `eval`, `exec`, `source`, `.`, `command`, `builtin`, `env`, `xargs`, `sudo`, leading `\`, and interpreters given inline code (`bash|sh|zsh|dash -c`, `node -e|-p|--eval|--print`, `python* -c`, `perl -e`, `ruby -e`, `pwsh|powershell -c|-Command|-EncodedCommand`, `cmd /c`). Executables are matched by basename without `.exe`/`.cmd`/`.bat` so `/usr/bin/git push` is still `git push`. Leading literal `NAME=value` assignments are allowed and stripped — a parser for full shell semantics is a bypass surface; refusing what we do not understand is the only safe default (A §8.1.1) — cost: some legitimate commands need approval.
2. **Command classes** (A §8.1.1): `read-only`, `local-write`, `destructive`, `remote-mutating`, `unknown`; a command line's class is the most severe of its segments and of its redirections (a redirection target outside the write roots or into a secret path makes it `destructive`/secret). Rule tables live in `src/core/policy/command-rules.ts` as data.
3. **PowerShell tool** is always `unknown` in Phase 2 — Pi on Windows runs `bash` through Git Bash by default (A §4), so the bash tool is the normal path — cost: PowerShell users get prompts.
4. **Ask** resolves through `ctx.ui.confirm` when `ctx.hasUI`; without a UI (print/RPC without UI handler, subagents) `ask` becomes `deny` with reason `requires human approval` (A §8.1 "explicit human approval every time").
5. **Answer route in Phase 2** allows `read-only` commands and read tools only; `write`/`edit` and every other command class are denied (interactive: hard-gated classes ask, local-write denies with "declare a change route"). Tracked-file reconciliation for allowlisted runners and the exploration worktree (M §3.1, §14 row 2) arrive with the methodology in Phase 4 — cost: answer-route investigation cannot run test suites until Phase 4.
6. **Write roots per route**: answer → none; small → project root (the git toplevel of the session cwd); feature/project → the task worktree passed to `set_route`, which must exist, be a worktree of the same repository and be on branch `factory/<taskId>`; writes there are allowed only after `<worktree>/.factory/knowledge/tasks/<taskId>.md` exists, except writing that file itself (M §14 row 3). Worktree creation itself is Phase 4/5; tests create worktrees with git.
7. **`.factory/` rules** (M §14 row 4): under any write root, writes inside `.factory/` are allowed only to `.factory/knowledge/tasks/<taskId>.md`, `.factory/knowledge/specs/<taskId>.md`, `.factory/knowledge/plans/<taskId>.md` and new files in `.factory/knowledge/decisions/`; `.factory/config.json` and other tasks' files are denied.
8. **Machine-owned content** (M §14 row 5): a `write`/`edit` whose new content adds, removes or changes text between `<!-- machine: written by code only -->` and `<!-- /machine -->`, or that targets the run ledger directory, is denied. Only the extension writes those.
9. **Run model**: one *factory run* per Pi session process: `run_start` at `session_start`, `run_end` at `session_shutdown`; ledger at `~/.factory/runs/<projectId>/<runId>/events.jsonl`, `projectId = <basename(repoRoot)>-<first 12 hex of sha256(realpath(repoRoot))>`, `runId = <UTC yyyymmddThhmmssZ>-<pid>`. A run without `run_end` whose pid is not alive is *interrupted* (A §10.5) — cost: a long-lived session is one run.
10. **Checkpoint** = `task_progress { checkpoint: true }`: feature/project → `git add -A && git commit -m "factory checkpoint: <taskId> <phase>"` in the task worktree (only that worktree; author from git config); small → `git stash create` and `git update-ref refs/factory/undo/<taskId> <sha>` (undo point, user tree untouched; M §6.1). The SHA goes into the machine section and a ledger `checkpoint` event.
11. **Fingerprint** (M §7.0): copy the worktree's index to a temp file, then with `GIT_INDEX_FILE` set: `git add -A -- . ":(exclude).factory/knowledge/tasks/**"`, `git write-tree`. The tree hash covers committed, tracked-modified and untracked non-ignored files and excludes operational metadata. All non-ignored untracked files count (simplification of "task-created untracked files") — cost: an unrelated untracked file changes the fingerprint (conservative).
12. **Decision log** (A §8.3) = ledger `decision` events written by the `record_decision` tool (kind `soft-gate-skipped | soft-gate-resolved | ruling`, gate id, justification). A skip of soft gate G is accepted only if `autonomyAllowsSkip(G, autonomy, gates.soften)`; rendering in delivery reports and `decisions/` files is Phase 4.
13. **Autonomy** (A §8.3): `low` → no soft gate may be skipped; `medium` → only gates listed in effective `gates.soften`; `high` → any soft gate. Hard gates are never affected by autonomy (A §8.1).
14. **Layer rule update**: the extension zone may value-import `typebox` (host-provided by Pi, docs/packages.md) for tool parameter schemas; it stays type-only for `@earendil-works/*`. `typebox` is added to `peerDependencies` as `"*"` (Pi docs), never to `dependencies`.
15. **Redaction** before anything reaches the ledger: patterns for `ghp_|gho_|ghu_|ghs_|github_pat_` tokens, `sk-ant-…`, `sk-…` (≥20 chars), `AKIA[0-9A-Z]{16}`, `xox[abpr]-…`, `Bearer <token>`, `-----BEGIN … PRIVATE KEY-----` blocks, `://user:pass@` credentials and `(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+`; commands are truncated to 500 chars after redaction.
16. **Out of scope** (by spec phase): exploration worktree and answer-route reconciliation (Phase 4), worktree/integration creation (Phase 4/5), `deliver` (Phase 4; Phase 2 ships the pure `validateDelivery` it will call), `/status` and `factory runs` (Phase 7), subagent mode flag (Phase 5; the policy already takes `mode: "interactive" | "unattended"`).

## Global Constraints

- Everything in Phase 1's Global Constraints still binds (Node, CI matrix, pins, isolation, no `shell: true`, `.cmd` quoting, layers, conventional commits, English artifacts), with Phase 1 ledger rulings R1–R16.
- New runtime dependency: `shell-quote` `1.12.0` exact (devDependency `@types/shell-quote` latest). `typebox` only as a peer (ruling 14). Run `npm run manifest:update` after dependency changes; `reviewedInstallScripts` stays manual.
- Hard gates (A §8.1), never relaxable by any layer or autonomy: destructive operations, publishing/mutating remote state, reading or writing secrets, integrating into the user's branch, writes outside the project root/worktree.
- Secret paths (exact list, case-insensitive on Windows): `**/.env`, `**/.env.*` (except `.env.example`, `.env.sample`, `.env.template`), `~/.pi/agent/auth.json` (and `<PI_CODING_AGENT_DIR>/auth.json`), `~/.claude*/**`, `~/.claude.json`, `~/.codex/auth.json`, `~/.ssh/**`, `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `**/*.pem`, `**/id_rsa*`, `**/id_ed25519*`.
- Gates key on Pi tool names: `read`, `grep`, `find`, `ls` (read tools), `write`, `edit` (write tools), `bash`, `powershell` (commands), factory tools (`set_route`, `task_progress`, `run_check`, `record_decision`, `record_review`), anything else (MCP, codemode, other extensions) → `unknown`. Nested calls (`parentToolCallId`, e.g. from codemode) go through the same `tool_call` hook and get the same policy.
- Every gate decision is audited as a ledger `gate` event (tool, class, decision, reason, redacted summary).
- No network in hooks; no per-turn git scans: git is invoked only by factory tools (`set_route` validation, `task_progress`, `run_check`) and once at session start (repo root, reconciliation).
- Tests: model-free (faux provider), isolated temp `FACTORY_HOME`, `PI_CODING_AGENT_DIR`, `HOME`-like dirs; never the real ones; Pi stdin closed except the RPC test.

## Review Focus

1. **Bypass attempts** (A §8.1.1): indirection, encoded payloads, interpreters with inline code, path tricks (`../`, symlinks, `~`, Windows `C:\` vs `/c/`, case), redirections outside the worktree, chained commands hiding a push. Pinned by the Task 2 corpus and the Task 11 e2e suite.
2. **Symlinks and path normalization**: a write to `worktree/link-to-outside/x` must be treated as outside; Git Bash paths (`/c/Users/...`) on Windows must normalize. Pinned by Task 1 tests (`realpath` of the nearest existing ancestor, as in Phase 1's spike `realTarget`).
3. **Session resumed after a crash** must not regain write permission silently for a different request: route restored from session entries, but `needs_reclassification` set if the next consumed user input is new. Pinned by Task 8 and Task 12.
4. **Ledger corruption** (half-written last line after SIGKILL): readers skip an unparseable final line and reconciliation still works. Pinned by Task 6.
5. **Checks run on stale content**: a check record taken before a further edit must not validate delivery. Pinned by Task 10 (`validateDelivery` rejects a mismatched fingerprint).

---

## File structure

```
src/core/policy/paths.ts            path classification, secret paths, write-root containment
src/core/policy/redact.ts           redaction
src/core/policy/shell.ts            tokenizer wrapper → segments | unknown
src/core/policy/command-rules.ts    data tables (read-only, allowlist, destructive, remote)
src/core/policy/command.ts          classifyCommandLine
src/core/policy/gate.ts             GatePolicy.evaluate, ToolAction, GateContext, Decision
src/core/policy/autonomy.ts         autonomyAllowsSkip
src/core/route/route.ts             route state + reducer + set_route validation (pure)
src/core/ledger/events.ts           run ledger event schemas, projectId/runId helpers
src/core/task/machine.ts            machine-section parse/render (pure)
src/core/evidence/records.ts        check record, review disposition, validateDelivery
src/adapters/pi/extension/index.ts  (modified) wiring
src/adapters/pi/extension/ledger.ts       append/read/reconcile (node:fs)
src/adapters/pi/extension/facts.ts        repo root, realpath, git helpers (node:child_process)
src/adapters/pi/extension/enforce.ts      tool_call → GatePolicy → block/ask/allow + audit
src/adapters/pi/extension/route-state.ts  set_route tool, persistence, reclassification, prompt sections
src/adapters/pi/extension/task-state.ts   task_progress tool, machine section writes, checkpoints
src/adapters/pi/extension/evidence.ts     run_check, record_review, record_decision, fingerprint
test/core/policy/*.test.ts, test/core/route/*.test.ts, test/core/ledger/*.test.ts, test/core/task/*.test.ts, test/core/evidence/*.test.ts
test/fixtures/gate-corpus.ts        bypass corpus (data)
test/e2e/gates.e2e.test.ts, test/e2e/resume.e2e.test.ts, test/e2e/ask.e2e.test.ts
```

---

### Task 1: Path policy and redaction (core)

**Files:** Create `src/core/policy/paths.ts`, `src/core/policy/redact.ts`; Test `test/core/policy/paths.test.ts`, `test/core/policy/redact.test.ts`.

**Interfaces:**
- Produces: `PathFacts = { input: string; resolved: string /* absolute, realpath of nearest existing ancestor + tail */; platform: "posix" | "win32" }` (facts are computed by the extension, Task 6, and passed in; core never touches the filesystem).
- Produces: `classifyPath(p: PathFacts, ctx: { home: string; piAgentDir: string; writeRoots: string[]; tmpRoots: string[] }): { secret: boolean; within: "write-root" | "tmp" | "outside"; root?: string; relative?: string }` — containment by path segments (not string prefix), case-insensitive on win32; Git Bash `/c/x` normalized to `C:\x` on win32 before comparison.
- Produces: `isSecretPath(resolved, ctx): boolean` per the Global Constraints list (`.env.example|sample|template` excluded).
- Produces: `redact(text: string): string` per ruling 15 (replace secrets with `***`), `summarizeCommand(cmd): string` (redact, collapse whitespace, truncate 500).

- [ ] **Step 1: Write failing tests**: `within` for `root/a`, `root/../x` (resolved by caller → outside), sibling `root-other/x` (prefix trap → outside), win32 `C:\Repo\a` vs root `c:\repo` → write-root, `/c/Repo/a` on win32 → write-root; secret: `proj/.env` yes, `proj/.env.example` no, `home/.ssh/id_ed25519` yes, `piAgentDir/auth.json` yes, `home/.claude/settings.json` yes, `home/.claude.json` yes; redact: each ruling-15 pattern replaced, normal text untouched, `https://u:p@host/x` → `https://***@host/x`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (`npm run lint && npm test`).
- [ ] **Step 5: Commit** `feat(policy): add path classification, secret paths and redaction`.

### Task 2: Shell tokenizer and command classification (core)

**Files:** Create `src/core/policy/shell.ts`, `src/core/policy/command-rules.ts`, `src/core/policy/command.ts`, `test/fixtures/gate-corpus.ts`; Test `test/core/policy/shell.test.ts`, `test/core/policy/command.test.ts`; Modify `package.json` (dependency), `release.json` (`manifest:update`).

**Interfaces:**
- Produces: `CommandClass = "read-only" | "local-write" | "destructive" | "remote-mutating" | "unknown"`; `severity(c)` order read-only < local-write < unknown < destructive < remote-mutating (unknown below hard classes so a known hard class is reported, but unknown still never runs unattended).
- Produces: `tokenizeCommandLine(cmd: string): { ok: true; segments: Segment[] } | { ok: false; reason: string }`, `Segment = { argv: string[]; redirections: { op: string; target: string }[] }`, per ruling 1.
- Produces: `classifyCommandLine(cmd: string, ctx: { projectCommands: string[] /* declared runners, exact strings */ }): { class: CommandClass; reasons: string[]; redirectTargets: string[]; allowlisted: boolean }` — `allowlisted` true when every segment is read-only or matches the unattended allowlist (ruling 2 tables) or a project-declared command exactly.

Rule tables (data, `command-rules.ts`):
- read-only: `ls cat head tail wc sort uniq cut tr grep rg fd find* tree pwd which whereis type file stat du df echo printf true false test [ basename dirname realpath readlink date env? (no — env is unknown) sleep diff cmp jq* node --version npm --version git status|log|diff|show|rev-parse|ls-files|branch (no -d/-D/-m)|remote -v|config --get|blame|describe|tag (list only)|fetch` (`find` only without `-exec`, `-execdir`, `-delete`, `-ok`, `-fprint*`; `jq` without `-i`/`--in-place`).
- unattended allowlist (local-write): `npm|pnpm|yarn|bun (test|run test|run build|run lint|run typecheck|ci|install --frozen-lockfile|install --immutable)`, `npx vitest|jest|tsc|eslint|prettier --check`, `vitest`, `jest`, `tsc`, `eslint`, `prettier --check|--write`, `pytest`, `uv run pytest`, `uv sync --frozen`, `go test|build|vet`, `cargo test|build|check|clippy|fmt`, `make test|build|lint`, `mkdir`, `touch`, `cp`/`mv` (targets checked by the gate as paths), `git add|commit (no --amend)|switch -c|checkout -b|stash push|stash list|restore --staged`.
- destructive: `rm` with `-r`/`-R`/`--recursive` or targets outside write roots, `rmdir` outside write roots, `git reset --hard`, `git clean`, `git checkout -- <paths>`/`git restore <paths>` (discards), `git branch -D|-d`, `git stash drop|clear`, `git push --force|-f|--force-with-lease`, `git rebase`, `git commit --amend`, `git filter-branch|filter-repo`, `git update-ref -d`, `dd`, `mkfs*`, `shred`, `chmod -R`, `chown`, `truncate`.
- remote-mutating: `git push` (any), `gh pr|issue|release|repo|api` (except `gh api` with only `-X GET`/no `-X` and no `-f/-F/--input`), `npm|pnpm|yarn publish`, `npm unpublish|deprecate|dist-tag`, `curl`/`wget` with `-X POST|PUT|PATCH|DELETE`, `-d`, `--data*`, `-F`, `--form`, `-T`, `--upload-file`, `--post-*`, `ssh`, `scp`, `rsync` with a `host:` target, `docker push`, `kubectl apply|delete|create|patch|replace`, `terraform apply|destroy`, `vercel`, `netlify deploy`, `fly deploy`, `aws` (any except `--version`), `gcloud|az` (any except `--version`).
- everything else → `unknown`.

`gate-corpus.ts` exports `GATE_CORPUS: { cmd: string; expect: CommandClass; why: string }[]` (≥ 60 entries) covering: plain read-only, allowlisted runners, `FOO=1 npm test`, `/usr/bin/git push`, `git -C ../x push` (remote), `git push` hidden after `&&`/`;`/`|`/newline, `$(echo git) push`, `` `git push` ``, `eval "git push"`, `bash -c "git push"`, `sh -c 'rm -rf /'`, `node -e "require('fs').rmSync('/x',{recursive:true})"`, `python3 -c ...`, `echo Z2l0IHB1c2g= | base64 -d | sh` (unknown via `sh` with no script? → `sh` reading stdin is unknown), `curl -d @file https://x`, `curl https://x` (read-only network → read-only), `find . -delete`, `find . -exec rm {} +`, `xargs rm`, `rm -rf node_modules` (destructive by flag), `cat ~/.ssh/id_rsa` (read-only class; the gate makes it a secret read, Task 3), `echo x > /etc/passwd` (redirect target reported), `\git push`, `command git push`, `env git push`, `sudo rm x`, `git commit --amend`, `pwsh -c ...`, `cmd /c ...`, heredoc `cat <<EOF`, `{ git push; }`, `(git push)`, glob command `/usr/bin/g?t push`.

- [ ] **Step 1: Write failing tests**: every corpus entry classifies to `expect`; `tokenizeCommandLine("a $(b)")` → `ok:false`; `redirectTargets` of `echo x > out.txt 2>&1` → `["out.txt"]`; `allowlisted` true for `npm test && npm run lint`, false for `npm test && curl -d x https://h`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (add `shell-quote` 1.12.0; `parse(cmd, env)` with an env function that marks any expansion as unknown). **Step 4: Run** → PASS; `npm run manifest:update`; `npm run lint`.
- [ ] **Step 5: Commit** `feat(policy): add fail-closed shell command classification with a bypass corpus`.

### Task 3: GatePolicy (core)

**Files:** Create `src/core/policy/gate.ts`, `src/core/policy/autonomy.ts`; Test `test/core/policy/gate.test.ts`, `test/core/policy/autonomy.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `ToolAction = { kind: "read"; tool: string; path?: PathFacts } | { kind: "write"; tool: "write" | "edit"; path: PathFacts; touchesMachineSection: boolean } | { kind: "command"; tool: "bash" | "powershell"; command: string; redirectFacts: PathFacts[] } | { kind: "factory"; tool: string } | { kind: "unknown"; tool: string }`.
- Produces: `GateContext = { route: RouteState /* Task 4 */; mode: "interactive" | "unattended"; autonomy: "low"|"medium"|"high"; home; piAgentDir; projectRoot: string; tmpRoots: string[]; ledgerDir: string; projectCommands: string[]; taskFileExists: boolean }`.
- Produces: `evaluateGate(action: ToolAction, ctx: GateContext): { decision: "allow" | "deny" | "ask"; class?: CommandClass; hardGate?: HardGateId; reason: string }` — then `finalize(decision, mode)`: `ask` in unattended → `deny` with `requires human approval` (ruling 4).
- Produces: `autonomyAllowsSkip(gate: SoftGateId, autonomy, softened: SoftGateId[]): boolean` (ruling 13).

Decision rules (in order): (1) factory tools → allow (they validate themselves); (2) unknown tools → ask; (3) read tools: secret path → ask (`secrets`), else allow; (4) write tools: route answer or `needs_reclassification` → deny; secret path → ask (`secrets`); target outside write roots → ask interactive/deny unattended (`outside-root-write`); under the ledger dir or `touchesMachineSection` → deny; `.factory/` rule (ruling 7) → deny; feature/project without task file (except writing it) → deny; else allow; (5) commands: powershell → ask; `classifyCommandLine`; any redirect target secret → ask (`secrets`), outside write roots → `outside-root-write`; class destructive → ask (`destructive`); remote-mutating → ask (`remote-mutation`); unknown → ask; route answer/`needs_reclassification`: read-only → allow, else deny (interactive asks only for hard classes); local-write: unattended → allow only if `allowlisted`, else deny; interactive → allow; read-only → allow. A `cat`/`grep`/`head`… whose argument resolves to a secret path is a secret read (the extension passes argument path facts as `redirectFacts`-like `argFacts`; include `argFacts: PathFacts[]` in the command action).

- [ ] **Step 1: Write failing tests** (decision matrix, ≥ 40 cases): answer route write → deny; small route write in root → allow; write via symlink-resolved outside path → ask (interactive) / deny (unattended); `.env` read → ask; `.factory/config.json` write → deny; other task's file → deny; machine-section edit → deny; feature write before task file → deny, writing the task file → allow; `git push` → ask interactive, deny unattended; `npm test` unattended → allow; `sed -i x file` unattended → deny, interactive small → allow; `cat ~/.ssh/id_rsa` → ask; unknown MCP tool → ask; powershell → ask; `needs_reclassification` + `ls` → allow, + `npm test` → deny; autonomy: low/medium/high × softened.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(policy): add GatePolicy with hard gates, route rules and autonomy`.

### Task 4: Route state (core)

**Files:** Create `src/core/route/route.ts`; Test `test/core/route/route.test.ts`.

**Interfaces:**
- Produces: `Route = "answer" | "small" | "feature" | "project"`; `RouteState = { route: Route; tier?: Route; taskId?: string; reason?: string; worktree?: string; writeRoots: string[]; needsReclassification: boolean; declaredForInput?: number }`; `INITIAL_ROUTE: RouteState` (answer, no roots, false).
- Produces: `validateSetRoute(req: { route; taskId?; reason: string; worktree?: string }, facts: { projectRoot: string; worktreeOk?: { exists: boolean; sameRepo: boolean; branch?: string } }): { ok: true; state: RouteState } | { ok: false; error: string }` — ruling 6 (small → roots `[projectRoot]`, taskId optional → `small-<n>` assigned by caller; feature/project require `taskId` matching `^[a-z0-9][a-z0-9-]{0,63}$` and a worktree that exists, is the same repo and is on `factory/<taskId>`; answer clears roots and task).
- Produces: `routeReducer(state, event): RouteState` for events `{type:"set_route"; state}`, `{type:"user_message_consumed"; index: number /* message index within the run */}`, `{type:"run_started"}`: a consumed user message with `index > 0` sets `needsReclassification: true`; `set_route` clears it; `run_started` does not reset it (M §3.4 point 4).
- Produces: `routeReminder(state): string` (one line for `context`), `ROUTING_RULE_SECTION: string` (prompt section text: declare route with `set_route` before modifying; unset = answer; one-line announcement, M §3.2).

- [ ] **Step 1: Write failing tests**: valid small/feature/answer; feature without worktree → error; worktree on another branch → error; bad taskId → error; reducer: message index 0 → no flag; index 1 → flag; `set_route` → clear; `run_started` keeps the flag.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat(route): add route state, set_route validation and reclassification reducer`.

### Task 5: Ledger events, machine section and evidence records (core)

**Files:** Create `src/core/ledger/events.ts`, `src/core/task/machine.ts`, `src/core/evidence/records.ts`; Modify `scripts/gen-schemas.ts` (schemas `run-event`, `check-record`, `review-disposition`); Test `test/core/ledger/events.test.ts`, `test/core/task/machine.test.ts`, `test/core/evidence/records.test.ts`.

**Interfaces:**
- Produces: `RunEvent` (zod discriminated union on `type`, every event `{ v: 1, ts: string, runId: string }`): `run_start {pid, projectId, projectRoot, factoryVersion, piSession?}`, `run_end {reason}`, `run_interrupted {detectedBy: runId}`, `gate {tool, toolCallId, decision, class?, hardGate?, reason, summary}`, `route {state}`, `decision {kind, gate?, justification}`, `progress {taskId, phase?, item?}`, `checkpoint {taskId, sha, kind: "commit" | "undo-ref"}`, `check {record: CheckRecord}`, `review {disposition: ReviewDisposition}`, `error {where, message}`. Loose objects (forward compat, Phase 1 ruling 11).
- Produces: `projectIdFor(repoRootReal: string, sha256hex: (s: string) => string): string`, `runIdFor(now: Date, pid: number): string` (ruling 9).
- Produces: `MACHINE_OPEN = "<!-- machine: written by code only -->"`, `MACHINE_CLOSE = "<!-- /machine -->"`; `parseMachine(md): { fields: Record<string,string>; start: number; end: number } | undefined`; `renderMachine(fields): string` (`phase: x · base: y · checkpoint: z · worktree: w · run: r`, M §7.1 order); `replaceMachine(md, fields): string` (inserts after frontmatter when absent); `touchesMachine(before: string, after: string): boolean`.
- Produces: `CheckRecord = { id: string /* c-<n> */; command: string; exitCode: number; cwd: string; fingerprint: string; durationMs: number; logPath: string; at: string }`; `ReviewDisposition = { taskId: string; fingerprint: string; disposition: "approved" | "approved_with_rulings" | "escalated"; reviewer: string; findingsSummary: string; at: string }`; `validateDelivery(input: { tier: Route; fingerprint: string; checks: CheckRecord[]; dispositions: ReviewDisposition[]; requiredCheckIds: string[] }): { ok: true } | { ok: false; reasons: string[] }` (every required check exists, exit 0, same fingerprint; feature/project need an `approved*` disposition for the fingerprint; M §11, §14 row 6).

- [ ] **Step 1: Write failing tests**: schemas parse each event and keep unknown fields; `runIdFor` format; machine parse/render/replace round-trip; `touchesMachine` true when inside text changes, false for edits elsewhere; `validateDelivery` rejects mismatched fingerprint, non-zero exit, missing disposition for feature, accepts small without disposition.
- [ ] **Step 2–4:** RED → implement → GREEN (`npm run schemas`).
- [ ] **Step 5: Commit** `feat(core): add run ledger events, machine section and evidence records`.

### Task 6: Extension facts and run ledger (I/O)

**Files:** Create `src/adapters/pi/extension/facts.ts`, `src/adapters/pi/extension/ledger.ts`; Modify `scripts/check-layers.ts` + tests (ruling 14), `package.json` (`peerDependencies.typebox: "*"`); Test `test/adapters/pi/extension/{facts,ledger}.test.ts`.

**Interfaces:**
- Produces (facts.ts, node builtins only): `pathFacts(p: string, cwd: string, home: string): PathFacts` (expand `~`, resolve, realpath of nearest existing ancestor + tail, win32 Git Bash normalization); `repoRoot(cwd): string | undefined` (`git rev-parse --show-toplevel`, non-interactive env, 10 s timeout, `execFileSync` without shell); `worktreeFacts(path, projectRoot): { exists; sameRepo; branch? }` (`git rev-parse --git-common-dir` equality + `git branch --show-current`); `sha256hex(s)`.
- Produces (ledger.ts): `class RunLedger { constructor(dir: string, runId: string); append(e: RunEvent): void /* redacts string fields, appendFileSync + newline */; static read(file): RunEvent[] /* skips an unparseable last line, throws on unparseable middle lines with path */ }`; `ledgerDirFor(factoryHome, projectId): string`; `reconcile(factoryHome, projectId, selfRunId, isAlive: (pid) => boolean): InterruptedRun[]` where `InterruptedRun = { runId; lastProgress?: { taskId; phase?; item? }; lastCheckpoint?: { taskId; sha }; route?: RouteState }` — appends `run_interrupted {detectedBy}` to each interrupted run (so it is reported once).

- [ ] **Step 1: Write failing tests**: symlink escaping a root resolves outside; `~` expansion; Git Bash path on win32 (skip elsewhere); ledger append redacts a token; read skips a truncated final line; middle corruption throws with path; reconcile finds a run with dead pid and no `run_end`, returns last progress/checkpoint/route, and a second reconcile returns nothing; layer test: `typebox` value import allowed in extension, `zod` still forbidden.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat(pi): add extension facts and the redacted run ledger with reconciliation`.

### Task 7: Enforcement in the `tool_call` hook

**Files:** Create `src/adapters/pi/extension/enforce.ts`; Modify `src/adapters/pi/extension/index.ts`, `src/core/handshake.ts` (`policy: "v1"`), `guard/factory-guard.ts` unchanged; Test `test/adapters/pi/extension/enforce.test.ts`, update `test/e2e/handshake.e2e.test.ts` expectations (`policy: "v1"`).

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `toToolAction(event: { toolName: string; input: Record<string, unknown> }, f: { cwd; home; ledgerDir }): ToolAction` (write/edit → `path`; edit → `touchesMachineSection` computed by reading the current file and applying the edits in memory; write → compare existing file content vs new content; bash/powershell → `command` + `redirectFacts` from `classifyCommandLine(...).redirectTargets` + `argFacts` for arguments of read-only commands that look like paths; read/grep/find/ls → `path` when given).
- Produces: `enforce(event, ctx, deps: { policyContext(): GateContext; ledger: RunLedger; ui?: { confirm(title, msg): Promise<boolean> } }): Promise<{ block: true; reason: string } | undefined>` — evaluates, resolves `ask` via `ui.confirm` (title `Factory gate: <hardGate|class>`; message: tool, summary, reason) when available else deny, appends a `gate` event for every decision (allow included), returns the Pi block result for deny.
- The extension registers `enforce` in its `tool_call` handler only when the handshake is ok; when not ok the Phase 1 read-only blocker stays.

- [ ] **Step 1: Write failing tests** (unit with fake ledger/ui): deny returns block with reason; ask + confirm true → allow + gate event `allow (approved)`; ask + no ui → deny `requires human approval`; edit touching machine section → block; every decision appends exactly one gate event with redacted summary.
- [ ] **Step 2–4:** RED → implement → GREEN; `npm run test:e2e` (handshake e2e updated).
- [ ] **Step 5: Commit** `feat(pi): enforce GatePolicy in the tool_call hook with audit events`.

### Task 8: Route state in the extension (`set_route`, persistence, reclassification, prompt sections)

**Files:** Create `src/adapters/pi/extension/route-state.ts`; Modify `index.ts`; Test `test/adapters/pi/extension/route-state.test.ts`, `test/e2e/route.e2e.test.ts`.

**Interfaces:**
- Produces: tool `set_route` (typebox params `{ route: "answer"|"small"|"feature"|"project"; taskId?: string; reason: string; worktree?: string }`), executing `validateSetRoute` with live facts; on success: reducer update, `pi.appendEntry("factory-route", state)`, ledger `route` event; returns the announcement line `Route: <route> — <reason>` (M §3.2); on failure returns an error result (tool `isError`).
- Produces: restore on `session_start`: the last `factory-route` custom entry from `ctx.sessionManager.getEntries()` becomes the state (if its worktree no longer validates → answer + notice).
- Produces: reclassification: count user `message_start` events per run (reset counter at `agent_start`); index > 0 → reducer `user_message_consumed`; persisted as `factory-route` entry with the flag; consumed message text (redacted, truncated 500) recorded in a ledger `progress`-free event `route` with `reason: "user input consumed"`.
- Produces: `before_agent_start` → return `systemPromptOptions.sections` adding `ROUTING_RULE_SECTION` (never replacing the system prompt, A §7.2); `context` → append `routeReminder(state)` as a one-line message-level addition per model call (use the event's documented result shape).

- [ ] **Step 1: Write failing tests**: unit: restore picks the last entry; invalid stored worktree → answer; e2e (faux): scripted `set_route small` then `write` in project → allowed; without `set_route` → write blocked (answer); steering: an RPC test (`RpcClient` from `@earendil-works/pi-coding-agent`) sends a steer message during a run whose faux script pauses on a deferred response; the next `write` is blocked until a new `set_route`. If faux cannot hold the run open deterministically, cover the wiring with a unit test that feeds a second user `message_start` to the handler, and record the substitution in the report.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat(pi): add set_route with persistence, reclassification and routing prompt sections`.

### Task 9: Task state and checkpoints (`task_progress`)

**Files:** Create `src/adapters/pi/extension/task-state.ts`; Modify `index.ts`; Test `test/adapters/pi/extension/task-state.test.ts`.

**Interfaces:**
- Produces: tool `task_progress` (params `{ phase?: string; item?: string; checkpoint?: boolean; message?: string }`), allowed only on small/feature/project routes with a task id: updates the task file machine section (feature/project: `<worktree>/.factory/knowledge/tasks/<taskId>.md`; small: none — small has no task file, M §6.1) via `replaceMachine` with fields `phase`, `base` (first checkpoint's parent or recorded at set_route), `checkpoint`, `worktree`, `run`; checkpoint per ruling 10; ledger `progress` and `checkpoint` events. Writes the task file atomically (tmp + rename) — this is extension code, so the machine-section gate does not apply.
- Produces: `set_route` (Task 8) records `base` = `git rev-parse HEAD` of the worktree/project at declaration into the route state for later machine sections.

- [ ] **Step 1: Write failing tests** (temp git repos + worktree on `factory/t1`): feature checkpoint commits in the worktree and writes `checkpoint: <sha>` into the machine section; user repo branch untouched; small checkpoint creates `refs/factory/undo/<id>` and leaves `git status` unchanged; `task_progress` on answer route → error result; machine section created when absent (after frontmatter).
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat(pi): add task_progress with machine-section updates and checkpoints`.

### Task 10: Evidence tools (`run_check`, `record_review`, `record_decision`) and fingerprint

**Files:** Create `src/adapters/pi/extension/evidence.ts`; Modify `index.ts`; Test `test/adapters/pi/extension/evidence.test.ts`.

**Interfaces:**
- Produces: `fingerprint(dir: string): string` per ruling 11 (temp index under `os.tmpdir()`, removed in `finally`; non-interactive git env).
- Produces: tool `run_check` (params `{ command: string; timeoutSec?: number /* default 600 */ }`): allowed only when `classifyCommandLine(command)` is `read-only` or `allowlisted`, or the command equals a project-declared command (`.factory/config.json` `commands.test|build|lint|typecheck`, added to `ProjectConfig` as an optional loose field); runs it in the route's write root (or the project root on the answer route, read-only commands only) without any shell: each segment's argv is spawned directly (`shell: false`, bounded, process tree torn down on timeout); `&&`-joined segments run sequentially and stop at the first failure; any other operator, pipelines and redirections are rejected with `run_check runs simple commands; split the pipeline`; writes full output to `<ledgerRunDir>/checks/<id>.log`; records `CheckRecord` with the fingerprint taken **before** running (content under test); returns exit code + last 50 lines.
- Produces: tool `record_review` (params `{ taskId; disposition; reviewer; findingsSummary }`) → `ReviewDisposition` bound to the current fingerprint of the task's write root, ledger `review` event.
- Produces: tool `record_decision` (params `{ kind; gate?; justification }`) → enforces `autonomyAllowsSkip` for `soft-gate-skipped`, ledger `decision` event; rejection returns an error result explaining the autonomy level.
- Produces: `loadEvidence(ledgerDir, runIds?): { checks: CheckRecord[]; dispositions: ReviewDisposition[] }` for Phase 4's `deliver`.

- [ ] **Step 1: Write failing tests**: fingerprint stable under task-file edits (`.factory/knowledge/tasks/**`), changes on code edit and on a new untracked file; `run_check npm test`-like (use `node -e` is unknown → rejected; use a project-declared command `node scripts/ok.mjs` declared in `.factory/config.json`) records exit 0 with fingerprint and log; pipeline rejected; check after a further edit → `validateDelivery` mismatch; `record_decision` skip with autonomy low → error, high → event; `record_review` binds the fingerprint.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat(pi): add run_check check records, review dispositions and the decision log`.

### Task 11: Gate suite e2e on both OSes (acceptance 1)

**Files:** Create `test/e2e/gates.e2e.test.ts`, `test/e2e/ask.e2e.test.ts`; Modify `.github/workflows/ci.yml` only if needed (the suite runs under `npm run test:e2e`).

**Interfaces:**
- Consumes: the Pi harness (`ensureTestPi`, `runPiPrint`, faux provider, observer fixture), a temp git project with a declared small route and a feature worktree.

Cases (each a real Pi run with the factory extension via `-e src/adapters/pi/extension/index.ts`, valid state, faux-scripted tool calls; assert observable effect + tool result + `gate` ledger event; exit 0, no timeout): answer route write blocked; small route write allowed; write outside root blocked (no UI); `edit` of a file outside root blocked; `edit` touching the machine section blocked; `.env` read blocked (no UI); `git push` blocked; bypasses from the corpus — `bash -c "git push"`, `eval`, `$(…)`, base64 pipe to `sh`, `/usr/bin/git push`, `git push` after `&&`, `echo x > ../outside.txt`, `rm -rf` outside — all blocked and the side effect absent (use a local bare remote for push attempts so a successful push would be observable); `npm test`-like allowlisted runner allowed in unattended mode; unknown tool (a test extension registering `dangerous_tool`) blocked; codemode nested `write` outside root blocked if codemode is available in Pi 1.4.0 (`tool_search`/`codemode` builtin), else documented skip. `ask.e2e.test.ts`: RPC mode with an extension-UI handler answering `confirm` true for a `git push` to the local bare remote → push happens and the gate event says approved; answering false → no push.

- [ ] **Step 1: Write the suite.** RED evidence without a product toggle: run it once with the `enforce` registration temporarily commented out locally (not committed) and capture the failing cases in the report.
- [ ] **Step 2: Run** `npm run test:e2e` → PASS locally; push; CI 4/4.
- [ ] **Step 3: Commit** `test(e2e): add the gate suite with bypass attempts and the interactive ask path`.

### Task 12: Resume after a killed session (acceptance 2)

**Files:** Modify `src/adapters/pi/extension/index.ts` (startup reconciliation + resume context); Create `test/e2e/resume.e2e.test.ts`.

**Interfaces:**
- Produces: at `session_start` (handshake ok): `reconcile(...)`; for each `InterruptedRun` with a task: `ctx.ui.notify` when available and a `before_agent_start` prompt section `Interrupted factory run <runId>: task <taskId>, phase <phase>, last checkpoint <sha>. Resume from the checkpoint; re-declare the route with set_route.` added to the next run (once); ledger `run_start` of the new run records `resumedFrom: [runIds]`.
- Route: restored from session entries only when the same Pi session is continued (`--continue`/`--session`); `needsReclassification` is set on the first consumed user message as usual (Review Focus 3).

Test: temp project + feature worktree `factory/t1` with task file; run 1 (faux): `set_route feature t1 worktree`, `write` in worktree, `task_progress {phase:"implement", checkpoint:true}`, then a long-running allowed command (`sleep 120` — read-only class) and the test SIGKILLs the Pi process tree after the checkpoint event appears in the ledger; assert run 1 has no `run_end`; run 2 (`--continue`, faux prompt): ledger shows `run_interrupted` for run 1, run 2's `run_start.resumedFrom` includes run 1, the observer fixture captured the resume prompt section containing the checkpoint SHA and phase, the task file machine section still holds that SHA, and the worktree HEAD equals it.

- [ ] **Step 1: Write the test** (RED: before the reconciliation wiring the resume assertions fail).
- [ ] **Step 2: Implement** the wiring. **Step 3: Run** → PASS locally; push; CI 4/4.
- [ ] **Step 4: Commit** `feat(pi): reconcile interrupted runs at startup and resume from the last checkpoint`.

### Task 13: Release 0.2.0 metadata and docs

**Files:** Modify `package.json` (`version` 0.2.0), `release.json` (`factory` 0.2.0; `stateSchemas` unchanged — no breaking state change in Phase 2), `CHANGELOG.md` (`## [0.2.0] - unreleased`: gates, route, ledger, task state, resume, evidence), `README.md` (short "Guardrails" section: what is enforced, what is not — A §11 honest posture), `test/e2e/roundtrip.e2e.test.ts` fixture versions if they hardcode 0.1.0/0.2.0 (derive from `release.json` instead).

- [ ] **Step 1:** update files; `npm run manifest:check` passes; round-trip e2e still green locally.
- [ ] **Step 2: Commit** `chore(release): prepare 0.2.0 metadata and document the guardrails`.

---

## Phase completion checklist (controller, after Task 13)

- Acceptance 1: `test/e2e/gates.e2e.test.ts` + `ask.e2e.test.ts` green on all 4 CI legs.
- Acceptance 2: `test/e2e/resume.e2e.test.ts` green on all 4 legs.
- Round-trip e2e (Phase 1) still green.
- Final whole-branch review (Codex when available, else the documented fallback).
- Merge/tag remain the owner's decision (stacked on `phase1-foundations`).
