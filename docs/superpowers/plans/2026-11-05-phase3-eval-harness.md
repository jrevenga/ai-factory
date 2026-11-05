# Phase 3 — Evaluation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible, model-agnostic evaluation harness: a versioned task format with withheld checks that the agent can never reach on disk, controlled per-run state, a dev/held-out split with linked confirmation runs, runners for every same-provider baseline of both profiles, per-provider usage, paired statistics with pre-registered thresholds, and Markdown + JSON reports, driven by `factory eval`.

**Architecture:** Pure logic in `src/core/eval/` (schemas, task selection and run matrix, stream parsers, statistics and verdicts, report rendering). Effects in `src/adapters/eval/` (task loading and hashing, controller-owned repositories, bubblewrap sandbox, auth vault, contender invocation and process supervision, check execution, the orchestrator with resume, budget stops and scripted gate replies). `src/cli/commands/eval.ts` composes them behind `factory eval setup|tasks|run|report`. Every contender runs inside a bubblewrap sandbox that hides the owner's home directory (the factory repo, withheld checks, solutions, the private task store, the auth vault and personal logins) and exposes only the run's workspace and the run's fresh home.

**Tech Stack:** as Phase 2. No new npm dependency. bubblewrap (`bwrap`, a system tool) is required only for model-calling contenders and is probed at runtime.

**Spec:** `docs/superpowers/specs/2026-10-31-ai-factory-design.md` (A) §3, §12.1, §14 (`EvalRunner`), §15 row "3. Evaluation harness"; `docs/superpowers/specs/2026-10-31-factory-methodology-design.md` (M) §18 (first experiments need this harness). Builds on Phases 1–2 (v0.2.0, rulings R1–R68 in the Phase 1/2 ledgers).

**Acceptance (A §15):** reproducible baseline report for all baselines on the smoke suite, both profiles.

**Plan review:** Codex (gpt-6.1-sol, high) on 4362ffd: REVISE (1 C, 13 I, 2 M); every finding is folded into the rulings and tasks below (C1 → ruling 3, I1 → 21, I2 → 3, I3 → 5, I4 → 4, I5 → 20, I6/I7 → 22, I8 → 16, I9 → 23, I10/I11 → 14, I12 → 16, I13 → 19, M1 → Task 7, M2 → Task 2).

## Builder rulings taken while planning

`ruling — why — cost if wrong`. CLI facts verified on 2026-11-05 on the owner's server: Claude Code 2.1.318 (`--bare` ignores OAuth, so it is not used; `--resume <id>`), codex-cli 0.166.0 (`exec --json --ephemeral --ignore-user-config --ignore-rules`, `exec resume <id> <prompt>`), Pi 1.4.0 (project dependency; `--mode json --no-extensions -e --no-skills --no-prompt-templates --no-context-files --no-themes --offline --session-dir --continue`), bubblewrap 0.9.0 (unprivileged; `--tmpfs $HOME` and `--unshare-net` work), Superpowers 7.0.0.

