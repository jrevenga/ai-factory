# AI Factory — Design

- Date: 2026-10-31
- Status: draft, pending owner approval
- Owner: Jorge Revenga (sole approver of core changes)

Notation: **[owner]** = decided by the owner in conversation. **[call]** = architect's call, open to review. **[builder]** = explicitly left to the builder. **[verify]** = must be verified before relying on it.

---

## 1. Intent

Build a local, prebuilt, versioned **AI software factory on top of Pi** that turns ideas into working software through specialized agents, keeps knowledge across sessions, and improves its own methodology based on evidence.

The primary pain it removes is **[owner]**: having to hand-configure a harness on every machine, keep it updated by hand, and set it up manually for teammates. Distribution and reproducibility are therefore as much the product as agent orchestration. A brilliant factory that takes an afternoon to install has failed.

The second driver **[owner]**: the owner has used Superpowers and finds it ceremonious on small tasks and memoryless. The factory must beat default harnesses, harnesses-with-plugins, and simple configurations in quality while being more efficient.

## 2. Goals, non-goals, anti-goals

### Goals
1. One-command install on a clean machine (Windows native and Linux), with a doctor that explains what is missing and how to fix it.
2. Opt-in, versioned updates that never overwrite personal or project customization; one update applies to every project using the factory; rollback to any previous version.
3. Multi-agent work with roles (orchestrator, implementer, reviewer, researcher) mapped to models per profile; subagents, delegation, bounded parallelism, isolated execution.
4. An adaptive methodology whose ceremony scales with risk, not size.
5. Interactive collaboration with the orchestrator: explore ideas, define requirements, discuss architecture, intervene mid-run, persistent sessions, living specs, explicit approvals.
6. Persistent memory and project knowledge shared across agents and sessions without passing full conversations or flooding context.
7. End-to-end engineering: research, spec, plan, implement, test, independent review, integration, delivery, with traceability and verifiable acceptance criteria.
8. A reproducible evaluation system that proves the factory beats baselines and gates every methodology change.
9. Continuous intelligence (radar) and evidence-based self-evolution through PRs the owner approves.
10. Reliability and observability: permissions, failure recovery, subscription limits, agent and run state, metrics, quality evidence.
11. Usable from Claude Code and Codex as well as Pi, depending on what each user has (like Superpowers, Gentle-AI, RSC-Harness) **[owner]**. **Pi is the priority** and the reference implementation; other harnesses come later through adapters (§7.5).

### Non-goals (for this local product)
- Own server infrastructure or remote services. The architecture must allow a later client-server split without redesign, but none is built now.
- A web dashboard. Observability lives in Pi's TUI and CLI; a web UI belongs to the future client-server version **[call]**.
- A real security sandbox on machines without containers (see §11).
- Evaluating every harness × OS × profile combination. Model-calling evals run on Pi only; an improvement measured on Pi is assumed to carry over to other harnesses **[owner]**.

### Anti-goals (failure even if it technically works)
- Small tasks cost so much time or subscription that the owner opens Claude Code "for this quick thing".
- Installing or updating requires manual reconfiguration.
- Changes enter the core without the owner's approval, or reach a user without their opt-in.
- Memory that silently accumulates stale or wrong facts.
- Rules that live only in prose and are ignored (measured in RSC-Harness: 5 sessions of edits, 0 feature docs written).
- "Better" claimed without evaluation evidence.

## 3. Success criteria (measurable) **[owner]**, metrics **[call]**

| Criterion | Measure | Target |
|---|---|---|
| Beats baselines in quality | Eval pass rate, defects caught by review, escaped defects (hidden checks), corrections needed at delivery; vs Claude Code default, Claude Code + Superpowers, plain Pi | Factory ≥ best baseline on pass rate and escaped defects, per tier, with variance reported |
| More efficient | Subscription usage, wall time, human interruptions per task, per tier | Per profile, against same-provider baselines (§12.1): small tier costs no more than the plain CLI (Claude Code / Codex); feature/project tiers cost less than CLI + Superpowers at equal or better quality |
| Stays current | Radar runs; experiments run; validated improvements released | Weekly scan; every adopted change backed by an eval report |
| Team installs easily | Time from clean machine to working factory (excluding provider logins) | < 10 minutes on Windows and Linux, verified in CI |
| Used on real projects | Owner uses it daily on real repos | Owner's subjective verdict, supported by the metrics above |

## 4. Constraints and verified facts

### Environment **[owner]**
- Team machines are mostly **Windows**; the owner mainly uses Linux (always-on Ubuntu 24.04 server, 8 CPUs, 15 GiB RAM, no swap).
- **No Docker** on team machines. Isolation cannot depend on containers.
- Owner has Claude (Pro/Max) and Codex subscriptions. Team generally has **only Codex**.
- Core is **private** for now; may become public or shared via access grants later.
- Git Bash may be used where useful (question answered below).

### Pi (verified 2026-10-31 from repo docs and source)
- Repo moved to `github.com/earendil-works/pi`; npm `@earendil-works/pi-coding-agent`. Latest 1.4.0; owner has 1.3.0. Roughly weekly releases. Node ≥ 22.19.
- **Packages**: `pi install npm:… | git:…@ref | path`, pinned by version/tag/commit. A package bundles extensions, skills, prompt templates, themes; **not** `settings.json`. Users filter package resources per type in settings (`[]`, `!pattern`, `+path`/`-path`). Global (`~/.pi/agent/settings.json`) or project (`.pi/settings.json`, honored only after project trust).
- **Extensions**: in-process TypeScript, `registerTool/Command/Provider/Flag/MCP server`, events incl. `tool_call` (can mutate input or `{block:true}`), `before_agent_start`, `context`, `session_before_compact`, `session_shutdown`, `after_provider_response`, `agent_end`, `input`.
- **No** built-in subagents, worktrees, permissions, plan mode or todos; only examples (`examples/extensions/subagent` spawns `pi` subprocesses; `permission-gate`, `protected-paths`, `plan-mode`, `git-checkpoint`).
- **No security boundary** other than OS/containers (docs/security.md).
- Sessions: JSONL trees under `~/.pi/agent/sessions`, resume, fork, compaction hooks.
- Modes: TUI, print, `--mode json`, `--mode rpc` (typed `RpcClient`), in-process SDK. RPC is the natural seam for a future client-server split.
- Built-in MCP support now exists.
- Windows: native Pi runs its `bash` tool through **Git Bash by default** (`docs/windows.md`, `src/utils/shell.ts`: `shellPath` → `%ProgramFiles%\Git\bin\bash.exe` → x86 → `bash.exe` on PATH). Optional `powershell` tool.
- `enableInstallTelemetry` defaults to true.

