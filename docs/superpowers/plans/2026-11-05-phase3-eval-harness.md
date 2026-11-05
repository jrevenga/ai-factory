# Phase 3 — Evaluation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible, model-agnostic evaluation harness: a versioned task format with withheld checks that the agent can never reach, controlled per-run state, a dev/held-out split, runners for every same-provider baseline of both profiles, per-provider usage, paired statistics with pre-registered thresholds, and Markdown + JSON reports, driven by `factory eval`.

**Architecture:** Pure logic in `src/core/eval/` (schemas, task selection and run matrix, stream parsers, statistics, report rendering). Effects in `src/adapters/eval/` (task loading, workspace materialization, bubblewrap sandbox, contender invocation and process supervision, check execution, the orchestrator with resume and budget stops). `src/cli/commands/eval.ts` composes them behind `factory eval setup|tasks|run|report`. Every contender runs inside a bubblewrap sandbox that hides the owner's home directory (and with it the task store, withheld checks, reference solutions and personal logins) and exposes only the run's workspace, the run's fresh home and the dedicated eval login directories.

**Tech Stack:** as Phase 2. No new npm dependency. bubblewrap (`bwrap`, a system tool) is required only for model-calling contenders and is probed at runtime.

**Spec:** `docs/superpowers/specs/2026-10-31-ai-factory-design.md` (A) §3, §12.1, §14 (`EvalRunner`), §15 row "3. Evaluation harness"; `docs/superpowers/specs/2026-10-31-factory-methodology-design.md` (M) §18 (first experiments need this harness). Builds on Phases 1–2 (v0.2.0, rulings R1–R68 in the Phase 1/2 ledgers).

**Acceptance (A §15):** reproducible baseline report for all baselines on the smoke suite, both profiles.

## Builder rulings taken while planning

`ruling — why — cost if wrong`. CLI facts verified on 2026-11-05 on the owner's server: Claude Code 2.1.318, codex-cli 0.166.0, Pi 1.4.0 (project dependency), bubblewrap 0.9.0 (unprivileged; `--tmpfs $HOME` and `--unshare-net` work), Superpowers 7.0.0.