1. **Sandbox = bubblewrap; model-calling contenders fail closed without it.** `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs <realHome> [--tmpfs <each extra hidden root>] [--ro-bind <tool dir>]… [--bind <rw dir>]… --chdir <workspace> --unshare-pid --unshare-ipc --die-with-parent --new-session [--unshare-net]` → command. The tmpfs over the real home hides the factory repo, `evals/` (checks and solutions), the private task store, the auth vault, other runs and the owner's personal logins (`~/.claude`, `~/.codex`, `~/.pi`, `~/.ssh`). Hidden roots outside the home (task roots, the eval root when `FACTORY_HOME` is elsewhere) get their own tmpfs. Tool install dirs under the home are re-exposed read-only (realpath of each binary's install dir); only the run's workspace and fresh home are bound read-write. Model-calling evals run only on the owner's Linux server (A §12.1 [owner]); without a working `bwrap` they are refused with a clear message. Test contenders (ruling 9) run unsandboxed there, so CI on Windows still exercises the orchestrator — cost if wrong: a contender needs a path we did not expose (fails loudly in the live probe, Task 13).
2. **Agents run in each CLI's non-interactive full-permission mode, inside the sandbox.** Claude Code `--permission-mode bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox` (documented for externally sandboxed environments; nested bwrap is not relied on), plain Pi (no approvals). Same footing for every baseline; the sandbox is the boundary — cost if wrong: a CLI default mode would have scored differently; recorded in the manifest.
3. **The agent owns its workspace, including `.git`; the controller never runs git on it** (plan review C1: a repo-local `filter.*.clean` selected by `.gitattributes` runs during `git add`). For each run the controller builds a pristine `base/` repository it owns and never mounts, then `ws/` as a copy of it for the agent. After the agent's process tree is gone, `verify/` is a controller clone of `base/` whose worktree is replaced by the files of `ws/` **excluding the top-level `.git`** (symlinks copied as symlinks, never followed; special files skipped). All controller git commands run with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<empty file>`, `-c core.hooksPath=<empty dir> -c core.fsmonitor=false -c core.attributesFile=<empty file>`; filters, textconv and diff drivers exist only in config, so a `.gitattributes` from the agent references nothing. `diffStat` is computed in `verify/` before the withheld `checks/` are overlaid; then checks run there in a sandbox with `--unshare-net`. Snapshots (both kinds) become one fresh deterministic commit with no history (plan review I2): a `dir` snapshot copies `repo/` excluding any `.git`; a `git` snapshot is fetched into a temporary bare clone, its tree at `ref` checked out into `base/`, and the bare clone deleted — cost: none.
4. **Auth vault: dedicated eval logins, never mounted, never the owner's personal ones** (plan review I4). Personal logins are hidden and never copied (refresh-token rotation in a copy would break them). `<evalRoot> = <FACTORY_HOME>/eval` (0700) holds `vault/codex/auth.json` and `vault/pi/auth.json` (the owner logs in once with `CODEX_HOME=<evalRoot>/vault/codex codex login --device-auth` and `PI_CODING_AGENT_DIR=<evalRoot>/vault/pi pi` → `/login`) and `vault/claude-oauth-token` (0600, output of `claude setup-token`). Per run, the controller creates fresh `<runHome>/.codex` (`CODEX_HOME`) and `<runHome>/.pi-agent` (`PI_CODING_AGENT_DIR`) containing only a 0600 copy of the matching `auth.json`; nothing else from the vault enters the sandbox. After the run (every exit path), a changed copy is written back atomically only if it parses as a JSON object of the expected shape (Codex: has a `tokens` object; Pi: every value is an object with `type: "oauth"`, so no `!command` key can be planted); otherwise the vault is untouched and the record says `authWriteBack: "rejected"`. The Claude token is read from the vault file by the controller and passed as `CLAUDE_CODE_OAUTH_TOKEN` with a fresh `CLAUDE_CONFIG_DIR`. `factory eval setup` reports presence and status only (`codex login status` exit code, `pi auth check --provider openai-codex --no-refresh --json` status field, token file existence and mode) — cost if wrong: a CLI rejects the copied login (seen in Task 13 before any suite spends quota).
5. **Secrets never in argv, logs, results or reports** (plan review I3). bwrap is spawned with an explicit minimal environment (no inheritance of the parent's env, no `--setenv`); secrets are env values, never arguments (`/proc/<pid>/cmdline` is readable). Contender stdout and stderr pass through `LineRedactor` (`src/core/policy/redact.ts`) plus literal replacement of every known secret value before reaching `events-<k>.jsonl` / `stderr-<k>.log`. The token is reachable by the agent inside the sandbox, as any login is for any agent — documented residual risk.
6. **Contenders and pins.** `evals/contenders.json` (core data, versioned) pins `claude` 2.1.318, `codex` 0.166.0, Superpowers 7.0.0 (git URL `https://github.com/obra/superpowers.git`, tag `v7.0.0`; its commit is recorded by `factory eval setup` in `tools/superpowers.lock.json` on first clone and verified after), and takes Pi and pi-claude-bridge from `release.json`. A version mismatch refuses the run unless `--allow-drift`, which is recorded. Baselines per profile (A §12.1): `claude-codex` → `claude-code`, `claude-code-superpowers`, `pi-bridge`; `codex-only` → `codex`, `codex-superpowers`, `pi-codex`. Every baseline pins the profile's implementer model (provider prefix stripped for the CLIs): `claude-opus-5-5` / `gpt-6.1-sol`. Reasoning effort is each CLI's default for its pinned version — cost if wrong: differences partly reflect effort defaults; visible because versions are pinned.
7. **Superpowers wiring.** Claude Code: `--plugin-dir <evalRoot>/tools/superpowers-7.0.0` (its skills and SessionStart hook). Codex: Superpowers' `.codex-plugin/plugin.json` declares only `skills` and no hooks, so the equivalent is the skills directory linked at `<runHome>/.agents/skills/superpowers` (the per-run `HOME`). Task 13 confirms both load before any suite runs — cost if wrong: the contender is the plain CLI under another name; the probe catches it.
8. **The factory contender is Phase 4.** Phase 3's acceptance is baselines only; the factory without the methodology is not a meaningful contender and needs install-state seeding (handshake, guard) in a fresh `FACTORY_HOME`. `ContenderId` and `buildInvocation` are open for Phase 4 to add `factory` without touching the orchestrator — cost: Phase 4 carries that work.
9. **Test contenders `oracle` and `noop`** (never selectable from a profile, only with `--contenders`, only on public tasks): `oracle` copies the task's `solution/` into the workspace and prints a canned final message; `noop` changes nothing. They exercise the whole pipeline in CI without models and validate every public task (oracle passes all checks, noop fails at least one).
10. **Task store.** Public tasks: `evals/tasks/<id>/` in the repo (`task.json`, `repo/`, `checks/`, `solution/`). Private tasks (owner's real projects, not publishable): `<evalRoot>/tasks/<id>/`, same layout (`solution/` optional) or a `git` snapshot. Ids unique across both roots. Seeding real-project tasks is owner input — cost: the Phase 3 smoke suite is public fixtures only (see ruling 21).
11. **Smoke suite content** (public, dependency-free ESM Node projects, checks via `node --test`, pass on Node 22.19/24, Linux/Windows): dev `slugify-unicode` (small, bug), `duration-compound` (small, feature), `cache-ttl-lru` (feature, multi-file); held-out `csv-quoted-fields` (small, bug), `retry-backoff` (feature). `smoke` = the three dev tasks; `full` = all dev tasks; held-out tasks run only in a confirmation run (ruling 23).
12. **Run matrix and order.** `reps` (default 3 for smoke, 5 for full) × tasks × contenders, sequential (shared eval logins and quota windows). Within each (task, rep) contender order is a seeded shuffle (mulberry32 over `seed`, `taskId`, `rep`); `seed` is recorded and accepted by `--seed`.
13. **Usage per provider, never silently zero.** Claude Code `--output-format stream-json --verbose` (final `result.usage`; `system/init` and `result` carry `session_id`; last `rate_limit_event.rate_limit_info` → quota `known`/`exhausted`), Codex `exec --json` (sum of `turn.completed.usage`; `thread.started.thread_id` is the session; quota `unknown`), Pi `--mode json` (sum of assistant `message_end.message.usage` keyed by `message.provider`: `claude-bridge` → `claude`, `openai-codex` → `codex`; quota `unknown`, Phase 7 adds header capture). Usage is summed over every turn of a run (ruling 19). A finished run without usage for its expected provider is `usageMissing: true` and excluded from usage statistics, never counted as zero.
14. **Statistics and verdicts** (A §12.1 [call]; plan review I10, I11). Per (contender, tier): pass rate (a run passes iff every check passes; `error`/`timeout` runs count as failures and are also reported separately; `skipped-budget` is excluded and counted), its standard deviation across reps, escaped defects (failing checks per run), usage per provider (median, IQR), wall time (median). Paired comparison per task against the *reference* contender (`claude-code` / `codex`): mean per-task pass-rate difference (pp) with a seeded bootstrap 95% CI over tasks (2 000 resamples), mean per-task escaped-defects difference, median per-task usage ratio per provider, median per-task wall ratio. Thresholds in `defaults/eval-thresholds.json` (versioned): `passRatePp: 5`, `usageReductionPct: 15`, secondary `escapedDefectsIncrease: 0`, `wallTimeIncreasePct: 25`, `usageIncreasePct: 10`. Verdict: *pass-rate branch* improved iff `passRateDiffPp > passRatePp`; *usage branch* improved iff `passRateDiffPp >= 0` and every provider the reference used has `usageRatio <= 1 - usageReductionPct/100`; secondary regressions (either branch): `escapedDefectsDiff > escapedDefectsIncrease`, `wallRatio > 1 + wallTimeIncreasePct/100`, and on the pass-rate branch any `usageRatio > 1 + usageIncreasePct/100`; `improved` requires no regression. `eligible` iff suite `full`, the run is complete, every task of the manifest has ≥ 5 counted runs for both contenders, and a linked held-out run confirms (ruling 23). Smoke reports say "regression alarm only — no superiority claim".
15. **Budget stops, never a silent stall.** Optional personal config `eval: { tokenBudget?: { claude?: number; codex?: number }, quotaStopAt?: number /* 0–1, default 0.8 */ }`. Between runs, the orchestrator stops when cumulative tokens for a provider reach its budget, when a Claude `rate_limit_event` reports utilization ≥ `quotaStopAt` or status `rejected`, or when a run's error matches `/usage limit|rate limit|quota/i`. The report is written with `incomplete: { reason }`; `factory eval run --resume <id>` continues.
16. **Immutable manifest, durable records, resume** (plan review I8, I12). `evalRunId = <UTC yyyymmddThhmmssZ>-<4 random hex>`. `<evalRoot>/runs/<id>/manifest.json` is written once at start: selection, seed, reps, pins and drift, factory version and commit, host, thresholds snapshot, per contender `{ id, model, provider, argvTemplate /* secrets as "<secret>" */, envKeys }`, per task `{ id, tier, split, source, exposure, snapshotSha, taskSha256, checksSha256, solutionSha256 | null }`, gate reply policy, and `confirms` (ruling 23); frozen copies of each `task.json` go to `runs/<id>/tasks/<taskId>.json`. `results.jsonl` gets one record per finished run, appended and fsynced; before any append the torn tail (an unterminated final line) is dropped and the file fsynced, as `src/adapters/pi/extension/ledger.ts` `dropTornTail` does. Resume recomputes pins, thresholds and task hashes and refuses on any difference (`changed since the run started: …`), skips specs with a record, deletes and re-runs a partial run directory. `factory eval report` regenerates from the manifest, frozen tasks and records only. Run working dirs are deleted after verification unless `--keep`; redacted streams stay (`runs/<id>/<task>/<contender>/rep-<k>/{events-<turn>.jsonl,stderr-<turn>.log}`).
17. **Deferred by phase.** On-demand only (the systemd timer belongs to Phase 8). The `install` suite is Phase 1's CI install job; the `memory` suite is Phase 6; LLM-judge scoring of `rubric` is Phase 4; the factory contender is Phase 4 (ruling 8).
18. **Carry-forward from Phase 2 (0.2.1):** `sessionInterruptedRuns` picks "the latest earlier run of this Pi session" by lexical run id; one-second run ids tie-break on pid. Order by the `run_start` event's `ts` instead (run id only as tie-break).
19. **Scripted gate policy and the remaining metrics** (A §12.1 "human gates answered by a scripted policy; count of gates hit"; plan review I13). A run is a conversation of up to `1 + maxContinuations` turns. After each turn, if the final assistant message's last non-empty line ends with `?` (the agent is waiting for a human, e.g. a Superpowers brainstorming question), the orchestrator resumes the same session with the task's scripted reply (`gate.reply`, default `Proceed with your best judgment and complete the task without asking further questions.`), up to `gate.maxContinuations` (default 3); `gatesHit` = continuations used. Resume per CLI: Claude `--resume <session_id>` (sessions persist in the run's fresh config dir, so `--no-session-persistence` is not used), Codex `exec resume <thread_id> -- <reply>` with the same flags (so `--ephemeral` is not used; sessions live in the run's fresh `CODEX_HOME`), Pi `--session-dir <runHome>/pi-sessions --continue`. `reviewFindings` and `corrections` are `null` (= not applicable) for headless baselines, which have no review stage and no human at delivery; resumability is measured from Phase 7 with kill-and-resume tasks. Reports render `null` as `n/a` — cost if wrong: a question not ending in `?` is not answered (the run simply ends; recorded).
20. **Curated PATH** (plan review I5). Each run gets `<runHome>/.eval-bin/` with symlinks to the realpaths of `node`, `npm`, `npx`, `git`, and the contender's CLI; `PATH=<runHome>/.eval-bin:/usr/local/bin:/usr/bin:/bin`. Every realpath's directory under the hidden home is ro-bound.
21. **Public tasks are exposed by construction** (plan review I1). Filesystem isolation cannot stop a contender with network access from downloading checks published in the public repository; egress filtering per provider endpoint is out of scope. Public tasks are therefore `exposure: "public"`, the report states it in its header, and a heuristic flags `leakSuspect: true` on any run whose redacted stream mentions `evals/tasks`, `jrevenga/ai-factory`, or a withheld check's file name. Claims rely on private tasks (held-out included) — cost: Phase 3's smoke report is a pipeline-and-baseline report, not evidence of capability on unseen work.
22. **Process supervision and signals** (plan review I6, I7). Contenders and checks are spawned detached on POSIX (own process group), stdin ignored; on every exit path (normal, error, timeout, abort) the controller tears down the whole group and awaits it before verification (`killProcessTree`; under bwrap, `--unshare-pid --die-with-parent` also takes the namespace down). `runBounded` gains `RunOptions.parentSignals?: "exit" | "ignore"` (default `"exit"`, today's behavior); eval passes `"ignore"` and its own `AbortSignal`. `factory eval run` installs its own SIGINT/SIGTERM handlers: the first aborts after tearing down the current child and writes the incomplete report (exit 3); a second forces exit 130.
23. **Held-out confirmation** (plan review I9). `factory eval run --confirms <devRunId>` selects the held-out tasks, copies profile, contenders, reps and pins from the dev run's manifest, and refuses unless the dev run is complete and pins, thresholds and factory commit match. `factory eval report <devRunId>` finds complete confirming runs (manifest `confirms`); a comparison's `heldoutConfirmed` is true iff the confirming run's comparison for the same candidate and reference is `improved` under the same thresholds (eligibility rules except the held-out clause). The report names the confirming run.

## Owner inputs (needed only for Task 13, the live acceptance run)

1. Create the three dedicated eval logins of ruling 4 (interactive OAuth; `factory eval setup` prints the exact commands).
2. Approve the quota spend: 2 profiles × 3 baselines × 3 tasks × 3 reps = 54 agent runs (plus ≤ 3 scripted continuations each; budget stops of ruling 15 apply).
3. Later (not blocking): real-project tasks for the private store.

## Global Constraints

- Everything in Phase 1–2 Global Constraints still binds (Node ≥ 22.19.0, CI matrix ubuntu/windows × Node 22.19.0/24, exact pins, no `shell: true`, layers, conventional commits, English artifacts, isolated test homes).
- No new npm dependency. `bwrap` is optional at runtime and never needed by CI tests (sandbox tests `skipIf` it is unusable).
- No model calls and no network in tests. Real CLIs (`claude`, `codex`, real Pi with a provider) are never spawned by tests; fake CLIs (node scripts) stand in.
- Secrets (vault files, the token) are never read by tests (tests use fake vaults under temp dirs), never printed, never written into results, manifests, reports, logs or argv.
- Eval artifacts (`<evalRoot>`, vault, runs, private tasks) are created 0700 (files holding secrets 0600).
- Controller git never runs against an agent-controlled `.git` and always uses the isolated git environment of ruling 3.
- Schemas: every new persisted shape is a zod schema in `src/core/eval/` exported to `schemas/*.schema.json` via `scripts/gen-schemas.ts`.

## Review Focus

1. **Withheld-check leakage:** from inside a contender sandbox the real home, `evals/`, the private store, the vault and other runs are invisible; `ws/.git` holds one commit with no solution even for a `git` snapshot whose source has a later solution commit. Pinned by Task 6 and Task 7.
2. **Agent-controlled git metadata:** a planted `filter.*.clean`, hook or fsmonitor in `ws/.git` never executes on the controller. Pinned by Task 7.
3. **Secret exposure:** the token (emitted by a fake CLI across chunk boundaries) never appears in argv, records, manifest, report or stored logs; a planted `!command` Pi credential is never written back. Pinned by Tasks 9–10.
4. **Process teardown:** a contender whose leader exits normally or times out leaves no grandchild running; SIGINT during verification ends with an incomplete report and exit 3. Pinned by Tasks 10 and 12.
5. **Resume and statistics integrity:** a torn tail is repaired before appending, a drifted task refuses resume, and an interrupted 5-rep run is not eligible. Pinned by Tasks 5 and 11.

---

## File structure

```
src/core/eval/task.ts             EvalTask schema
src/core/eval/records.ts          EvalRunRecord, EvalRunManifest, ToolsLock, Usage, QuotaStatus schemas
src/core/eval/thresholds.ts       EvalThresholds schema
src/core/eval/contenders.ts       ContenderId, ContenderPins, baselinesFor, referenceContender, expectedProvider, baselineModel
src/core/eval/matrix.ts           selectTasks, planMatrix, mulberry32, shuffle
src/core/eval/streams.ts          parseClaudeStream, parseCodexStream, parsePiStream, endsWithQuestion
src/core/eval/stats.ts            aggregate, pairedComparison, verdict, eligibility
src/core/eval/report.ts           EvalReport schema, buildReport, renderMarkdown
src/core/config/schema.ts         (modified) PersonalConfig.eval
src/adapters/pi/extension/ledger.ts   (modified, Task 1)
src/adapters/platform/process.ts  (modified, Task 10) parentSignals option
src/adapters/eval/paths.ts        evalPaths, ensurePrivateDir
src/adapters/eval/tasks.ts        loadTasks, hashTree
src/adapters/eval/sandbox.ts      bwrapUsable, sandboxArgs
src/adapters/eval/git-isolated.ts controllerGit (isolated env)
src/adapters/eval/workspace.ts    materialize, buildVerifyTree, diffStat, overlayChecks, runChecks
src/adapters/eval/vault.ts        stageAuth, writeBackAuth, readClaudeToken
src/adapters/eval/invoke.ts       buildInvocation, buildContinuation, probeVersions, checkPins
src/adapters/eval/run.ts          runContender
src/adapters/eval/results-file.ts appendRecord, readRecords
src/adapters/eval/orchestrator.ts runEval, resumeEval
src/adapters/eval/setup.ts        evalSetup
src/cli/commands/eval.ts          factory eval setup|tasks|run|report
evals/README.md, evals/contenders.json, evals/tasks/<id>/{task.json,repo/,checks/,solution/}
defaults/eval-thresholds.json
schemas/eval-task.schema.json, eval-run-record.schema.json, eval-run-manifest.schema.json, eval-report.schema.json, eval-thresholds.schema.json, eval-contenders.schema.json, eval-tools-lock.schema.json
test/core/eval/*.test.ts, test/adapters/eval/*.test.ts, test/fixtures/eval/ (fake CLIs, canned streams, task fixtures), test/e2e/eval-tasks.e2e.test.ts, test/e2e/eval.e2e.test.ts
```

---

### Task 1: Interrupted-run selection by start time (carry-forward)

**Files:** Modify `src/adapters/pi/extension/ledger.ts` (`sessionInterruptedRuns`: the `.sort()` + `.at(-1)` that picks the latest earlier run of the Pi session); Test `test/adapters/pi/extension/ledger.test.ts`.

**Interfaces:** unchanged signatures.

- [ ] **Step 1: Failing test:** two earlier runs of the same Pi session whose ids share the second (`20261105T100000Z-900` with `run_start.ts` `…:00.100Z`, `20261105T100000Z-1000` with `…:00.200Z`; lexical order puts `-1000` first) → the selected latest is `20261105T100000Z-1000`; a run whose ledger has no readable `run_start` sorts first (oldest).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** ordering by `run_start.ts` (ISO string compare), run id as tie-break. **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `fix(pi): pick a session's latest interrupted run by start time, not run id`.

### Task 2: Eval schemas and core data

**Files:** Create `src/core/eval/task.ts`, `src/core/eval/records.ts`, `src/core/eval/thresholds.ts`, `src/core/eval/contenders.ts`, `evals/contenders.json`, `defaults/eval-thresholds.json`; Modify `src/core/config/schema.ts` (PersonalConfig `eval`, additive), `scripts/gen-schemas.ts`; generate the seven `schemas/eval-*.schema.json` except `eval-report` (Task 5); Test `test/core/eval/schemas.test.ts`.

**Interfaces (Produces):**
- `EvalTask` (zod, strict): `{ schema: 1; id /* ^[a-z0-9][a-z0-9-]{0,62}$ */; title; tier: "answer"|"small"|"feature"|"project"; split: "dev"|"heldout"; suites: ("smoke"|"full"|"memory")[] /* min 1 */; snapshot: { kind: "dir" } | { kind: "git"; url: string; ref: string /* 40-hex */ }; prompt: string; checks: { name; argv: string[] /* min 1 */; timeoutSec: int 1..1800 = 300 }[] /* min 1 */; rubric?: string; budget: { wallSec: int 60..7200; maxTurns?: int ≥ 1 }; gate: { reply: string; maxContinuations: int 0..10 } /* default ruling 19 */ }`.
- `ProviderId = "claude" | "codex"`; `Usage = { input; output; cacheRead; cacheWrite }` (non-negative ints); `QuotaStatus = { state: "known"; utilization: number; window?: string; resetsAt?: string } | { state: "exhausted" } | { state: "unknown" }`.
- `ContenderId = "claude-code" | "claude-code-superpowers" | "pi-bridge" | "codex" | "codex-superpowers" | "pi-codex" | "oracle" | "noop"`; `ProfileName = "claude-codex" | "codex-only"`; `baselinesFor(p)` (ruling 6 order); `referenceContender(p)`; `expectedProvider(c): ProviderId | null`; `baselineModel(profile: Profile): string`.
- `ContenderPins`: `{ schema: 1; claude: { version }; codex: { version }; superpowers: { git; tag; version } }`; `ToolsLock`: `{ schema: 1; superpowers: { tag; commit /* 40-hex */ }; bridge: { version } }`.
- `EvalRunRecord`: `{ v: 1; evalRunId; taskId; contender; rep; startedAt; wallMs; exit: "ok"|"error"|"timeout"|"skipped-budget"; exitCode: number | null; turns: number; gatesHit: number; checks: { name; pass; exitCode: number | null; timedOut; ms }[]; pass: boolean; escapedDefects: number; usage: Partial<Record<ProviderId, Usage>>; usageMissing: boolean; quota: Partial<Record<ProviderId, QuotaStatus>>; diffStat: { files; insertions; deletions } | null; reviewFindings: null; corrections: null; authWriteBack: "unchanged"|"written"|"rejected"|null; leakSuspect: boolean; errorSummary: string | null /* redacted, ≤ 500 */ }`.
- `EvalRunManifest` per ruling 16 (`v: 1`, `confirms: string | null`).
- `EvalThresholds` + `defaults/eval-thresholds.json` (ruling 14 values, `schema: 1`); `PersonalConfig.eval?: { tokenBudget?: { claude?: number; codex?: number }; quotaStopAt?: number /* 0..1 */ }`.

- [ ] **Step 1: Failing tests:** each schema accepts a valid example and rejects: id `Bad_ID`, empty `checks`, `timeoutSec: 0`, git ref not 40-hex, unknown key, `quotaStopAt: 1.5`, `maxContinuations: 11`; `gate` defaults filled; `baselinesFor("codex-only")` = `["codex","codex-superpowers","pi-codex"]`; `baselineModel` of `profiles/claude-codex.json` = `claude-opus-5-5`; both data files parse.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; add the schemas to `SOURCES`, `npm run schemas`. **Step 4:** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(eval): add eval task, record, manifest, contender and threshold schemas`.

### Task 3: Task selection and run matrix (core)

**Files:** Create `src/core/eval/matrix.ts`; Test `test/core/eval/matrix.test.ts`.

**Interfaces:**
- Produces: `selectTasks(tasks: EvalTask[], sel: { suite; heldout: boolean; taskIds?: string[] }): EvalTask[]` — `heldout: false`: `dev` tasks whose `suites` include `suite` (`full` takes every `dev` task); `heldout: true`: only `heldout` tasks (tagged with `suite`, or all held-out for `full`); `taskIds` filters further, an unknown id throws `unknown task: <id>`; sorted by id.
- Produces: `RunSpec = { taskId; contender: ContenderId; rep /* 1-based */ }`; `planMatrix(taskIds, contenders, reps, seed): RunSpec[]` — rep, then task (input order), then contenders shuffled by `shuffle(contenders, mulberry32(hash32(seed, taskId, rep)))`; `mulberry32(seed): () => number`; `shuffle<T>(xs, rng)` (Fisher–Yates, non-mutating); `hash32` = FNV-1a over `${seed}:${taskId}:${rep}`.

- [ ] **Step 1: Failing tests:** selection rules; `planMatrix(["a","b"], [c1,c2,c3], 2, 42)` → 12 specs, each (task, rep) block a permutation; same seed → identical array; seeds 42 and 43 differ in at least one block; `mulberry32(1)` first three outputs pinned.
- [ ] **Step 2–4:** FAIL → implement → `npm test` PASS.
- [ ] **Step 5: Commit** `feat(eval): add task selection and seeded run matrix`.

### Task 4: Contender stream parsers (core)

**Files:** Create `src/core/eval/streams.ts`, canned streams `test/fixtures/eval/streams/{claude-ok,claude-question,claude-ratelimit-rejected,claude-error,codex-ok,codex-failed,pi-bridge-ok,pi-codex-ok,pi-error,truncated}.jsonl`; Test `test/core/eval/streams.test.ts`.

**Interfaces:**
- Produces: `ParsedStream = { usage: Partial<Record<ProviderId, Usage>>; quota: Partial<Record<ProviderId, QuotaStatus>>; sessionId: string | null; finalMessage: string | null; error: string | null; limitHit: ProviderId | null; malformedLines: number }`; `parseClaudeStream(text)`, `parseCodexStream(text)`, `parsePiStream(text)`; `mergeParsed(turns: ParsedStream[]): ParsedStream` (usage summed, last non-null wins for the rest, `malformedLines` summed); `endsWithQuestion(message: string | null): boolean` (last non-empty line, trimmed, ends with `?`).
- Mapping (ruling 13): Claude `result` → `usage.claude = { input: input_tokens, output: output_tokens, cacheRead: cache_read_input_tokens, cacheWrite: cache_creation_input_tokens }`, `finalMessage = result`, `is_error` or `subtype !== "success"` → `error`, `session_id` from `system/init` or `result`; last `rate_limit_event.rate_limit_info`: `status: "rejected"` ⇒ `exhausted`, numeric `utilization` ⇒ `known` (`rateLimitType` → `window`, `resetsAt` epoch seconds → ISO). Codex: Σ `turn.completed.usage` (`input` = `input_tokens − cached_input_tokens`, `cacheRead` = `cached_input_tokens`, `output_tokens`), `thread.started.thread_id`, last `item.completed` with `item.type === "agent_message"` → `finalMessage`, `turn.failed.error.message` / `error.message` → `error`. Pi: Σ assistant `message_end.message.usage` per mapped provider (others ignored), last assistant text → `finalMessage`, `stopReason === "error"` → `error = errorMessage`, `sessionId` from the `session` header event when present. All: `limitHit` when `error` matches `/usage limit|rate limit|quota/i` or Claude quota is `exhausted`; non-JSON lines and a torn last line count in `malformedLines`.

- [ ] **Step 1: Write the canned streams** from the documented shapes and **failing tests** pinning token sums, `sessionId`, `finalMessage`, `error`, `limitHit`, quota states, `malformedLines` for `truncated.jsonl`, `mergeParsed` of two Claude turns, and `endsWithQuestion` (`"Which option?\n\n"` true, `"Done. Why? Because."` false, `null` false).
- [ ] **Step 2–4:** FAIL → implement → PASS. Task 13 refreshes these fixtures from real captured streams (redacted) if a shape differs.
- [ ] **Step 5: Commit** `feat(eval): parse usage, sessions, quota and final message from contender streams`.

### Task 5: Statistics, verdicts and reports (core)

**Files:** Create `src/core/eval/stats.ts`, `src/core/eval/report.ts`; Modify `scripts/gen-schemas.ts` (`eval-report.schema.json`); Test `test/core/eval/stats.test.ts`, `test/core/eval/report.test.ts`.

**Interfaces:**
- Consumes: `EvalRunRecord`, `EvalRunManifest`, `EvalThresholds` (Task 2).
- Produces: `aggregate(records, manifest): ContenderSummary[]`, `ContenderSummary = { contender; tier; runs; passRate; passRateSd; escapedDefectsMean; usage: Partial<Record<ProviderId, { median; iqr: [number, number]; n }>> /* per-run total = input+output+cacheRead+cacheWrite; usageMissing runs excluded */; usageMissing; wallMsMedian; errors; timeouts; gatesHitMean; leakSuspect; skippedBudget }`.
- Produces: `pairedComparison(records, candidate, reference, seed): Comparison = { candidate; reference; tasks; minRunsPerTask; passRateDiffPp; ci95: [number, number]; escapedDefectsDiff; usageRatio: Partial<Record<ProviderId, number>>; wallRatio }` — tasks where both have ≥ 1 counted run; bootstrap over tasks, 2 000 resamples, `mulberry32(seed)`.
- Produces: `verdict(c, t, ctx: { suite; complete: boolean; manifestTaskIds: string[]; heldoutConfirmed: boolean }): { branch: "pass-rate" | "usage" | null; improved: boolean; regressions: string[]; eligible: boolean; note: string }` exactly per ruling 14 (eligibility also requires `c.tasks === manifestTaskIds.length` and `c.minRunsPerTask >= 5`).
- Produces: `EvalReport` (zod) `{ v: 1; manifest: EvalRunManifest; incomplete: { reason } | null; summaries; comparisons: (Comparison & { verdict; confirmedBy: string | null })[]; perTask: { taskId; contender; runs; passes; gatesHit }[]; generatedAt }`; `buildReport(manifest, records, thresholds, opts: { incomplete; now: Date; confirming?: { manifest; records }[] }): EvalReport`; `renderMarkdown(r): string` (header: pins, seed, host, drift, exposure banner when any task is public (ruling 21), smoke banner; one table per tier; comparisons vs the reference; per-task table; `null` → `n/a`; `usageMissing`, `unknown` quota and `leakSuspect` in words, never as 0).

- [ ] **Step 1: Failing tests:** hand-computed fixture (2 tasks × 2 contenders × 3 reps) → exact `passRate`, `passRateSd`, medians, IQR, `usageMissing` excluded from usage but counted in `runs`; paired diff where the candidate wins task A by 2/3 and loses B by 1/3 → `passRateDiffPp = 16.67` (2 dp), CI pinned for seed 7, `escapedDefectsDiff` pinned. Verdict boundaries: `passRateDiffPp` 5 → not improved, 5.01 → improved; usage branch with `usageRatio` 0.85 → improved, 0.8501 → not; `wallRatio` 1.25 → no regression, 1.2501 → regression; escaped-defects diff 0.01 → regression; pass-rate branch with usage ratio 1.1001 → regression. Eligibility: smoke → false with the banner note; full, complete, 5 runs on every task, confirmed → true; an interrupted 5-rep run (one task at 4 runs) → false; `heldoutConfirmed: false` → false. Markdown inline snapshot of a small report.
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test` PASS.
- [ ] **Step 5: Commit** `feat(eval): add paired statistics, verdicts and reports`.

### Task 6: Sandbox adapter (bubblewrap)

**Files:** Create `src/adapters/eval/sandbox.ts`; Test `test/adapters/eval/sandbox.test.ts`.

**Interfaces:**
- Produces: `SandboxSpec = { hide: string[]; roBinds: string[]; rwBinds: string[]; cwd: string; network: boolean }`; `sandboxArgs(spec, command, args): string[]` — ruling 1 order: base mounts, `--tmpfs` per hidden root (deduplicated, parents before children), `--ro-bind p p`, `--bind p p`, `--chdir`, namespace flags, `--unshare-net` iff `!network`, `--`, command, args; throws on a relative path.
- Produces: `bwrapUsable(platform = process.platform): Promise<{ ok: true; version: string } | { ok: false; reason: string }>` — non-Linux → `ok: false` without spawning; else `bwrap --version` and the probe `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid --die-with-parent true`, each bounded to 5 s.

- [ ] **Step 1: Failing tests:** exact array for a spec with two hidden roots, one ro and one rw bind, network off; relative path throws; win32 → `ok: false` without spawning. Linux e2e (`describe.skipIf(!usable)`): with temp `fakeHome/{secret.txt,ws/}` hidden/bound, a sandboxed `sh -c` cannot read `secret.txt` and can write `ws/out.txt`; with `network: false` a `node -e` connecting to a test server on `127.0.0.1` fails, with `network: true` it succeeds.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(eval): add bubblewrap sandbox for contenders and checks`.

### Task 7: Task loading, controller-owned repos and checks

**Files:** Create `src/adapters/eval/paths.ts`, `src/adapters/eval/tasks.ts`, `src/adapters/eval/git-isolated.ts`, `src/adapters/eval/workspace.ts`; Test `test/adapters/eval/{tasks,workspace}.test.ts`, fixtures `test/fixtures/eval/tasks/{good,bad-schema,dup}/…`.

**Interfaces:**
- Consumes: `EvalTask` (Task 2), `sandboxArgs`/`SandboxSpec` (Task 6), `runBounded` (`src/adapters/platform/process.ts`).
- Produces: `evalPaths(env): { root; runs; tasks; vault: { codex; pi; claudeToken }; tools }` under `<FACTORY_HOME>/eval`; `ensurePrivateDir(p)` (mkdir -p, 0700 on POSIX).
- Produces: `LoadedTask = { task; dir; source: "public"|"private"; hasSolution }`; `loadTasks(roots: { dir; source }[]): LoadedTask[]` (dir name = id; duplicate id across roots throws naming both; `dir` snapshot without `repo/` throws; missing root skipped); `hashTree(dir): string` (sha256 over sorted `relpath\0bytes` entries, symlinks hashed by target text; stable across OSes).
- Produces: `controllerGit(args, opts: { cwd; scratch: string }): Promise<RunResult>` — ruling 3's isolated env and `-c` flags always applied.
- Produces: `materialize(t: LoadedTask, runDir): Promise<{ base: string; ws: string; baseSha: string }>` — `base/` per ruling 3 (dir: copy `repo/` minus any `.git`; git: temporary bare clone, `--work-tree=base checkout -f <ref> -- .`, bare clone deleted), `git init -q -b main`, one commit with author/committer `factory-eval <eval@factory.invalid>` at `2026-01-01T00:00:00Z`, `core.autocrlf=false`, no gpg, `maintenance.auto=false`, `gc.auto=0`; `ws/` = recursive copy of `base/` (incl. `.git`).
- Produces: `buildVerifyTree(base, ws, verifyDir): Promise<void>` (controller clone of `base`, worktree files replaced by `ws` minus top-level `.git`, no symlink following, special files skipped); `diffStat(verifyDir, baseSha)` (`add -A` + `diff --cached --numstat`); `overlayChecks(t, verifyDir, finalMessage)` (copy `checks/`, write `.eval/final-message.txt`); `runChecks(t, verifyDir, sandbox: SandboxSpec | null)` (each `argv` without a shell, cwd `verifyDir`, `timeoutSec`, `network: false`, `parentSignals: "ignore"` once Task 10 adds it — until then the default).

- [ ] **Step 1: Failing tests:** loader accepts `good`, rejects `bad-schema` (message names the file) and `dup`; `materialize` twice on a dir snapshot → same `baseSha`, one commit; a `git` snapshot source repo with a later commit adding `SOLUTION.md` → `base` has one commit, `SOLUTION.md` absent, `git cat-file --batch-all-objects --batch-check` lists no blob of `SOLUTION.md`; `repo/.git` in a dir snapshot is not copied. **C1 regression:** in `ws/`, set `.git/config` `filter.evil.clean = node -e "require('fs').writeFileSync(process.env.MARKER,'x')"` (and `core.fsmonitor`, `core.hooksPath` pointing at a script writing the marker), add `.gitattributes` `* filter=evil`, modify a file → `buildVerifyTree` + `diffStat` run and the marker file never appears; `diffStat` counts one modified and one new file and is unchanged by `overlayChecks`; a symlink in `ws` to a file outside is copied as a symlink; `runChecks` reports pass, fail and `timedOut` (`node -e "setTimeout(()=>{},60000)"`, `timeoutSec: 1`) with no orphan.
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test` PASS (both OSes in CI).
- [ ] **Step 5: Commit** `feat(eval): load tasks, build controller-owned repos and run withheld checks`.

### Task 8: Public smoke and held-out tasks

**Files:** Create `evals/tasks/{slugify-unicode,duration-compound,cache-ttl-lru,csv-quoted-fields,retry-backoff}/{task.json,repo/…,checks/…,solution/…}`, `evals/README.md` (layout, adding a task, the private store, the exposure caveat of ruling 21); Test `test/e2e/eval-tasks.e2e.test.ts`.

**Interfaces:** Consumes `loadTasks`, `materialize`, `buildVerifyTree`, `overlayChecks`, `runChecks` (Task 7), `selectTasks` (Task 3).

Content (ruling 11): each `repo/` is a dependency-free ESM package (`"type": "module"`, a visible `test/*.test.js` passing on the snapshot, `npm test` = `node --test`); the prompt reads like a user's issue (symptom and expected behavior, no file hints beyond what a user would know, no mention of the factory); `checks/` adds `test/*.hidden.test.js`; each check `argv` is `["node","--test"]`, `timeoutSec: 120`; `budget.wallSec` 900 (small) / 1800 (feature); `solution/` overlays the minimal correct change.

- [ ] **Step 1: Write the e2e test** (fails: no tasks): for every public task — schema valid; untouched snapshot → at least one check fails; `solution/` copied into `ws/` → all checks pass; no hidden test file exists in `repo/`; `selectTasks(…, { suite: "smoke", heldout: false })` = the three dev ids, `heldout: true` = the two held-out ids.
- [ ] **Step 2: Run** → FAIL. **Step 3: Write the five tasks.** **Step 4: Run** `npx vitest run test/e2e/eval-tasks.e2e.test.ts` → PASS on Node 22.19 and 24.
- [ ] **Step 5: Commit** `feat(eval): add public smoke and held-out tasks`.

### Task 9: Auth vault and contender invocations

**Files:** Create `src/adapters/eval/vault.ts`, `src/adapters/eval/invoke.ts`; Test `test/adapters/eval/{vault,invoke}.test.ts`.

**Interfaces:**
- Consumes: `ContenderId`, `ContenderPins`, `baselineModel` (Task 2); `evalPaths` (Task 7).
- Produces: `stageAuth(kind: "codex" | "pi", vaultDir, targetDir): Promise<{ staged: boolean; sha256: string | null }>` (copy only `auth.json`, 0600; missing → `staged: false`); `writeBackAuth(kind, targetDir, vaultDir, stagedSha): Promise<"unchanged" | "written" | "rejected">` (ruling 4 validation, atomic tmp + rename, 0600); `readClaudeToken(vaultFile): string | undefined` (refuses a file with group/other permission bits on POSIX).
- Produces: `InvocationContext = { contender; prompt; model: string | null; workspace; runHome; tools: { claude?; codex?; piCli; node; npm; git; bridgeDir?; superpowersDir? }; secrets: { claudeToken? }; taskDir; maxTurns? }`; `Invocation = { command; args; env: Record<string,string>; roBinds: string[]; rwBinds: string[]; stream: "claude"|"codex"|"pi"|"none"; secretValues: string[]; prepare(): Promise<void> }` (`prepare` builds `<runHome>/.eval-bin` (ruling 20), fresh config dirs, stages auth, and for `codex-superpowers` links `<runHome>/.agents/skills/superpowers` → `<superpowersDir>/skills`).
- Produces: `buildInvocation(ctx): Invocation` and `buildContinuation(ctx, sessionId: string | null, reply: string): Invocation` exactly:
  - `claude-code`: `<claude> -p <prompt> --output-format stream-json --verbose --model <model> --permission-mode bypassPermissions [--max-turns N]`; continuation adds `--resume <sessionId>` with `<reply>` as the prompt. Env: `HOME=<runHome>`, `CLAUDE_CONFIG_DIR=<runHome>/.claude`, `CLAUDE_CODE_OAUTH_TOKEN`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `PATH` (ruling 20), `LANG=C.UTF-8`. `claude-code-superpowers`: plus `--plugin-dir <superpowersDir>` (ro bind).
  - `codex`: `<codex> exec --json --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox -m <model> -C <workspace> -- <prompt>`; continuation `<codex> exec resume <sessionId> --json --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox -m <model> -- <reply>` (the implementer confirms with `codex exec resume --help` that each flag is accepted after `resume`; any that is not moves before `resume` and the ruling is ledgered). Env: `HOME`, `CODEX_HOME=<runHome>/.codex`, `PATH`, `LANG`.
  - `pi-bridge` / `pi-codex`: `<node> <piCli> --mode json --session-dir <runHome>/pi-sessions --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes [-e <bridgeDir>] --model claude-bridge/<model> | openai-codex/<model> -- <prompt>`; continuation adds `--continue` with `<reply>`. Env: `HOME`, `PI_CODING_AGENT_DIR=<runHome>/.pi-agent`, `PATH`, `LANG`, and for the bridge `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`.
  - `oracle` / `noop`: `<node> -e <script>` (oracle copies `<taskDir>/solution` into the cwd), printing `{"type":"final","text":"oracle"|"noop"}`; `stream: "none"`; no continuation.
- Produces: `probeVersions(tools)` (`--version`, first semver, 10 s) and `checkPins(probed, pins, release): string[]`.

- [ ] **Step 1: Failing tests:** exact argv/env per contender and per continuation (inline snapshots with fixed paths); a fake token never appears in any `args`; `secretValues` contains it; `prepare` creates `.eval-bin` symlinks and a 0600 staged `auth.json` (fake vault in a temp dir) and nothing else from the vault; `writeBackAuth` → `unchanged` for identical bytes, `written` for a valid refreshed Codex/Pi file, `rejected` for a Pi file containing `{"openai-codex":{"type":"api_key","key":"!touch /tmp/x"}}` or invalid JSON (vault unchanged); `readClaudeToken` refuses mode 0644 (POSIX); `checkPins` reports `claude 2.1.317 ≠ 2.1.318`.
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test` PASS.
- [ ] **Step 5: Commit** `feat(eval): add the eval auth vault and contender invocations`.

### Task 10: Supervised, redacted contender runs

**Files:** Create `src/adapters/eval/run.ts`, fake CLIs `test/fixtures/eval/fake-cli/{claude,codex,pi}.mjs` (print the canned stream named by `FAKE_STREAM`; optionally write `FAKE_WRITE` into the cwd; `FAKE_SECRET` printed to stdout and stderr split across two writes; `FAKE_HANG=1` spawns a TERM-ignoring grandchild and hangs; `FAKE_ORPHAN=1` spawns a grandchild and exits 0); Modify `src/adapters/platform/process.ts` (`RunOptions.parentSignals`, ruling 22); Test `test/adapters/eval/run.test.ts`, `test/adapters/platform/process.test.ts` (extend).

**Interfaces:**
- Consumes: `Invocation` (Task 9), `sandboxArgs` (Task 6), `LineRedactor` (`src/core/policy/redact.ts`), `killProcessTree`.
- Produces: `runContender(inv, sandbox: SandboxSpec | null, opts: { timeoutMs; eventsFile; stderrFile; signal?: AbortSignal }): Promise<{ exit: "ok"|"error"|"timeout"|"aborted"; exitCode: number | null; wallMs }>` — spawn `bwrap sandboxArgs(…)` (or the command when `sandbox` is null) with `env` exactly `inv.env`, detached on POSIX, stdin ignored; stdout/stderr → `LineRedactor` + literal `secretValues` replacement → files; on exit, timeout or abort the group is torn down and awaited before returning.

- [ ] **Step 1: Failing tests:** the fake claude CLI's canned stream reaches `eventsFile` and `FAKE_WRITE` lands in the workspace; `FAKE_SECRET` split across writes is absent from both files (replaced by the redaction mask); `FAKE_HANG=1`, `timeoutMs: 1000` → `exit: "timeout"`, and within 5 s no process whose cmdline contains the test's unique marker survives; `FAKE_ORPHAN=1` → `exit: "ok"` and the grandchild is gone when `runContender` resolves; abort via `signal` → `exit: "aborted"`, same teardown; each case unsandboxed on every OS and sandboxed on Linux when `bwrapUsable`. `runBounded(..., { parentSignals: "ignore" })` installs no SIGINT listener (assert `process.listenerCount("SIGINT")` unchanged while running).
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test` PASS.
- [ ] **Step 5: Commit** `feat(eval): supervise contender runs with redacted streams and full teardown`.

### Task 11: Orchestrator (run, continuations, resume, budget stops, report)

**Files:** Create `src/adapters/eval/results-file.ts`, `src/adapters/eval/orchestrator.ts`; Test `test/adapters/eval/results-file.test.ts`, `test/e2e/eval.e2e.test.ts`.

**Interfaces:**
- Consumes: Tasks 2–10.
- Produces: `appendRecord(file, record)` (drop torn tail + fsync, then append + fsync) and `readRecords(file): EvalRunRecord[]` (skips a torn tail).
- Produces: `EvalOptions = { suite; profile: ProfileName | null; contenders?: ContenderId[]; reps; seed?; taskIds?; confirms?: string; keep; allowDrift; budget: PersonalConfig["eval"] }`; `runEval(opts, deps: EvalDeps): Promise<{ evalRunId; reportPath; incomplete: { reason } | null }>`; `resumeEval(evalRunId, deps)`; `buildEvalReport(evalRunId, deps): EvalReport` (from saved inputs only, with confirming runs); `EvalDeps = { env; root /* package root */; now(): Date; randomHex(n): string; tools; log(line): void; signal?: AbortSignal; sandbox: "auto" | "off" /* "off" only for tests and only with test contenders */ }`.
- Behavior: contenders = `opts.contenders ?? baselinesFor(profile)`; `oracle`/`noop` refuse private tasks; model-calling contenders require `bwrapUsable` (refuse before any spec: `model-calling evals need bubblewrap (Linux)`); `--confirms` per ruling 23; manifest per ruling 16 written before the first spec. Per spec: `materialize`; for turn k = 0..: `prepare` (turn 0), `runContender` (`events-<k>.jsonl`), parse; continue with `buildContinuation` while `endsWithQuestion(finalMessage)`, a session id exists and `gatesHit < gate.maxContinuations`, all within the task's `wallSec` overall; `writeBackAuth`; `mergeParsed`; `usageMissing`; `leakSuspect` (ruling 21); `buildVerifyTree` → `diffStat` → `overlayChecks` → `runChecks` (sandboxed when usable); `appendRecord`; delete `ws/home/verify/base` unless `keep`; then ruling 15 stops. Abort → teardown, `incomplete: { reason: "interrupted" }`. Finally `report.json` (validated) + `report.md`. One log line per spec (`[k/N] task contender rep → pass|fail (12.3 s, 1 gate)`), never env or argv.

- [ ] **Step 1: Failing tests:** `results-file`: torn tail dropped before append; recover → interrupt again (torn) → read returns only whole records. e2e (oracle/noop over the public smoke tasks, `sandbox: "off"`): `--contenders oracle,noop --reps 2 --seed 1` → 12 records, oracle pass rate 1, noop 0, valid `report.json`, `report.md` with smoke and exposure banners; continuation: a fake claude CLI (via a test seam for tools, `sandbox: "off"`) whose first turn ends with `Which approach?` and second turn succeeds → `turns: 2`, `gatesHit: 1`, usage summed over both; budget: the canned claude stream exceeds `tokenBudget.claude` → `incomplete.reason` names the budget and the remaining specs are not run; resume: abort after 3 records, tear the last line → `resumeEval` reaches 12 records, no duplicates, partial run dir re-created; editing a frozen task's checks before resume → refused with `changed since the run started`; `--confirms` against an incomplete dev run → refused; a model contender with `bwrapUsable` false → refused before any spec.
- [ ] **Step 2–4:** FAIL → implement → PASS (both OSes).
- [ ] **Step 5: Commit** `feat(eval): orchestrate eval runs with scripted gates, resume, budget stops and reports`.

### Task 12: `factory eval` CLI, setup and docs

**Files:** Create `src/adapters/eval/setup.ts`, `src/cli/commands/eval.ts`; Modify `src/cli/main.ts` (route `eval`, drop it from `LATER_PHASE`, usage text), `README.md` (Evaluation section: what runs where, the sandbox, the vault and eval logins, budget, the exposure and smoke banners), `CHANGELOG.md` (Unreleased); Test `test/cli/eval.test.ts`.

**Interfaces:**
- Consumes: `runEval`, `resumeEval`, `buildEvalReport` (Task 11), `loadTasks`, `selectTasks`, `evalPaths`, PersonalConfig loading (Phase 1).
- Produces commands:
  - `factory eval setup [--json]` — creates `<evalRoot>` dirs (0700); clones Superpowers at the pinned tag into `tools/superpowers-<version>` and records/verifies `tools/superpowers.lock.json` (`ToolsLock`); installs pi-claude-bridge at the `release.json` pin into `tools/pi-claude-bridge-<version>` (`npm install --ignore-scripts --no-audit --no-fund --prefix`); reports readiness per contender: binary + version vs pin, `bwrapUsable`, Codex login (`codex login status` with `CODEX_HOME=<vault/codex>`, exit code only), Pi login (`pi auth check --provider openai-codex --no-refresh --json`, status field only), Claude token (exists, mode 0600 — not read); prints the exact login commands for anything missing (ruling 4, with `umask 077` for the token file).
  - `factory eval tasks [--suite <s>] [--heldout]` — id, tier, split, source, exposure; validates every task (exit 1 on any invalid).
  - `factory eval run --suite <smoke|full> --profile <claude-codex|codex-only> [--contenders a,b] [--reps N] [--seed S] [--tasks a,b] [--keep] [--allow-drift]`; `factory eval run --confirms <devRunId>`; `factory eval run --resume <id>`; `factory eval report <id> [--json]`.
  - Exit codes: 0 complete, 3 incomplete (budget/interrupt), 1 error, 2 usage. Signals per ruling 22.

- [ ] **Step 1: Failing tests** (via `main()`, isolated `FACTORY_HOME`, fake tools, no network): `eval tasks --suite smoke` lists the three dev ids; `eval run --suite smoke --contenders oracle --reps 1` exits 0 and prints the report path; no `--profile` and no `--contenders` → exit 2; `eval setup --json` with fake `codex`/`pi` on PATH (clone and npm install behind stubbed seams) reports `claudeToken: "missing"` and never opens the token path for reading (fs spy); `eval report <id>` prints the Markdown. Subprocess test: start `factory eval run --contenders oracle` on a task whose check sleeps 5 s, send SIGINT during verification → exit 3, `report.json` has `incomplete.reason: "interrupted"`, no child process left.
- [ ] **Step 2–4:** FAIL → implement → `npm run lint && npm test && npm run test:e2e` PASS.
- [ ] **Step 5: Commit** `feat(cli): add factory eval setup, tasks, run and report`.

### Task 13: Live acceptance — baseline smoke reports (owner-gated)

Runs on the owner's server only, after the owner inputs. Not a code task; the controller runs it.

- [ ] **Step 1:** `factory eval setup` → all tools pinned, `bwrap` usable; owner completes the three eval logins.
- [ ] **Step 2: Probe each contender** with `--tasks slugify-unicode --reps 1`: usage parsed for its provider (no `usageMissing`), sessions resumable (force one continuation with a probe task whose prompt asks the agent to end with a question), Claude+Superpowers shows the plugin's SessionStart injection, Codex+Superpowers sees the skills, auth write-back `written` or `unchanged`. Wiring differences are fixed as follow-up commits with tests and ledgered rulings; Task 4 fixtures refreshed from the captured (redacted) streams.
- [ ] **Step 3:** `factory eval run --suite smoke --profile claude-codex --reps 3` and `--profile codex-only --reps 3`.
- [ ] **Step 4: Reproducibility:** `factory eval report <id> --json` regenerated equals the stored report except `generatedAt`; manifests record pins, seed, models, argv templates and task hashes.
- [ ] **Step 5:** Commit both reports (Markdown + JSON; no secrets, no stream logs) under `docs/evals/2026-11-XX-phase3-smoke-<profile>.{md,json}` with `docs(eval): add phase 3 baseline smoke reports`.