### Providers (official terms checked 2026-10-31)
- **Claude**: `pi-claude-bridge` (elidickinson, MIT, active) registers a `claude-bridge` provider via the Claude Agent SDK using the real Claude Code binary and its own login.
  - Official billing (support.claude.com/en/articles/15036540, Oct 7 2026 update): "when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits."
  - Official prohibition (code.claude.com/docs/en/legal-and-compliance): third-party developers may not offer Claude.ai login, route requests through plan credentials on behalf of users, or "collect, store, or intermediate Claude.ai credentials or session tokens". Carve-out: an end user "signing in to the unmodified Claude Code binary with their own Claude subscription". Limits "assume ordinary, individual usage of Claude Code and the Agent SDK".
  - Consequence: **Pi's native Anthropic OAuth login is excluded** (it matches the prohibited pattern). Driving the unmodified Claude Code binary under the user's own login (Agent SDK via the bridge, or `claude -p`) is the best-supported route; no official page explicitly addresses a personal single-user harness, so a residual risk remains (§19). The factory never ships, stores or relays Claude credentials.
- **Codex**: Models in the owner's Codex cache: `gpt-6.1-sol` (workhorse), `gpt-6-astra` (frontier), `gpt-6-luna` (fast), others.
  - Official: OpenAI's "Sign in with ChatGPT" page (learn.chatgpt.com/docs/sign-in-with-chatgpt) lists **Pi** (with OpenCode, OpenClaw, T3) among its open-source integrations; app usage counts toward existing plan limits, with per-app weekly caps in Settings > Usage > App limits. An OpenAI executive publicly stated ChatGPT accounts may be used in third-party harnesses, Pi and OpenCode being ~10% of Codex traffic (secondary source). The owner has tested Pi's native Codex login **[owner]**.
  - Consequence **[owner]**: Codex is used through **Pi's native ChatGPT/Codex provider**; nothing custom is built to connect it. The `codex` CLI is not part of the runtime path.

### Platform
- Node's built-in `node:sqlite` (SQLite 3.51.2 in Node 24) supports FTS5 with `unicode61 remove_diacritics 2`; verified locally that "decision" matches "Decisión". No native build needed. It still emits an ExperimentalWarning **[builder]**: suppress for that warning only, and keep the store behind a port so it can be swapped.

## 5. Architecture

### 5.1 Shape **[call]**
One repository, one TypeScript package, three internal layers with enforced import boundaries (lint rule in CI), not a multi-package monorepo. Simplicity first; the boundaries are what enable a future server.

```
src/
  core/        domain + policies; NO Pi, NO filesystem-specific harness imports
               (tiers, task/run model, gate policy, memory model, eval model, roles)
  adapters/    implementations of core ports
               pi/        Pi extension entry, tools, commands, event hooks, subagent runner
               providers/ claude-bridge config, Pi native Codex provider config
               store/     node:sqlite memory store, file-based knowledge store
               vcs/       git + worktrees
               platform/  OS detection, paths, shell, scheduler (systemd / Task Scheduler)
  cli/         `factory` command: install, doctor, update, rollback, init, runs, eval, radar
skills/        factory skills (Agent Skills format, progressive disclosure)
prompts/       prompt templates
evals/         task suites, runners, baselines, reports
docs/          architecture, contracts, runbooks, specs
```

Rule: `core` depends on nothing in `adapters` or `cli`. Adapters depend on `core` ports. A future server hosts `core` plus adapters behind an API, with Pi talking to it over RPC; nothing in `core` changes.

### 5.2 Layers of configuration **[owner]** (shape), mechanics **[call]**

| Layer | Owner | Contains | Location |
|---|---|---|---|
| Core | Factory maintainer (owner) | Methodology, skills, prompts, agents/roles definitions, gate policy defaults, eval suites, default profiles | The installed, pinned factory package |
| Personal | Each user | Profile (role → model mapping), autonomy level, gate softening within allowed bounds, machine context (OS quirks, tools, paths), language for replies, radar on/off, parallelism limit | `~/.factory/` (config, memory DB, run ledger, radar state) |
| Project | Each repo | Project context, conventions, specs, decisions, task files, optional minimum factory version, project-specific overrides | `.factory/` in the project repo |

Resolution: core defaults ← personal ← project, deep-merged with a schema; **hard limits from core cannot be relaxed by any layer** (§8). Updates replace only the core layer. A `factory config explain <key>` command shows where each effective value came from **[call]**.

Factory state lives in `~/.factory/`, not inside `~/.pi/agent/`, so the factory is not welded to Pi's layout **[call]**. Pi-level settings that packages cannot ship (telemetry off, package list, shell, default tools) are written by the installer into Pi's global settings with **per-key ownership**: `~/.factory/managed-settings.json` records each key the factory set and the value it wrote. On update, a key is changed only if its current value still equals the last value the factory wrote; keys the user has edited are left alone and reported by `doctor`. Keys the factory never wrote are never touched.

## 6. Distribution, install, update, rollback

### 6.1 Artifacts
- The repo is both a **Pi package** (`pi` key in `package.json` pointing at built extension(s), `skills/`, `prompts/`) and the source of the `factory` CLI.
- Releases are semver git tags with a changelog. Private now **[owner]**: installed from git using each user's git credentials; switching to public npm later changes only the install source **[call]**.
- **Release manifest [call]**: every release contains `release.json` pinning **exact** versions: factory version, Pi version, `pi-claude-bridge` version (exact npm version or commit), and the lockfile of the factory's own dependencies. Installs are reproducible from the manifest; the "supported Pi range" (§6.3) only governs which versions the maintainer may pin in the next release, it is never resolved at install time.
- Verified: Pi installs a package's runtime `dependencies` when installing from npm or git (docs/packages.md); host packages go in `peerDependencies "*"`. Extensions ship as source Pi can load or as built JS committed in the release tag **[builder]** whichever Pi 1.x loads reliably on Windows and Linux (validated in the Phase 0 spike).