1. **Sandbox = bubblewrap, model-calling contenders fail closed without it.** `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs <realHome> [--tmpfs <each extra hidden root>] [--ro-bind <tool dir>]… [--bind <rw dir>]… --chdir <workspace> --unshare-pid --unshare-ipc --die-with-parent --new-session [--unshare-net]` → command. The tmpfs over the real home hides the factory repo, `evals/` (checks and solutions), the private task store, `~/.factory/eval/runs` of other runs, and the owner's personal logins (`~/.claude`, `~/.codex`, `~/.pi`, `~/.ssh`). Hidden roots outside the home (task roots, eval root when `FACTORY_HOME` is elsewhere) get their own tmpfs. Tool install dirs under the home are re-exposed read-only (realpath of each binary's install dir); the run's workspace and fresh home, and the contender's eval login dir, are bound read-write. Model-calling evals run only on the owner's Linux server (A §12.1 [owner]); on a host without a working `bwrap` they are refused with a clear message. Test contenders (ruling 9) run unsandboxed there so CI on Windows still exercises the orchestrator — cost if wrong: a contender needs a path we did not expose (fails loudly in the live probe, Task 12).
2. **Agents run in each CLI's non-interactive full-permission mode, inside the sandbox.** Claude Code `--permission-mode bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox` (documented for externally sandboxed environments; nested bwrap is not relied on), plain Pi (no approvals). Same footing for every baseline; the sandbox is the boundary — cost if wrong: a CLI default mode would have scored differently; recorded in the report as part of the pinned conditions.
3. **Withheld checks are materialized only after the agent's process tree is gone.** The workspace is a fresh git repo; after the contender exits (or is killed), the runner copies the workspace into `verify/`, overlays the task's `checks/` files and runs the check commands there in a sandbox with `--unshare-net`. The final assistant message is written to `verify/.eval/final-message.txt` so answer-style checks can read it. A dir snapshot is committed fresh (no history), so the solution is never in `.git` — cost: none.
4. **Dedicated eval logins, never the owner's personal ones.** Personal logins are hidden by the sandbox and never copied (OAuth refresh-token rotation in a copy would break the personal login). Under `<evalRoot> = <FACTORY_HOME>/eval` (mode 0700): `auth/codex/` (a `CODEX_HOME` the owner logs into once), `auth/pi/` (a `PI_CODING_AGENT_DIR` the owner logs into once with `openai-codex`), `secrets/claude-oauth-token` (mode 0600, the output of `claude setup-token`; passed as `CLAUDE_CODE_OAUTH_TOKEN`, works with a fresh `CLAUDE_CONFIG_DIR`). The factory never prints, logs or copies these; `factory eval setup` reports presence and status only (`codex login status`, `pi auth check --no-refresh --json` without `--credentials`, token file existence and mode) — cost if wrong: a CLI rejects the token env or the login dir (seen in Task 12, before any quota is spent on a suite).
5. **Secrets never in argv.** bwrap is spawned with an explicit, minimal environment (no `--clearenv`/`--setenv`, no inheritance of the parent's env); the token is an env value, never an argument (`/proc/<pid>/cmdline` is world-readable to the user). The token is reachable by the agent inside the sandbox, as any login is for any agent — documented residual risk.
6. **Contenders and pins.** `evals/contenders.json` (core data, versioned) pins `claude` 2.1.318, `codex` 0.166.0, Superpowers 7.0.0 (git URL `https://github.com/obra/superpowers.git`, tag `v7.0.0` and its commit SHA, recorded by `factory eval setup` on first clone and verified after), and takes Pi and pi-claude-bridge from `release.json`. A version mismatch refuses the run unless `--allow-drift`, which is recorded in the report. Baselines per profile (A §12.1): `claude-codex` → `claude-code`, `claude-code-superpowers`, `pi-bridge`; `codex-only` → `codex`, `codex-superpowers`, `pi-codex`. Every baseline pins the profile's implementer model (provider prefix stripped for the CLIs): `claude-opus-5-5` / `gpt-6.1-sol`. Reasoning effort is each CLI's default for its pinned version — cost if wrong: differences partly reflect effort defaults; visible because versions are pinned.
7. **Superpowers wiring.** Claude Code: `--plugin-dir <evalRoot>/tools/superpowers-7.0.0` (loads its skills and SessionStart hook). Codex: Superpowers' `.codex-plugin/plugin.json` declares only `skills` and no hooks, so the equivalent is the skills directory linked at `<runHome>/.agents/skills/superpowers` (the per-run `HOME`). Task 12 confirms Codex lists them before any suite runs — cost if wrong: the contender is plain Codex under another name; the probe catches it.
8. **The factory contender is Phase 4.** Phase 3's acceptance is baselines only, and the factory without the methodology (Phase 4) is not a meaningful contender; it also needs install-state seeding (handshake, guard) in a fresh `FACTORY_HOME`. The contender interface is open (`ContenderId` union, `buildInvocation` switch) so Phase 4 adds `factory` without touching the orchestrator — cost: Phase 4 carries that work.
9. **Test contenders `oracle` and `noop`** (never selectable from a profile, only with `--contenders` and only for public tasks): `oracle` overlays the task's `solution/` into the workspace and prints a canned final message; `noop` changes nothing. They make the whole pipeline (materialize → run → verify → stats → report) testable in CI without models, and validate every public task (oracle passes all checks, noop fails at least one).
10. **Task store.** Public tasks live in the repo at `evals/tasks/<id>/` (`task.json`, `repo/`, `checks/`, `solution/`). Private tasks (owner's real projects, not publishable now that the repo is public) live in `<evalRoot>/tasks/<id>/` with the same layout (`solution/` optional) or a `git` snapshot. Task ids are unique across both roots. Seeding real-project tasks is owner input (see Owner inputs) — cost: the Phase 3 smoke suite is public fixtures only.
11. **Smoke suite content** (public, dependency-free ESM Node projects, checks via `node --test`, pass on Node 22.19/24, Linux/Windows): dev `slugify-unicode` (small, bug), `duration-compound` (small, feature), `cache-ttl-lru` (feature, multi-file); held-out `csv-quoted-fields` (small, bug), `retry-backoff` (feature). `smoke` = the three dev tasks; `full` = all dev tasks; held-out tasks run only with `--heldout`.
12. **Run matrix and order.** `reps` (default 3 for smoke, 5 for full) × tasks × contenders, executed sequentially (one at a time: shared eval logins and quota windows). Within each (task, rep), contender order is a seeded shuffle (mulberry32 over `seed`, `taskId`, `rep`); `seed` is recorded and accepted by `--seed` for an identical order.
13. **Usage per provider, never silently zero.** Streams: Claude Code `--output-format stream-json --verbose` (final `result` event `usage`; `rate_limit_event.rate_limit_info` → quota `known`/`exhausted`), Codex `exec --json` (sum of `turn.completed.usage`; quota `unknown`), Pi `--mode json` (sum of assistant `message_end.message.usage` keyed by `message.provider`: `claude-bridge` → `claude`, `openai-codex` → `codex`; quota `unknown`, Phase 7 adds header capture). A finished run whose stream yields no usage for its expected provider is recorded `usageMissing: true` and excluded from usage statistics, never counted as zero.
14. **Statistics** (A §12.1 [call]): per (profile, contender, tier) pass rate (a run passes iff every check passes) with standard deviation across reps, escaped defects (failing checks per run), usage per provider (median, IQR), wall time (median), errors and timeouts. Paired comparison per task against a *reference* contender (the profile's CLI default: `claude-code` / `codex`): mean per-task pass-rate difference with a seeded bootstrap 95% CI over tasks (2 000 resamples) and median per-task usage ratio per provider. Thresholds in `defaults/eval-thresholds.json` (versioned core data): `passRatePp: 5`, `usageReductionPct: 15`, secondary `escapedDefectsIncrease: 0`, `wallTimeIncreasePct: 25`, `usageIncreasePct: 10`. A comparison is `eligible` for a claim only with suite `full`, reps ≥ 5 and a held-out confirmation; smoke reports carry "regression alarm only — no superiority claim".
15. **Budget stops, never a silent stall.** Optional personal config `eval: { tokenBudget?: { claude?: number; codex?: number }, quotaStopAt?: number /* 0–1, default 0.8 */ }`. Between runs, the orchestrator stops when cumulative tokens for a provider reach its budget, when a Claude `rate_limit_event` reports utilization ≥ `quotaStopAt` or status `rejected`, or when a run fails with `/usage limit|rate limit|quota/i`. The report is written with `incomplete: { reason }`; `factory eval run --resume <id>` continues.
16. **Durable, resumable eval runs.** `evalRunId = <UTC yyyymmddThhmmssZ>-<4 random hex>` (no same-second collision). `<evalRoot>/runs/<evalRunId>/config.json` (selection, seed, reps, pins, factory version and commit) and `results.jsonl` (one record per finished run, appended and fsynced). Resume reads both, skips specs with a record, deletes and re-runs any partial run directory; an unparseable final line is ignored. Run working dirs are deleted after verification unless `--keep`; the contender's stream and stderr are kept (`runs/<id>/<task>/<contender>/rep-<k>/{events.jsonl,stderr.log}`), with the eval root at mode 0700.
17. **No scheduler in Phase 3.** On demand only; the systemd user timer belongs with radar/self-evolution (Phase 8). The `install` suite stays the CI install job of Phase 1; the `memory` suite is Phase 6; the LLM-judge rubric field is in the task schema, scoring with it is Phase 4.
18. **Carry-forward from Phase 2 (0.2.1):** `sessionInterruptedRuns` picks "the latest earlier run of this Pi session" by lexical run id; one-second run ids tie-break on pid. Order by the `run_start` event's `ts` instead (run id only as tie-break).

## Owner inputs (needed only for Task 12, the live acceptance run)

1. Create the three dedicated eval logins of ruling 4 (interactive OAuth; `factory eval setup` prints the exact commands).
2. Approve the quota spend of the acceptance run: 2 profiles × 3 baselines × 3 tasks × 3 reps = 54 agent runs (budget stops of ruling 15 apply).
3. Later (not blocking): real-project tasks for the private store.

## Global Constraints

- Everything in Phase 1–2 Global Constraints still binds (Node ≥ 22.19.0, CI matrix ubuntu/windows × Node 22.19.0/24, exact pins, no `shell: true`, layers, conventional commits, English artifacts, isolated test homes).
- No new npm dependency. `bwrap` is optional at runtime and never needed by CI tests (sandbox tests `skipIf` it is unusable).
- No model calls and no network in tests. Real CLIs (`claude`, `codex`, real Pi with a provider) are never spawned by tests; fake CLIs (node scripts) stand in.
- Secrets (eval logins, token file) are never read by tests, never printed, never written into results, reports, logs or argv.
- Eval artifacts (`<evalRoot>`, runs, private tasks) are created with mode 0700 (files 0600 where they hold secrets).
- Schemas: every new persisted shape is a zod schema in `src/core/eval/` exported to `schemas/*.schema.json` via `scripts/gen-schemas.ts`.

## Review Focus

1. **Withheld-check leakage:** from inside a contender sandbox the real home, the repo's `evals/`, the private task store and other runs are invisible, and the workspace's `.git` holds one commit with no solution. Pinned by Task 6 (sandbox e2e) and Task 7 (single-commit snapshot).
2. **Secret exposure:** the Claude token never appears in argv, results, reports or stderr copies made by the factory. Pinned by Task 9 (fake token: absent from argv and from every file the run writes).
3. **Process teardown on timeout:** a contender that spawns a grandchild ignoring SIGTERM leaves nothing running after its timeout, and the next run starts clean. Pinned by Task 9 (sandboxed on Linux, `killProcessTree` path unsandboxed).
4. **Missing or malformed usage** is flagged, never reported as cheap. Pinned by Task 4 (parsers) and Task 5 (aggregation excludes `usageMissing`).
5. **Interrupted eval resumes without double counting:** half-written last line ignored, partial run dir re-run. Pinned by Task 10.

---

## File structure

```
src/core/eval/task.ts            EvalTask schema, task ids
src/core/eval/records.ts         EvalRunRecord, EvalRunConfig, Usage, QuotaStatus schemas
src/core/eval/thresholds.ts      EvalThresholds schema + loader-free parse
src/core/eval/contenders.ts      ContenderId, ContenderPins schema, baselinesFor(profile), baselineModel(profile)
src/core/eval/matrix.ts          selectTasks, planMatrix, seeded shuffle
src/core/eval/streams.ts         parseClaudeStream, parseCodexStream, parsePiStream
src/core/eval/stats.ts           aggregate, pairedComparison, verdict
src/core/eval/report.ts          EvalReport schema, buildReport, renderMarkdown
src/core/config/schema.ts        (modified) PersonalConfig.eval
src/core/ledger/… / src/adapters/pi/extension/ledger.ts  (modified, Task 1)
src/adapters/eval/paths.ts       evalRoot layout, 0700 dirs
src/adapters/eval/tasks.ts       loadTasks(roots)
src/adapters/eval/sandbox.ts     bwrapUsable, sandboxArgs
src/adapters/eval/workspace.ts   materialize, prepareVerify, runChecks, diffStat
src/adapters/eval/invoke.ts      buildInvocation, probeVersions
src/adapters/eval/run.ts         runContender (spawn, stream to file, timeout, teardown)
src/adapters/eval/orchestrator.ts runEval, resumeEval
src/adapters/eval/setup.ts       evalSetup (dirs, Superpowers clone, bridge install, login status)
src/cli/commands/eval.ts         factory eval setup|tasks|run|report
evals/contenders.json, evals/tasks/<id>/{task.json,repo/,checks/,solution/}
defaults/eval-thresholds.json
schemas/eval-task.schema.json, eval-run-record.schema.json, eval-report.schema.json, eval-thresholds.schema.json, eval-contenders.schema.json
test/core/eval/*.test.ts, test/adapters/eval/*.test.ts, test/fixtures/eval/ (fake CLIs, canned streams), test/e2e/eval.e2e.test.ts
```

---

### Task 1: Interrupted-run selection by start time (carry-forward)

**Files:** Modify `src/adapters/pi/extension/ledger.ts` (`sessionInterruptedRuns`: the `.sort()` + `.at(-1)` that picks the latest earlier run of the Pi session); Test `test/adapters/pi/extension/ledger.test.ts`.

**Interfaces:** unchanged signatures.

- [ ] **Step 1: Failing test:** two earlier runs of the same Pi session whose ids share the second (`20261105T100000Z-900` started at `…:00.100Z`, `20261105T100000Z-1000` started at `…:00.200Z`; lexical order puts `-1000` first) → the selected latest is `20261105T100000Z-1000`; a run whose ledger has no readable `run_start` sorts first (treated as oldest).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** ordering by `run_start.ts` (ISO string compare), run id as tie-break. **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `fix(pi): pick a session's latest interrupted run by start time, not run id`.

### Task 2: Eval schemas and core data

**Files:** Create `src/core/eval/task.ts`, `src/core/eval/records.ts`, `src/core/eval/thresholds.ts`, `src/core/eval/contenders.ts`, `evals/contenders.json`, `defaults/eval-thresholds.json`; Modify `src/core/config/schema.ts` (PersonalConfig `eval`, additive, schema version unchanged), `scripts/gen-schemas.ts`; generate `schemas/eval-*.schema.json`; Test `test/core/eval/schemas.test.ts`.

**Interfaces (Produces):**
- `EvalTask` (zod, strict): `{ schema: 1; id: string /* ^[a-z0-9][a-z0-9-]{0,62}$ */; title: string; tier: "answer"|"small"|"feature"|"project"; split: "dev"|"heldout"; suites: ("smoke"|"full"|"memory")[] /* min 1 */; snapshot: { kind: "dir" } | { kind: "git"; url: string; ref: string /* 40-hex */ }; prompt: string; checks: { name: string; argv: string[] /* min 1 */; timeoutSec: number /* int 1..1800, default 300 */ }[] /* min 1 */; rubric?: string; budget: { wallSec: number /* int 60..7200 */; maxTurns?: number } }`. A `dir` snapshot reads `<taskDir>/repo/`.
- `ProviderId = "claude" | "codex"`; `Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }` (non-negative ints); `QuotaStatus = { state: "known"; utilization: number; window?: string; resetsAt?: string } | { state: "exhausted" } | { state: "unknown" }`.
- `ContenderId = "claude-code" | "claude-code-superpowers" | "pi-bridge" | "codex" | "codex-superpowers" | "pi-codex" | "oracle" | "noop"`; `ProfileName = "claude-codex" | "codex-only"`; `baselinesFor(p): ContenderId[]` (ruling 6 order); `referenceContender(p)` = `claude-code` | `codex`; `expectedProvider(c): ProviderId | null` (null for test contenders); `baselineModel(profile: Profile): string` = implementer model with the `provider/` prefix stripped.
- `ContenderPins` (zod): `{ schema: 1; claude: { version: string }; codex: { version: string }; superpowers: { git: string; tag: string; commit?: string /* 40-hex */ } }` with `evals/contenders.json` = ruling 6 values (`commit` absent until setup records it — Task 11 writes it into `<evalRoot>/tools/superpowers.lock.json`, not the repo file).
- `EvalRunRecord` (zod): `{ v: 1; evalRunId; taskId; contender; profile: ProfileName | null; rep: number; startedAt: string; wallMs: number; exit: "ok"|"error"|"timeout"|"skipped-budget"; exitCode: number | null; checks: { name; pass: boolean; exitCode: number | null; timedOut: boolean; ms: number }[]; pass: boolean; escapedDefects: number; usage: Partial<Record<ProviderId, Usage>>; usageMissing: boolean; quota: Partial<Record<ProviderId, QuotaStatus>>; diffStat: { files: number; insertions: number; deletions: number } | null; errorSummary: string | null /* redacted, ≤ 500 chars */ }`.
- `EvalRunConfig` (zod): `{ v: 1; evalRunId; suite: "smoke"|"full"|"memory"; profile: ProfileName | null; contenders: ContenderId[]; taskIds: string[]; heldout: boolean; reps: number; seed: number; pins: { claude?: string; codex?: string; pi: string; bridge: string; superpowersCommit?: string }; drift: string[]; factory: { version: string; commit: string | null }; taskSnapshots: Record<string, string /* base sha */>; host: { platform: string; bwrap: string | null } }`.
- `EvalThresholds` (zod) + `defaults/eval-thresholds.json` = ruling 14 values (`schema: 1`).
- `PersonalConfig.eval?: { tokenBudget?: { claude?: number; codex?: number }; quotaStopAt?: number /* 0..1 */ }`.

- [ ] **Step 1: Failing tests:** each schema accepts a valid example and rejects: bad task id (`Bad_ID`), empty checks, `timeoutSec: 0`, git ref not 40-hex, unknown key (strict), `quotaStopAt: 1.5`; `baselinesFor("codex-only")` = `["codex","codex-superpowers","pi-codex"]`; `baselineModel` of `profiles/claude-codex.json` = `claude-opus-5-5`; `evals/contenders.json` and `defaults/eval-thresholds.json` parse.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; add the five schemas to `SOURCES` and run `npm run schemas`. **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(eval): add eval task, record, contender and threshold schemas`.

### Task 3: Task selection and run matrix (core)

**Files:** Create `src/core/eval/matrix.ts`; Test `test/core/eval/matrix.test.ts`.

**Interfaces:**
- Consumes: `EvalTask`, `ContenderId` (Task 2).
- Produces: `selectTasks(tasks: EvalTask[], sel: { suite: "smoke"|"full"|"memory"; heldout: boolean; taskIds?: string[] }): EvalTask[]` — tasks whose `suites` include `suite` (`full` also takes every `dev` task regardless of tags), held-out tasks only when `heldout` (and then only held-out tasks), `taskIds` filters further and an unknown id throws; result sorted by id.
- Produces: `RunSpec = { taskId: string; contender: ContenderId; rep: number /* 1-based */ }`; `planMatrix(taskIds: string[], contenders: ContenderId[], reps: number, seed: number): RunSpec[]` — order: rep 1..n, then task (input order), then contenders shuffled by `shuffle(contenders, hash(seed, taskId, rep))`; `mulberry32(seed: number): () => number`, `shuffle<T>(xs, rng)` (Fisher–Yates, non-mutating).

- [ ] **Step 1: Failing tests:** selection rules above (smoke excludes held-out; `--heldout` returns only held-out; unknown id throws `unknown task: x`); `planMatrix(["a","b"], [c1,c2,c3], 2, 42)` has 12 specs, every (task, rep) block is a permutation of the contenders, the same seed gives an identical array, a different seed gives a different order for at least one block (assert on fixed seeds 42 and 43), `mulberry32(1)` first three outputs are pinned constants.
- [ ] **Step 2–4:** FAIL → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(eval): add task selection and seeded run matrix`.

### Task 4: Contender stream parsers (core)

**Files:** Create `src/core/eval/streams.ts`, canned streams `test/fixtures/eval/streams/{claude-ok,claude-ratelimit-rejected,claude-error,codex-ok,codex-failed,pi-bridge-ok,pi-codex-ok,pi-error,truncated}.jsonl`; Test `test/core/eval/streams.test.ts`.

**Interfaces:**
- Consumes: `Usage`, `QuotaStatus`, `ProviderId` (Task 2).
- Produces: `ParsedStream = { usage: Partial<Record<ProviderId, Usage>>; quota: Partial<Record<ProviderId, QuotaStatus>>; finalMessage: string | null; error: string | null; limitHit: ProviderId | null; malformedLines: number }`; `parseClaudeStream(text: string): ParsedStream`, `parseCodexStream(text: string): ParsedStream`, `parsePiStream(text: string): ParsedStream`.
- Mapping (ruling 13): Claude `result` → `usage.claude = { input: input_tokens, output: output_tokens, cacheRead: cache_read_input_tokens, cacheWrite: cache_creation_input_tokens }`, `finalMessage = result`, `is_error`/`subtype !== "success"` → `error`; the last `rate_limit_event.rate_limit_info` → `status: "rejected"` ⇒ `exhausted`, numeric `utilization` ⇒ `known` (with `rateLimitType` as `window`, `resetsAt` ISO from epoch seconds when present). Codex: sum of `turn.completed.usage` (`input_tokens`, `cached_input_tokens` → `cacheRead`, `output_tokens`; `input` excludes cached), last `item.completed` with `item.type === "agent_message"` → `finalMessage`, `turn.failed.error.message` / `error.message` → `error`. Pi: assistant `message_end` usage summed per mapped provider (other providers ignored), last assistant text content → `finalMessage`, `stopReason === "error"` → `error = errorMessage`. All: `limitHit` set when `error` matches `/usage limit|rate limit|quota/i` (or Claude `exhausted`); non-JSON lines and a truncated last line increment `malformedLines` and are skipped.

- [ ] **Step 1: Write the canned streams** from the documented shapes (Claude Code stream-json `system`/`assistant`/`result`/`rate_limit_event`; Codex `thread.started`/`turn.started`/`item.completed`/`turn.completed`/`turn.failed`; Pi json.md `message_end` with `message.provider`, `message.usage`) and **failing tests** pinning exact token sums per fixture, `finalMessage`, `error`, `limitHit`, `quota` states, and `malformedLines` for `truncated.jsonl` (last line cut mid-object).
- [ ] **Step 2–4:** FAIL → implement → PASS. Task 12 replaces or extends these fixtures with real captured streams if a shape differs.
- [ ] **Step 5: Commit** `feat(eval): parse usage, quota and final message from contender streams`.

### Task 5: Statistics, comparisons and reports (core)

**Files:** Create `src/core/eval/stats.ts`, `src/core/eval/report.ts`; Modify `scripts/gen-schemas.ts` (`eval-report.schema.json`); Test `test/core/eval/stats.test.ts`, `test/core/eval/report.test.ts`.

**Interfaces:**
- Consumes: `EvalRunRecord`, `EvalRunConfig`, `EvalThresholds`, `EvalTask` (tier lookup), `referenceContender` (Tasks 2–3).
- Produces: `aggregate(records, tiers: Record<taskId, Tier>): ContenderSummary[]` with `ContenderSummary = { contender; tier; runs; passRate; passRateSd; escapedDefectsMean; usage: Partial<Record<ProviderId, { median: number; iqr: [number, number]; n: number }>> /* total = input+output+cacheRead+cacheWrite per run; usageMissing runs excluded */; usageMissing: number; wallMsMedian; errors; timeouts }`; `skipped-budget` records are excluded from everything except a count.
- Produces: `pairedComparison(records, candidate, reference, seed): Comparison = { candidate; reference; tasks: number; passRateDiffPp: number; ci95: [number, number]; usageRatio: Partial<Record<ProviderId, number>> /* median per-task ratio candidate/reference */; wallRatio: number }` — only tasks where both have ≥ 1 counted run; bootstrap over tasks, 2 000 resamples, `mulberry32(seed)`.
- Produces: `verdict(c: Comparison, t: EvalThresholds, ctx: { suite; reps; heldoutConfirmed: boolean }): { eligible: boolean; improved: boolean; regressions: string[]; note: string }` — `eligible` iff suite `full`, reps ≥ 5, `heldoutConfirmed`; smoke `note` = `regression alarm only — no superiority claim`.
- Produces: `EvalReport` (zod) `{ v: 1; config: EvalRunConfig; incomplete: { reason: string } | null; summaries: ContenderSummary[]; comparisons: (Comparison & { verdict })[]; perTask: { taskId; contender; runs; passes }[]; generatedAt }`; `buildReport(config, records, tasks, thresholds, opts: { incomplete?; now: Date }): EvalReport`; `renderMarkdown(r: EvalReport): string` (header with pins, seed, host, drift; one table per tier; comparisons vs the reference; per-task table; the smoke banner; `usage missing` and `unknown` quota stated in words, never as 0).

- [ ] **Step 1: Failing tests:** hand-computed fixture (2 tasks × 2 contenders × 3 reps) → exact `passRate`, `passRateSd`, medians, IQR; a `usageMissing` run is excluded from usage but counted in `runs`; paired diff on a fixture where candidate wins task A by 2/3 and loses B by 1/3 → `passRateDiffPp = 16.67` (2 decimals), CI deterministic for seed 7 (pinned); `verdict` on smoke → not eligible with the banner note; on full/reps 5/heldout → `improved` true at +6 pp with no regression, false at +4 pp; a 30% wall increase lists `wallTimeIncreasePct`. Markdown snapshot test on a small report (inline snapshot).
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test` PASS.
- [ ] **Step 5: Commit** `feat(eval): add paired statistics, verdicts and reports`.

### Task 6: Sandbox adapter (bubblewrap)

**Files:** Create `src/adapters/eval/sandbox.ts`; Test `test/adapters/eval/sandbox.test.ts`.

**Interfaces:**
- Produces: `SandboxSpec = { hide: string[]; roBinds: string[]; rwBinds: string[]; cwd: string; network: boolean }`; `sandboxArgs(spec: SandboxSpec, command: string, args: string[]): string[]` — exactly the ruling 1 order: base mounts, `--tmpfs` per hidden root (deduplicated, parents before children), `--ro-bind p p` per roBind, `--bind p p` per rwBind, `--chdir`, namespace flags, `--unshare-net` iff `!network`, `--`, command, args; throws if any rw/ro bind is not absolute.
- Produces: `bwrapUsable(): Promise<{ ok: true; version: string } | { ok: false; reason: string }>` — `bwrap --version` and a probe `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid --die-with-parent true`, each bounded to 5 s; `ok: false` on any non-Linux platform without spawning.

- [ ] **Step 1: Failing tests:** `sandboxArgs` exact array for a spec with two hidden roots, one ro and one rw bind, network off; relative bind throws. Linux-only e2e (`describe.skipIf(!usable)`): with a temp `fakeHome` containing `secret.txt` and a `fakeHome/ws` rw bind, a sandboxed `sh -c` cannot read `fakeHome/secret.txt` (hidden) but can write `fakeHome/ws/out.txt` (visible after exit); with `network: false` a `node -e` that connects to `127.0.0.1:<port of a server started by the test>` fails; `bwrapUsable` on win32 returns `ok: false` without spawning (inject platform).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(eval): add bubblewrap sandbox for contenders and checks`.

### Task 7: Task loading, workspaces and checks

**Files:** Create `src/adapters/eval/paths.ts`, `src/adapters/eval/tasks.ts`, `src/adapters/eval/workspace.ts`; Test `test/adapters/eval/tasks.test.ts`, `test/adapters/eval/workspace.test.ts`, fixtures `test/fixtures/eval/tasks/{good,bad-schema,dup}/…`.

**Interfaces:**
- Consumes: `EvalTask` (Task 2), `sandboxArgs`/`SandboxSpec` (Task 6), `git` from `src/adapters/vcs/git.ts`, `runBounded`/`killProcessTree` from `src/adapters/platform/process.ts`.
- Produces: `evalPaths(env): { root; runs; tasks; auth: { codex; pi }; secrets: { claudeToken }; tools }` under `<FACTORY_HOME>/eval`; `ensurePrivateDir(p)` (mkdir -p, chmod 0700 on POSIX).
- Produces: `LoadedTask = { task: EvalTask; dir: string; source: "public" | "private"; hasSolution: boolean }`; `loadTasks(roots: { dir: string; source }[]): LoadedTask[]` — each `<root>/<id>/task.json` parsed with `EvalTask`, directory name must equal `id`, duplicate id across roots throws naming both dirs, a `dir` snapshot without `repo/` throws, a missing root is skipped.
- Produces: `materialize(t: LoadedTask, dest: string): Promise<{ baseSha: string }>` — `dir`: copy `repo/` → `dest`, `git init -q -b main`, `git add -A`, commit with `GIT_AUTHOR_NAME/EMAIL/DATE` and committer equivalents fixed to `factory-eval`, `eval@factory.invalid`, `2026-01-01T00:00:00Z`, `-c core.autocrlf=false -c commit.gpgsign=false` (same content → same SHA on every OS); `git`: `git clone --no-hardlinks --quiet <url> dest`, `git checkout -q -B main <ref>`; both disable `maintenance.auto`/`gc.auto` in the repo config.
- Produces: `prepareVerify(ws: string, t: LoadedTask, verifyDir: string, finalMessage: string | null): Promise<void>` (copy ws recursively incl. `.git`, overlay `checks/` at matching relative paths, write `.eval/final-message.txt` when non-null); `diffStat(verifyDir, baseSha): Promise<{ files; insertions; deletions }>` computed before the overlay with a scratch index (`GIT_INDEX_FILE`) over `git add -A` and `git diff --cached --numstat <baseSha>`, excluding `.eval/`; `runChecks(t: LoadedTask, verifyDir, sandbox: SandboxSpec | null): Promise<EvalRunRecord["checks"]>` — each check's `argv` spawned without a shell, cwd `verifyDir`, timeout `timeoutSec`, inside `sandboxArgs({ …, network: false })` when a sandbox is given.

- [ ] **Step 1: Failing tests:** loader accepts `good`, rejects `bad-schema` (message names the file), rejects `dup` across two roots; `materialize` twice on the same dir snapshot yields the same `baseSha` and `git log --oneline | wc -l` = 1; `prepareVerify` overlays a hidden test file and writes the final message; `diffStat` counts one modified and one new file and ignores `.eval/`; `runChecks` reports pass/fail/timeout (a check `node -e "setTimeout(()=>{},60000)"` with `timeoutSec: 1` → `timedOut: true`, no orphan).
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test` PASS (both OSes in CI).
- [ ] **Step 5: Commit** `feat(eval): load tasks, materialize workspaces and run withheld checks`.

### Task 8: Public smoke and held-out tasks

**Files:** Create `evals/tasks/{slugify-unicode,duration-compound,cache-ttl-lru,csv-quoted-fields,retry-backoff}/{task.json,repo/…,checks/…,solution/…}`, `evals/README.md` (layout, how to add a task, the private store); Test `test/e2e/eval-tasks.e2e.test.ts`.

**Interfaces:**
- Consumes: `loadTasks`, `materialize`, `prepareVerify`, `runChecks` (Task 7).
- Content (ruling 11): each `repo/` is a dependency-free ESM package (`"type": "module"`, a visible `test/*.test.js` that passes on the snapshot, `npm test` = `node --test`), the prompt reads like a user's issue (symptom, expected behavior, no file hints beyond what a user would know), `checks/` adds `test/*.hidden.test.js` files, each check `argv` is `["node","--test"]` with `timeoutSec: 120`, `budget.wallSec` 900 (small) / 1800 (feature). `solution/` overlays the minimal correct change.

- [ ] **Step 1: Write the e2e test** (fails: no tasks yet): for every public task — schema valid, `materialize` + `prepareVerify` + `runChecks` on the untouched snapshot → at least one check fails; same after overlaying `solution/` into the workspace → all checks pass; the hidden test files do not exist in `repo/`; `selectTasks(…, { suite: "smoke" })` = the three dev ids.
- [ ] **Step 2: Run** → FAIL. **Step 3: Write the five tasks.** **Step 4: Run** `npx vitest run test/e2e/eval-tasks.e2e.test.ts` → PASS on Node 22.19 and 24 locally.
- [ ] **Step 5: Commit** `feat(eval): add public smoke and held-out tasks`.

### Task 9: Contender invocations and supervised runs

**Files:** Create `src/adapters/eval/invoke.ts`, `src/adapters/eval/run.ts`, fake CLIs `test/fixtures/eval/fake-cli/{claude,codex,pi}.mjs` (print a canned stream from `FAKE_STREAM`, optionally write `FAKE_WRITE` into the cwd, optionally spawn a TERM-ignoring grandchild with `FAKE_HANG=1`); Test `test/adapters/eval/invoke.test.ts`, `test/adapters/eval/run.test.ts`.

**Interfaces:**
- Consumes: `ContenderId`, `ContenderPins`, `baselineModel` (Task 2); `SandboxSpec`/`sandboxArgs` (Task 6); `evalPaths` (Task 7); `release.json` Pi/bridge pins.
- Produces: `InvocationContext = { contender; prompt; model: string | null; workspace; runHome; evalPaths; tools: { claude?: string; codex?: string; piCli: string; node: string; bridgeDir?: string; superpowersDir?: string }; secrets: { claudeToken?: string }; taskDir: string; maxTurns?: number }`; `Invocation = { command: string; args: string[]; env: Record<string, string>; roBinds: string[]; rwBinds: string[]; stream: "claude" | "codex" | "pi" | "none"; prepare?: () => Promise<void> }`; `buildInvocation(ctx): Invocation` with exactly:
  - `claude-code`: `<claude> -p <prompt> --output-format stream-json --verbose --model <model> --permission-mode bypassPermissions --no-session-persistence [--max-turns N]`; env `HOME=<runHome>`, `CLAUDE_CONFIG_DIR=<runHome>/.claude`, `CLAUDE_CODE_OAUTH_TOKEN`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `PATH`, `LANG=C.UTF-8`; `claude-code-superpowers`: plus `--plugin-dir <superpowersDir>` (ro bind).
  - `codex`: `<codex> exec --json --ephemeral --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox -m <model> -C <workspace> -- <prompt>`; env `HOME`, `CODEX_HOME=<auth.codex>` (rw), `PATH`, `LANG`; `codex-superpowers`: `prepare` symlinks `<runHome>/.agents/skills/superpowers` → `<superpowersDir>/skills` (ro bind).
  - `pi-bridge` / `pi-codex`: `<node> <piCli> --mode json --no-session --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes [-e <bridgeDir>] --model claude-bridge/<model> | openai-codex/<model> -- <prompt>`; env `HOME`, `PI_CODING_AGENT_DIR=<auth.pi>` (rw), and for the bridge `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`.
  - `oracle`: `<node> -e <script>` copying `<taskDir>/solution` into the cwd and printing `{"type":"final","text":"oracle"}`; `noop`: prints the same with `noop`; `stream: "none"`.
- Produces: `probeVersions(tools): Promise<{ claude?: string; codex?: string; pi: string }>` (`--version`, first semver match, 10 s bound) and `checkPins(probed, pins, release): string[]` (drift list).
- Produces: `runContender(inv, sandbox: SandboxSpec | null, opts: { timeoutMs: number; eventsFile: string; stderrFile: string }): Promise<{ exit: "ok" | "error" | "timeout"; exitCode: number | null; wallMs: number }>` — spawns `bwrap sandboxArgs(…)` (or the command directly when `sandbox` is null) with `env` exactly `inv.env` (no inheritance), stdout/stderr to the files via file descriptors, on timeout kills the whole tree (`killProcessTree`; under bwrap, `--unshare-pid --die-with-parent` takes the namespace down with it).

- [ ] **Step 1: Failing tests:** exact argv/env per contender (snapshot of `buildInvocation` with fixed paths); a fake token `sk-ant-oat01-FAKE…` never appears in `args` of any invocation; `checkPins` reports `claude 2.1.317 ≠ 2.1.318`; `runContender` with the fake claude CLI writes the canned stream to `eventsFile` and the file `FAKE_WRITE` into the workspace; with `FAKE_HANG=1` and `timeoutMs: 1000` → `exit: "timeout"`, and within 5 s no process whose cmdline contains the test's unique marker survives (Linux sandboxed when `bwrapUsable`, unsandboxed on every OS); after a run, grep every file under the run dir for the fake token → none.
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test` PASS.
- [ ] **Step 5: Commit** `feat(eval): build contender invocations and supervise sandboxed runs`.

### Task 10: Orchestrator (run, resume, budget stops, report)

**Files:** Create `src/adapters/eval/orchestrator.ts`; Test `test/e2e/eval.e2e.test.ts`.

**Interfaces:**
- Consumes: Tasks 2–9 (`selectTasks`, `planMatrix`, parsers, `buildReport`, `renderMarkdown`, `loadTasks`, `materialize`, `prepareVerify`, `diffStat`, `runChecks`, `buildInvocation`, `runContender`, `bwrapUsable`, `checkPins`).
- Produces: `EvalOptions = { suite; profile: ProfileName | null; contenders?: ContenderId[]; reps: number; seed?: number; heldout: boolean; taskIds?: string[]; keep: boolean; allowDrift: boolean; budget: PersonalConfig["eval"] }`; `runEval(opts, deps: EvalDeps): Promise<{ evalRunId: string; reportPath: string; incomplete: { reason: string } | null }>`; `resumeEval(evalRunId, deps)`; `EvalDeps = { env; root /* package root */; now(): Date; randomHex(n): string; tools; secrets: () => { claudeToken?: string }; log(line: string): void; signal?: AbortSignal }`.
- Behavior: contenders = `opts.contenders ?? baselinesFor(profile)`; `oracle`/`noop` refuse private tasks; model-calling contenders require `bwrapUsable` and refuse with `model-calling evals need bubblewrap (Linux); see docs` otherwise; per spec: dirs `runs/<id>/<task>/<contender>/rep-<k>/{ws,home,verify}`, `materialize`, `prepare`, `runContender` (timeout = `budget.wallSec`), parse the stream (by `inv.stream`; `none` → the printed `final` text), `usageMissing = exit === "ok" && expectedProvider && !usage[expectedProvider]`, `prepareVerify` + `diffStat` + `runChecks` (sandboxed when usable), append the record (fsync), delete `ws/home/verify` unless `keep`; between specs apply ruling 15 stops; `signal` abort stops after the current spec with `incomplete: { reason: "interrupted" }`; finally write `report.json` (validated by `EvalReport`) and `report.md`. Logs one line per spec (`[k/N] task contender rep → pass|fail (12.3 s)`), never env or argv.

- [ ] **Step 1: Failing e2e tests (oracle/noop over the public smoke tasks, no sandbox needed):** a run with `--contenders oracle,noop --reps 2 --seed 1` → `results.jsonl` has 12 records, oracle pass rate 1, noop 0, `report.json` validates, `report.md` contains the smoke banner; budget: a record stream whose claude usage exceeds `tokenBudget.claude` (inject a fake claude CLI with the canned stream, unsandboxed via a test seam `deps.forceNoSandbox`) stops with `incomplete.reason` naming the budget; resume: kill after 3 records (abort signal) and truncate the last line mid-JSON → `resumeEval` completes to 12 records with no duplicates and the partial run dir re-created; a model contender with `bwrapUsable` false → refused before any spec runs.
- [ ] **Step 2–4:** FAIL → implement → PASS (both OSes).
- [ ] **Step 5: Commit** `feat(eval): orchestrate eval runs with resume, budget stops and reports`.

### Task 11: `factory eval` CLI, setup and docs

**Files:** Create `src/adapters/eval/setup.ts`, `src/cli/commands/eval.ts`; Modify `src/cli/main.ts` (route `eval`, drop it from `LATER_PHASE`, usage text), `README.md` (Evaluation section: what runs where, the sandbox, eval logins, budget, the smoke banner), `CHANGELOG.md` (Unreleased); Test `test/cli/eval.test.ts`.

**Interfaces:**
- Consumes: `runEval`, `resumeEval` (Task 10), `loadTasks`, `selectTasks`, `evalPaths`, PersonalConfig loading (Phase 1).
- Produces: commands:
  - `factory eval setup [--json]` — creates `<evalRoot>` dirs (0700); clones Superpowers at the pinned tag into `tools/superpowers-<version>` and records its commit in `tools/superpowers.lock.json` (refuses if an existing lock disagrees); installs pi-claude-bridge at the `release.json` pin into `tools/pi-claude-bridge-<version>` (`npm install --ignore-scripts --no-audit --no-fund --prefix`); reports each contender's readiness: binary + version vs pin, `bwrapUsable`, Codex login (`codex login status` with `CODEX_HOME=<auth.codex>`, exit code only), Pi login (`pi auth check --provider openai-codex --no-refresh --json`, status field only), Claude token (file exists, mode 0600 — never read here); prints the exact login commands for anything missing (`CODEX_HOME=… codex login --device-auth`, `PI_CODING_AGENT_DIR=… pi` then `/login`, `claude setup-token` and where to save its output with `umask 077`).
  - `factory eval tasks [--suite <s>] [--heldout]` — lists id, tier, split, source; validates every task (exit 1 on any invalid).
  - `factory eval run --suite <smoke|full> --profile <claude-codex|codex-only> [--contenders a,b] [--reps N] [--seed S] [--heldout] [--tasks a,b] [--keep] [--allow-drift]`, `factory eval run --resume <id>`, `factory eval report <id> [--json]` (prints `report.md` or `report.json`; regenerates from `results.jsonl` when missing).
  - Exit codes: 0 complete, 3 incomplete (budget/interrupt), 1 error, 2 usage. SIGINT → abort signal → incomplete report.

- [ ] **Step 1: Failing tests** (CLI via `main()` with isolated `FACTORY_HOME`, fake tools and network disabled): `eval tasks --suite smoke` lists the three dev ids; `eval run --suite smoke --contenders oracle --reps 1` exits 0 and prints the report path; `--profile` missing without `--contenders` → exit 2; `eval setup --json` with fake `codex`/`pi` on PATH (no network: the clone and npm install are behind seams and stubbed) reports `claudeToken: "missing"` and never opens the token path for reading (spy on fs); `eval report <id>` prints the Markdown.
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test && npm run test:e2e` PASS.
- [ ] **Step 5: Commit** `feat(cli): add factory eval setup, tasks, run and report`.

### Task 12: Live acceptance — baseline smoke report (owner-gated)

Runs on the owner's server only, after the owner inputs above. Not a code task; the controller runs it.

- [ ] **Step 1:** `factory eval setup` → all tools pinned, `bwrap` usable; owner completes the three eval logins.
- [ ] **Step 2: Probe each contender with one tiny prompt** (`--tasks slugify-unicode --reps 1` per contender is the cheapest real probe): stream parsed with usage for its provider (not `usageMissing`), Codex lists the Superpowers skills (Codex+Superpowers final message or its session shows a Superpowers skill was available), Claude+Superpowers shows the plugin's SessionStart injection in its stream. Fix any wiring difference as a follow-up commit with a test and a ledger ruling; refresh Task 4 fixtures from the captured streams (redacted).
- [ ] **Step 3:** `factory eval run --suite smoke --profile claude-codex --reps 3` and `--profile codex-only --reps 3` (budget stops on).
- [ ] **Step 4: Reproducibility check:** `factory eval report <id> --json` regenerated from `results.jsonl` equals the stored report except `generatedAt`; `config.json` of both runs records pins, seed and snapshot SHAs.
- [ ] **Step 5:** Commit both reports (Markdown + JSON, no secrets, no stderr logs) under `docs/evals/2026-11-XX-phase3-smoke-<profile>.{md,json}` with `docs(eval): add phase 3 baseline smoke reports`.