### 6.2 `factory` CLI **[call]**
Runs on Node (required by Pi anyway). **One supported install path**: `npm install -g git+https://github.com/<owner>/ai-factory.git#vX.Y.Z` puts a persistent `factory` command on PATH (user-level on Windows by default; on Linux the user's npm prefix), then `factory install` does the rest. The one-command form wraps both (`npx -y github:<owner>/ai-factory#vX.Y.Z install` installs the CLI globally and continues) **[builder]** final wrapper, validated in the Phase 0 spike on Windows and Linux.

- **Minimum requirements, not installed or configured by the factory [owner]**: Node ≥ 22.19 (the Pi minimum; `node:sqlite` FTS5 must work — doctor checks), Git (Git for Windows, which provides Git Bash, on Windows), git access to the private core repo, and each provider login done by the user (Claude Code `/login` for the Claude profile; Pi `/login` with ChatGPT for Codex). No admin rights needed for anything the factory does. A "clean machine" for the < 10 min target = an OS with these minimum requirements present.
- `factory install`
  1. Check minimum requirements and stop with exact instructions if any is missing. Pi itself is part of the factory stack, not a basic requirement: if missing or not the manifest's exact version, install that version with a user-level install **[call]**.
  2. Install the factory Pi package at the chosen version; install companion packages at the manifest's exact versions (`pi-claude-bridge` only when Claude is available).
  3. Write managed Pi settings (telemetry off, packages, tools).
  4. Detect provider logins (Claude Code logged in? Pi has a ChatGPT/Codex login?) and propose a profile.
  5. Create `~/.factory/` with personal config from the chosen profile.
  6. Run `factory doctor`.
- `factory doctor`: verifies everything above plus provider reachability, versions, writable dirs, SQLite FTS5; prints exact fix commands. Never needs sudo/admin.
- `factory update [--to <version>]`: shows changelog between current and target, asks for confirmation, refuses while factory sessions or runs are active (lock file + live-process check), backs up `~/.factory/` state (config, memory DB, managed-settings) to `~/.factory/backups/<from-version>/`, swaps the core layer, runs migrations, then doctor. Applies to all projects because projects reference the shared install, never a vendored copy **[owner]**.
- `factory rollback [<version>]`: reinstalls the previous version from its manifest and **restores the matching state backup**. Data written after the upgrade is kept only when the schema is compatible (below); otherwise rollback warns which data is lost and asks first.
- **Migration policy [call]**: personal state schemas (config, memory DB) are additive within a major version (new optional fields/tables only), so rollback within a major keeps all data. Breaking schema changes only in a major release, always with backup. Project artifacts (`.factory/knowledge/`) are plain Markdown with a `schema` version in frontmatter; the factory reads older versions and never mass-rewrites project files on update.
- **Launcher and handshake [call]**: Pi keeps running without a package that failed to install (docs/packages.md), which would leave a plain Pi session without factory gates. Therefore: users start the factory with `factory` (thin launcher: fast offline doctor, then `pi`). In addition, the factory extension performs a startup handshake (expected version, policy loaded, gate hook registered, store reachable); if the handshake fails, the session is marked unsafe and writing tools are blocked. A tiny guard extension installed outside the package (in Pi's global extensions dir) blocks write tools whenever the factory extension did not complete the handshake, covering the "package failed to load" case.
- `factory init` (in a repo): creates `.factory/` skeleton and Pi project settings if needed; asks before touching anything existing.
- `factory runs`, `factory eval`, `factory radar`, `factory config explain`: see later sections.

### 6.3 Compatibility
- The factory declares a supported Pi version range from which the maintainer picks the exact pinned version per release; CI tests the pinned version and the range bounds **[call]**.
- The radar alerts on new Pi / bridge releases; compatibility is verified by CI (deterministic tests against the new Pi version) plus a local smoke eval on the owner's server before widening the range.

### 6.4 Platforms **[owner]** + **[call]**
- **Windows native is first-class**, no WSL requirement. Linux first-class. macOS best-effort (not tested in CI unless cheap).
- Critical code (install, gates, memory, orchestration, evals) is TypeScript. Bash is allowed for model-issued commands and small peripheral helper scripts, which must be tested under Git Bash in CI. Reasons: Git Bash path translation, CRLF, slow process spawning on Windows, missing tools (`jq`), and the installer must run before Git Bash is confirmed.
- Hooks stay local and bounded: no network and no per-turn git scans (RSC-Harness hit Windows hook timeouts doing that).
- CI matrix: Linux and Windows runners, Node 22.19 (declared minimum, incl. `node:sqlite` FTS5 tests) and Node 24, including an install-from-scratch job measuring the < 10 min target.
- **Windows live qualification**: CI cannot run model-calling tests (§12.1), so every release has a manual **Windows live-smoke checklist** run by the owner on a Windows machine: install, login detection, one small task end-to-end with the codex-only profile, a hard-gate denial, cancellation, resume after killing the session.

## 7. Roles, providers, orchestration

### 7.1 Roles, not models **[owner]** (principle) / **[call]** (mapping)
Core defines roles; profiles map roles to `provider/model` and options. Shipped profiles:

| Role | `claude+codex` profile (owner) | `codex-only` profile (team) |
|---|---|---|
| Orchestrator | Claude Opus via `claude-bridge` | `gpt-6-astra` (or best available Codex model) |
| Implementer | Claude Opus (or Sonnet for low-risk tasks, if evals justify) | `gpt-6.1-sol` |
| Reviewer | `gpt-6.1-sol` (Codex) | `gpt-6.1-sol` in a fresh context, never having seen the implementation conversation |
| Researcher | cheapest model that preserves quality per evals | `gpt-6-luna` / `gpt-6.1-sol` |

Model names are data in the profiles; nothing in code hardcodes them. The radar only **proposes** profile changes; they reach users exclusively through an approved release, like any other core change. Every run and eval records the resolved model IDs and effective settings. With a single provider, review is less independent; compensate with fresh-context reviewers and stricter deterministic checks, and **evaluate both profiles**.

### 7.2 Provider adapters
- `ProviderPort` exposes: run a role turn (streaming events), usage and rate-limit signals, availability.
- Claude: `pi-claude-bridge` model inside a Pi process. Verified in the bridge README: Pi's tools are bridged to Claude Code (so Pi's `tool_call` hook sees them), and of the system-prompt routes, `before_agent_start` → `systemPrompt` is **dropped** while `systemPromptOptions.sections`, `message`, `context` and wrapping `context_with_system` edits reach Claude Code. Therefore **role instructions are delivered via `systemPromptOptions.sections`, never by replacing the system prompt** (this also works for native providers). One Pi session cannot span multiple bridge processes, so each subagent has its own session.
- No `claude -p` fallback runtime in the initial build **[call]**: it has a different tool and session contract and would need its own enforcement and equivalence proof. It is reconsidered only if the bridge becomes unusable (radar alert), behind the same `ProviderPort`.
- Codex: Pi's native ChatGPT/Codex provider for every role (orchestrator, implementer, reviewer, researcher) **[owner]**. All Codex roles therefore run as Pi processes with Pi-provided tools.

### 7.3 Orchestration
- The **orchestrator** is the user's interactive Pi session with the factory extension loaded.
- **Subagents** are separate Pi processes (`--mode rpc`) started by the factory's `SubagentRunner` (one runtime for every role and provider; the port allows others later). Each subagent is started with: role, model, role instructions (as prompt sections + skill refs), allowed tools, working directory (a worktree), and input artifacts **by reference** (spec/task file paths), never paraphrased (Gentle-AI measured paraphrased handoffs failing 13/26 checks).
- Delegation is **for a reason, not for size** **[call]**: large exploration that would flood the orchestrator's context, parallel writers on disjoint files, an independent reviewer, or a context backstop in long sessions. Otherwise the orchestrator works inline.
- **Parallelism**: global concurrency limit per machine in personal config (default 3 on the owner's server; lower default for laptops; `doctor` suggests a value from RAM) **[call]**.
- **Isolation**: each writing subagent works in its own git worktree under the project (e.g. `.factory/worktrees/<task>`; ignored by git) **[builder]** exact path. Git checkpoints at phase boundaries. Worktrees are reaped after integration.
- Every subagent returns a structured result (schema in core): status, summary, artifacts changed, evidence, open questions, usage.

### 7.4 Integration protocol **[call]**
- **Base**: worktrees are created from a committed base SHA recorded in the task file; the user's working tree is never used or modified. If it is dirty, the factory bases on `HEAD`, warns, and does not touch uncommitted changes.
- **Branches**: each task gets an integration branch `factory/<task>` from the base; each parallel writer gets a sub-branch `factory/<task>/<n>` in its own worktree, with an explicit, disjoint file scope assigned by the orchestrator.
- **Merge order**: sub-branches are merged into the integration branch sequentially in plan order. A conflict goes back to the owning writer (rebase on the current integration head) once; if it persists, the orchestrator resolves it inline and records a decision.
- **Combined candidate**: after all merges, the full verification (tests, checks, acceptance criteria) runs on the integration branch head, and *that* SHA is frozen for review (§9.4). Per-writer reviews are optional; the combined candidate review is mandatory.
- **Delivery**: integrating `factory/<task>` into the user's branch is a hard gate. Worktrees and branches are reaped only after successful integration (or explicit abandon).

### 7.5 Harness portability **[owner]** (goal, Pi first, no per-harness evals) / **[call]** (mechanics)
The core is harness-agnostic (§5.1); each harness gets a **harness adapter**. Pi's is built first and is the reference.

Designed in from the start so later adapters are cheap:
- Skills in the Agent Skills format (`SKILL.md`), understood by Pi, Claude Code and Codex.
- Project knowledge as plain Markdown in `.factory/knowledge/`.
- Memory exposed both as Pi native tools and as a local **MCP server** (stdio) over the same `MemoryPort`, since all three harnesses support MCP.
- `GatePolicy` as a pure core module callable from any harness's hook mechanism, and from a small CLI entry (`factory gate check`) for hook systems that run commands.
- The `factory` CLI, installer and evals are harness-independent.

Adapters (later phase, §15):
- **Claude Code**: a Claude Code plugin with the factory skills, role agents, `PreToolUse` hooks calling `GatePolicy`, the memory MCP server, and cross-provider review through the Codex plugin for Claude Code **[owner]** (Claude Code can call Codex via its plugin).
- **Codex**: skills, `AGENTS.md`, the memory MCP server, sandbox and approval policy configuration; **[verify]** what hook mechanism Codex offers for gate enforcement at the time. Codex has no native way to call Claude; codex-only users don't need it.

Each adapter declares a **capability matrix** (what is enforced in code vs only instructed: gates, subagents, worktrees, task-state durability, limits) shown by `factory doctor`. Methodology quality is not re-evaluated per harness **[owner]**, but each adapter must pass the deterministic gate test suite on its enforcement mechanism (no model calls, no subscription cost) **[call]**, because enforcement differs per harness even when the methodology is the same.

## 8. Gates and autonomy **[owner]** (shape), mechanics **[call]**

Principle: **the orchestrator decides; code enforces the hard limits as far as a tool hook can.** Prompt-level rules can be argued away or injected by malicious content (READMEs, issues, web pages); a `tool_call` hook cannot be argued with. But a hook only sees the submitted tool call: it cannot know every effect of an arbitrary shell command, build script or subprocess. Hard gates are therefore **guardrails enforced in code**, not a security boundary (§11), and the command policy (§8.1.1) narrows what may run unattended.

Scope: gates apply to **agent-requested actions** (tool calls made by any model). **Trusted factory operations** are outside the gate policy because they are the factory's own code, not model output: provider inference calls, writes to `~/.factory/` (memory, run ledger, backups), the radar's deterministic fetch, and Pi/provider authentication handled by their own login flows.

### 8.1 Hard gates (core policy, enforced in the Pi `tool_call` hook; no layer can relax them)
Require explicit human approval every time an agent requests:
- Destructive or irreversible operations: deleting outside the worktree, `git push --force`, history rewrites, `rm -rf` on non-temp paths, dropping data.
- **Publishing or mutating remote state**: `git push`, opening/commenting on PRs or issues, deploys, publishing packages, sending messages, non-GET HTTP requests to external services. Read-only research (web search/fetch, `git fetch`) is allowed.
- Reading or writing secrets/credentials (known secret paths, `.env`, auth files such as `~/.pi/agent/auth.json`, `~/.claude*`, `~/.codex/auth.json`). Provider authentication itself is a trusted operation and unaffected.
- Integrating into the user's branch.
- Writes outside the project root/worktree.

#### 8.1.1 Command policy
Shell commands are classified (read-only, local-write, destructive, remote-mutating, unknown). Unattended runs (subagents, high autonomy) may execute only read-only and local-write commands from an allowlist of supported operations (test runners, package-manager install from lockfile, build, linters, git local operations); anything else is `ask`. Interactive sessions follow the same classes, with `unknown → ask`. Known evasions (shell indirection, `eval`, encoded payloads, scripts writing outside the worktree) are part of the gate test suite, which tests bypass attempts as well as ordinary denials.

### 8.2 Soft gates (orchestrator decides within the autonomy level)
- Design approval before code (feature tier and above).
- New dependencies (well-known and maintained may pass; obscure, unmaintained or large stops).
- Deviations from the approved design (minor: resolve; changes what gets built: stop).
- Unresolved implementer/reviewer disagreement after the round limit.
- Subscription about to run out with work in flight.

Mandatory defaults per tier (owner-approved baseline): feature = stop at design approval and at delivery; small = stop at delivery only; project = design, end of each plan phase, delivery. A higher autonomy level lets the orchestrator skip soft gates when it judges it safe.

### 8.3 Conditions on autonomy
1. Every soft gate the orchestrator skips or resolves on its own is written to the **decision log** with justification and shown in the delivery report. It may skip, never hide.
2. Autonomous work happens in worktrees with checkpoints, so being wrong is cheap to undo.
3. Autonomy level (`low | medium | high`) is personal config; core default `medium`, owner sets `high`.
4. Skipped gates later corrected by the human at delivery are recorded and become an eval signal for the orchestrator's judgment.

### 8.4 Enforcement point **[call]**
`GatePolicy` lives in `core` once. With a single runtime (Pi processes for every role, §7.3) there is one enforcement point: the Pi `tool_call` hook. This covers Codex (native provider, Pi tools) and Claude (the bridge forwards Pi's tools to Claude Code, per its README). **[verify]** in the Phase 0 spike that Claude Code's own built-in tools are not exposed alongside Pi's through the bridge; if they are, the bridge must be configured to disable them or Claude cannot run writing roles.
In addition, a post-hoc audit of the worktree (changes outside the declared file scope, secret patterns, unexpected files) runs before a candidate can be frozen. It is a detector for mistakes, not a guarantee: it cannot see writes outside the worktree.
Rule: any future runtime that cannot apply `GatePolicy` to its tool calls may run only read-only roles.

### 8.5 Methodology enforcement in code (lesson from RSC-Harness)
Some methodology invariants are enforced, not just prompted **[call]**: e.g., in feature tier and above, writes to source files are blocked until a task file exists for the current task; a task cannot be reported done without an evidence section. Hooks that only remind must fire at most once per session and fail open.

## 9. Methodology **[call]** (owner approved the direction)

Draws on: Superpowers (TDD, evidence before claims, review discipline), Gentle-AI ODD/RDD (proportionality, delegate for a reason, frozen candidate review), RSC-Harness (announced lane, evidence-gated checklists, "Next" field, hooks over prose), Anthropic long-running harness guidance (progress file, one feature at a time, git checkpoints), OpenSpec (living specs with deltas).

### 9.1 Tiers, chosen by risk and blast radius, not line count
At the start of each request the orchestrator announces in one line the tier and why; the user can correct it immediately.

| Tier | When | Process | Gates |
|---|---|---|---|
| Answer | Questions, investigation, explanation | Read-only; no artifacts | none |
| Small | Clear behavior, low risk | Inline; TDD if a runnable test exists; evidence before claiming done | delivery |
| Feature | Several parts or some risk (auth, data, shared contracts, concurrency count as risk regardless of size) | Short design → task file → worktree → TDD implementation (inline or delegated) → independent review → verification | design, delivery |
| Project | Product or architectural change | Living spec + architecture notes → phased plan → per-phase feature loop | design, per phase, delivery |

A task that outgrows its tier is promoted without restarting (its task file becomes the seed of the spec).

### 9.2 Artifacts (in the product repo's `.factory/knowledge/`) **[call]**
- `specs/<slug>.md`: living spec (intent, requirements with acceptance criteria, design notes). Changes after approval are recorded as dated deltas.
- `tasks/<slug>.md`: task file, written before the first source change. Frontmatter `type, status (in-progress|blocked|done), author, branch, tier, spec`. Sections: Intent, Scope, Checklist (each item names what proves it), Evidence (observed output), Decisions (soft gates resolved), Next (single next step for resumption). "The checkbox is not the proof."
- `decisions/<date>-<slug>.md`: one file per decision (options considered → choice → why). Append-only; superseding decisions link back. One file each to avoid merge conflicts.
- `conventions.md`, `index.md`: project conventions and a short index for progressive disclosure.
- Format: Markdown + YAML frontmatter with a required `type` field and relative links, compatible with Obsidian and Open Knowledge Format readers.
- Task files are closed (`status: done`, merge info) by the delivery step, not left to the agent's memory.

### 9.3 Skills
Factory skills written fresh for this factory (Superpowers is MIT; adapted ideas are credited) **[call]**: classify, explore, design, plan, implement-tdd, debug, request-review, receive-review, verify, deliver, research, memory-protocol, evolve. Skills use progressive disclosure: only descriptions are always loaded. AGENTS-level always-on instructions stay short.

### 9.4 Review
- The candidate is **frozen** (a commit SHA in the worktree) before review.
- Reviewer gets: spec/task refs, the diff for that SHA, test evidence. Returns structured findings (severity, location, claim, suggested fix) per a JSON schema.
- The implementer/orchestrator evaluates each finding with technical rigor (no performative agreement), fixes or rebuts with evidence.
- Max 3 rounds **[call]**; then escalate to the human, or at high autonomy resolve and log the decision.
- Review is mandatory at feature tier and above, and for any change touching risk areas regardless of tier.

### 9.5 Delivery report
Summary, what changed, acceptance criteria with evidence, review findings and resolutions, decision log (incl. skipped soft gates), usage, and the integration action awaiting approval.

## 10. Memory and knowledge **[call]** (owner asked for ideas from Engram and RSC)

Three stores, each with a clear owner:

### 10.1 Project knowledge (shared, in repo)
§9.2 artifacts. Shared through normal PRs with the code. **Never auto-synced** across the team (RSC's auto-sync propagates wrong facts silently).

### 10.2 Operational memory (personal, local)
`~/.factory/memory.db` (`node:sqlite`, FTS5 with diacritic folding), behind `MemoryPort`.

- Observation: `id, type (decision|bugfix|discovery|pattern|config|preference|learning|session_summary), title, body (What/Why/Where/Learned), project, scope (project|personal|global), topic_key, created_at, updated_at, review_after, status (active|needs_review|superseded|deleted), superseded_by, revision_count, source (session/run id)`.
- Upsert by `project + scope + topic_key` (updates in place, bumps revision); exact-duplicate detection by content hash.
- `review_after` defaults by type (config/preference 3 months; discovery/pattern/decision 6; architecture/bugfix 12). Overdue → `needs_review`, still searchable, flagged; agents must verify before trusting. Never auto-deleted.
- On save, return conflict candidates (same topic or strong title overlap); the agent records a verdict (duplicate/supersedes/compatible).
- Consolidation is preview → confirm, never automatic rewriting.
- `<private>` spans stripped before persisting; secret patterns rejected.
- Write policy: "capture default is NO" — only durable, costly-to-reconstruct knowledge.

### 10.3 Factory learnings (global) — maintainer only **[owner]**
Learning about the factory itself lives only in the core. Consumers (the team) **use** the factory and do not spend subscription on learning, radar or evolution. On the maintainer's installation (a `maintainer` mode in personal config), learnings about how the factory works (not about a project) are stored with `scope: global, type: learning` and become **evolution candidates** (§12), entering the core only through the PR flow. Consumer installations do not capture global learnings, run the radar or run experiments; their operational memory (§10.2) still works for their own projects.

### 10.4 Read path
- Session start: inject a compact, byte-capped context (default ≤ 4 KB **[call]**): open task files' Next, pinned items, a few recent relevant observations for the current project.
- Tools: `mem_search` (compact results ~100 tokens each) → `mem_get` (full) ; `knowledge_index` (project index.md).
- Strict project resolution: never guess the project; ambiguity asks.

### 10.5 Durable progress (deterministic, incremental)
End-of-session hooks cannot guarantee anything: crashes, forced termination or exhausted quota prevent a final model turn. So durability does not depend on them:
- **Observed state is written by code, incrementally**: the extension updates the task file's machine section (phase, checklist items with evidence references, last checkpoint SHA, active worktrees, run id) at every phase change, checkpoint and completed checklist item. This is code, not model output.
- **Generated narrative is separate**: the model-written "Next" and session summary are refreshed at phase boundaries and opportunistically on `session_before_compact` / `agent_end`; when missing, the observed state is still enough to resume.
- **Reconcile on startup**: the launcher/extension finds runs with no terminal event in the run ledger, inspects the worktree and git state, marks them `interrupted`, and offers to resume from the last checkpoint.
- Compliance (open tasks always resumable) is measured in evals.

## 11. Security

Honest posture: **without containers there is no real sandbox; there are guardrails.** These protect against agent mistakes, not against a determined malicious payload. Pi's own docs say the same.

Guardrails:
- Hard gates (§8.1) in `tool_call`, scoped to agent-requested actions.
- Path policy: writes restricted to project root/worktrees; deny lists for secret paths.
- Command policy (§8.1.1): classified commands, allowlist for unattended runs, unknown → ask, bypass attempts in the test suite.
- Startup handshake + guard extension (§6.2): no writing work in a session where the factory's gates are not loaded.
- Worktrees + git checkpoints for reversibility.
- Prompt-injection hygiene: content fetched from the web/issues is marked untrusted in context; untrusted content cannot trigger hard-gated actions without human approval.
- Project trust: the factory never auto-trusts a repo's `.pi/` resources or `.factory/` overrides that would relax policy.
- Secrets never written to memory, knowledge, logs or eval reports; redaction on the run ledger.
- Optional container isolation in the owner's Linux personal layer **[call]**, never required.

## 12. Evaluation, radar, self-evolution

### 12.1 Evaluation system (foundation, not an add-on) **[owner]** need / **[call]** design
- **Task format**: repo snapshot (git URL/path + ref), prompt, tier, acceptance checks, optional rubric for an LLM judge (judge uses a different provider than the implementer when available), budget limits.
- **Isolation of withheld checks**: acceptance checks are stored outside anything the agent can reach (a separate directory not mounted into or referenced from the task workspace). The agent works in a fresh copy of the snapshot; after it finishes, the runner copies the resulting tree into a separate verification directory and runs the checks there. Calling tests "hidden" is not enough on a machine the agent can read, so withheld checks are only ever materialized after the agent process has exited.
- **Controlled conditions**: each run gets a fresh `~/.factory`-equivalent state directory (empty or a fixed seeded memory for memory tasks), a pinned configuration (factory version, profile, resolved model IDs), and fresh Pi session state. Contender order is randomized per task.
- **Suites**: `smoke` (few tasks, every core change), `full` (before every release), `memory` (cross-session recall tasks), `install` (clean-machine timing). Tasks are split into a **development** set (used while iterating and by self-evolution) and a **held-out** set (only used to confirm a candidate before a release, never to iterate on), to limit benchmark overfitting; the held-out set is refreshed with new tasks over time. Seeded with tasks from the owner's real projects (bugs/features already solved, with known solutions) plus a small set of public tasks **[builder]** which ones.
- **Contenders**: each factory profile is compared against baselines **on the same provider**, so cost is never compared across different subscriptions **[call]**:
  - `claude+codex` profile vs Claude Code default (`claude -p`), Claude Code + Superpowers, plain Pi (bridge provider, simple config).
  - `codex-only` profile vs Codex CLI default (`codex exec`), Codex + Superpowers, plain Pi (native Codex provider, simple config). The `codex` CLI appears here only as a baseline, not in the factory's runtime.
  - Quality metrics (pass rate, escaped defects) may be compared across profiles.
  - **Usage is always reported per provider**, summing every agent, subagent and retry. The `claude+codex` profile consumes two providers, so its comparison against single-provider Claude baselines is reported as two numbers (Claude usage vs baseline's Claude usage, plus the extra Codex usage), never as one "cheaper" figure. Efficiency claims for mixed profiles are made against an explicit per-provider resource budget.
  - Usage units: tokens per provider always; quota utilization (% of window) when the provider exposes it (Claude via bridge headers), marked `unknown` otherwise. Tokens are never presented as quota.
- **Human gates in evals**: answered by a scripted policy; count of gates hit is a metric.
- **Metrics**: pass rate, escaped defects, review findings, corrections, usage per provider, wall time, gates hit, resumability — per tier.
- **Statistics [call]**: paired comparisons per task (same task, same conditions, contender vs baseline). Smoke runs (n = 3) are only a regression alarm and never justify a superiority claim. Adoption decisions and release claims require the full dev suite with n ≥ 5 per task plus a held-out confirmation; a change is adopted only if the primary metric improves by more than a pre-registered threshold (default: +5 percentage points pass rate, or −15% usage at equal pass rate) with no secondary metric regressing beyond its threshold. Thresholds are core data, versioned.
- **Budget**: eval runs have their own subscription budget and prefer off-hours.
- **Where evals run [owner]**: model-calling evals run **only on the owner's always-on server**, with the owner's subscriptions, scheduled (systemd user timer) or on demand. No API keys in CI. GitHub Actions (Linux + Windows) runs only deterministic and mocked tests, plus the install test. Release gating = CI green **and** a local full-suite eval report attached to the release. Note: private-repo Actions minutes are limited and Windows minutes count double; keep CI lean.
- Reports are Markdown + JSON, stored with the run, attached to evolution PRs.

### 12.2 Radar **[owner]** approved direction
- Watchlist (data, editable): releases/changelogs of Pi, pi-claude-bridge, Claude Code, Codex CLI, Superpowers, Gentle-AI, RSC-Harness, OKF; Codex model list; Anthropic/OpenAI engineering posts; terms-of-service pages for the providers.
- `factory radar scan`: deterministic fetch and diff first (no model usage); only new items go to a headless Pi analysis with a usage budget.
- Output: triage into **try** (with a concrete hypothesis), **watch**, **ignore** (archived with reason, never re-proposed). Stored locally under `~/.factory/radar/` with history.
- **Alerts** surface immediately at next session start for breaking changes in Pi/bridge/CLI, security advisories in dependencies, or provider terms changes. Otherwise a one-line notice at session start ("3 new relevant items — /radar").
- `/radar <topic>` for on-demand deep research.
- Scheduling: systemd user timer on the maintainer's Linux server. **Runs only in maintainer mode [owner]**; consumer installations never run it.

### 12.3 Self-evolution **[owner]**
1. Candidates come from radar "try" items, the maintainer's global learnings, or the owner. Self-evolution runs only in maintainer mode.
2. The experiment runs in an isolated worktree of the factory repo (changes to skills, prompts, policies, profiles, code).
3. Eval suites run for baseline (current version) and candidate.
4. If better per §12.1, the factory opens a PR against the core repo with the hypothesis, the change, and the eval report. Opening the PR is itself a hard gate (leaves the machine).
5. The owner reviews and merges; a release (semver tag + changelog) is cut.
6. Users opt in with `factory update`; rollback is always available.
7. Failed experiments are recorded so they are not repeated without new evidence.

## 13. Reliability and observability

- **Run ledger**: `~/.factory/runs/<project>/<run-id>/events.jsonl` — phases, subagent spawns, tool-call summaries, gate decisions, usage, evidence, errors. Redacted. Feeds `/status`, `factory runs` and evals.
- **`/status`** (Pi command + TUI widget): tasks, phases, active agents, worktrees, usage and limits per provider.
- **Subscription limits**: limit status is a three-state signal per provider: `known` (utilization + reset), `unknown`, or `exhausted` (observed from 429/limit errors). Claude: the bridge documents passing Claude Code's `rate_limit_event` to `after_provider_response` as `anthropic-ratelimit-unified-*` headers (only the latest event is kept and may arrive one call late). Codex: **[verify]** what Pi's native provider exposes; `unknown` until proven. Users can also set factory usage budgets per provider in personal config, and a per-app weekly cap for Pi in ChatGPT settings. When a provider nears exhaustion or is observed exhausted: checkpoint and pause, or fail over the role to another provider if the profile allows; notify; resume when quota returns. Never stall silently.
- **Failure recovery**: incremental observed state (§10.5) + run ledger allow resuming after crashes or interrupted sessions. A crashed subagent is retried at most once, and only after reconciling its effects: the runner inspects the worktree and ledger, resumes from the last checkpoint, and never re-runs steps whose effects are already present (commits, created files, completed checklist items). Remote-mutating steps are never retried automatically (they are hard-gated anyway).
- **Health**: `factory doctor` also runs at Pi session start in a fast, offline mode.

## 14. Contracts (shapes; exact types **[builder]**)

```ts
// core ports
interface ProviderPort { runTurn(req: RoleTurnRequest): AsyncIterable<TurnEvent>; limits(): Promise<LimitStatus>; }
interface SubagentRunner { spawn(spec: SubagentSpec): Promise<SubagentResult>; }   // role, model, prompt refs, tools, cwd, inputs-by-ref
interface MemoryPort { search(q, opts); get(id); save(obs): SaveResult /* incl. conflict candidates */; review(...); consolidate(preview|confirm); }
interface KnowledgeStore { readIndex(); readArtifact(ref); writeArtifact(ref, doc); }
interface GatePolicy { evaluate(action: ToolAction, ctx: GateContext): Allow | Deny | Ask; }   // hard rules non-overridable
interface DecisionLog { record(d: Decision): void; }
interface RunLedger { append(e: RunEvent): void; }
interface VcsPort { worktreeCreate(task, baseSha, scope); checkpoint(msg); integrate(subBranch, intoBranch): MergeResult; freeze(): Sha; diff(sha); reap(task); }
interface Installer { install(manifest); update(toManifest); rollback(toVersion); handshake(): HandshakeResult; }
interface EvalRunner { run(suite, contender, opts): Promise<EvalReport>; }
```
Config, task-file frontmatter, subagent result, review findings, run events and eval reports each have a JSON Schema in `core`, versioned; migrations run on `factory update`.

## 15. Build order

Full scope stays **[owner]**: every capability in this document is built; phases only order construction by dependency and by risk. Feasibility questions go first, safety and recovery basics come before anything runs unattended, and each phase leaves an installable, usable factory. Each phase gets its own detailed plan (superpowers:writing-plans). Bootstrap with Claude Code + Superpowers; **from phase 5 onward the factory builds itself** (dogfooding) **[call]**.

| Phase | Delivers | Acceptance |
|---|---|---|
| 0. Feasibility spikes (throwaway) | Prove on Linux **and Windows**: private-git `pi install` with deps and the chosen extension format; persistent `factory` CLI via the install path; bridge tool forwarding through Pi's `tool_call` hook and absence of Claude Code built-in tools; role instructions via `systemPromptOptions.sections` on bridge and native Codex; Pi subagent over `--mode rpc` with native Codex; limit signals available per provider; `node:sqlite` FTS5 on Node 22.19 | Written spike report; every **[verify]** in this document resolved or the design updated |
| 1. Foundations | Repo, TS toolchain, layer lint, CI (Linux+Windows, Node 22.19/24), release manifest, Pi package skeleton, config layering + schemas + `config explain`, profiles, per-key managed settings, `factory install/doctor/update/rollback/init`, launcher + handshake + guard extension, migration/backup policy | CI install < 10 min on clean runners; update → rollback round-trip restores state; a broken package install leaves write tools blocked |
| 2. Safety and recovery basics | GatePolicy + command policy + `tool_call` enforcement, decision log, autonomy levels, run ledger, incremental task state, startup reconciliation | Gate suite incl. bypass attempts passes on both OSes; killing a session mid-task resumes from the last checkpoint |
| 3. Evaluation harness | Task format, isolated withheld checks, controlled state, dev/held-out split, runners for all same-provider baselines, per-provider usage, paired statistics, reports | Reproducible baseline report for all baselines on the smoke suite, both profiles |
| 4. Methodology, inline | Tier classifier, skills, artifacts, small and feature tiers inline (no delegation yet), independent review loop, delivery report, methodology invariants in code | Dev suite: small tier usage ≤ plain CLI per provider; factory ≥ best same-provider baseline on pass rate (held-out confirmed) |
| 5. Delegation and parallelism | SubagentRunner, worktrees, integration protocol (§7.4), concurrency limit, project tier | Feature/project tasks with parallel writers integrate, verify and review the combined candidate; no regression vs phase 4 |
| 6. Memory and knowledge | MemoryPort + SQLite store, knowledge store, read path, review/consolidation | Memory suite: cross-session recall tasks pass; measured gain vs no-memory |
| 7. Observability and limits | `/status`, three-state limits, budgets, failover, Windows live-smoke checklist in the release process | Simulated quota exhaustion recovers without lost work; first release passes the Windows live-smoke |
| 8. Radar and self-evolution | Watchlist, scan, triage, alerts, profile proposals, experiment pipeline, PR with eval report, release flow | One real improvement goes radar → experiment → eval → PR → release → opt-in update → rollback |
| 9. Claude Code and Codex adapters | Claude Code plugin and Codex configuration per §7.5, memory MCP server, `factory gate check`, capability matrix in doctor, install support for each harness | Deterministic gate suite passes on each adapter's enforcement mechanism; a small task completes end-to-end in each harness (manual smoke) |

## 16. Decisions by the owner (recap)
- Pi as harness; Claude (orchestrator/implementer, via Claude Bridge) + Codex/GPT Sol (reviewer) for the owner; codex-only profile for the team.
- Main motivation: reproducible distribution; core/personal/project layers; core updates never overwrite personal/project.
- Evolution via PR approved by the owner; opt-in updates applying to all projects.
- Feature checkpoints at design and delivery, with more orchestrator autonomy (soft gates decided by the orchestrator).
- Own methodology; ideas taken from Superpowers, Gentle-AI, RSC-Harness, Engram.
- Radar as proposed; success criteria as in §3.
- Windows (mostly) + Linux; no Docker on team machines; Git Bash acceptable.
- Python skeleton removed; language chosen by the architect (TypeScript).
- Private repository for now.
- Model-calling evals only on the owner's server; CI deterministic only.
- Minimum requirements (Node, Git/Git Bash, repo access, provider logins) are prerequisites; the factory does not install or configure them.
- Learning, radar and evolution live only in the core (maintainer mode); consumers only use the factory.
- Codex through Pi's native provider (tested by the owner; Pi listed by OpenAI as a Sign in with ChatGPT integration).
- Usable from Claude Code and Codex too, Pi first; improvements measured on Pi are assumed to carry over (no per-harness evals). Claude Code reaches Codex for review via its plugin.

## 17. Architect's calls to review
TypeScript single package with lint-enforced layers; `~/.factory/` for state; per-key ownership of managed Pi settings; release manifest with exact pins; one install path via global npm-from-git; launcher + handshake + guard extension; additive schemas within a major and backup-based rollback; single Pi runtime for all roles, no `claude -p` fallback initially; role instructions via prompt sections; integration protocol with combined-candidate review; gates scoped to agent-requested actions with command allowlist for unattended runs; incremental observed task state; isolated withheld eval checks, dev/held-out split, paired statistics with pre-registered thresholds, per-provider usage; build order with feasibility spikes first; telemetry off; own memory implementation (not Engram) behind `MemoryPort` with `node:sqlite`; knowledge in `.factory/knowledge/` shared only via PRs; Pi native Anthropic login excluded; Pi installed by the factory at the manifest's exact version (it is part of the stack, not a basic requirement); same-provider baselines; delegation for a reason; concurrency default 3; review max 3 rounds; autonomy default `medium`; context injection ≤ 4 KB; radar only in maintainer mode; web dashboard deferred to client-server; dogfooding from phase 5.

## 18. Left to the builder
Final one-command wrapper and extension artifact format (validated in the Phase 0 spikes); exact worktree path; eval public task selection and run counts beyond the minimums; TypeScript types for contracts; test framework and lint tooling; suppressing the `node:sqlite` experimental warning.

## 19. Risks
- **Provider terms** can change or be stricter than assumed. Claude via Agent SDK in a personal harness is billed to the subscription per official docs but not explicitly blessed; "ordinary, individual usage" may be stretched by heavy eval runs against Claude baselines. OpenAI currently lists Pi as a Sign in with ChatGPT integration, but commentators note the policy could tighten if third-party traffic becomes costly. Mitigation: provider adapters (a `claude -p` runtime can be added behind `ProviderPort` if needed), eval budgets, radar watching terms pages.
- **Pi churn** (weekly releases, recent repo move). Mitigation: exact pins in the release manifest, CI on the pinned version and range bounds, radar alerts.
- **Hard gates are guardrails**: a tool hook cannot see every effect of arbitrary commands. Mitigation: command allowlist for unattended runs, bypass tests, human gates for everything irreversible or remote.
- **`node:sqlite` experimental**. Mitigation: `MemoryPort`, small surface, tests.
- **Eval cost** on subscriptions. Mitigation: budgets, smoke vs full suites, off-hours.
- **Single-provider review weakness** for codex-only users. Mitigation: fresh-context reviewer, deterministic checks, measured per profile.
- **No sandbox on Windows**. Mitigation: guardrails stated honestly; human gates for everything irreversible or external.
