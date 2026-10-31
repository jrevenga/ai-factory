# Phase 0 — Feasibility Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every open **[verify]** item and every Phase 0 feasibility question in the design before any product code is written, and record the evidence in one spike report.

**Architecture:** Throwaway probes under `spikes/phase0/` run against an **isolated** Pi 1.4.0 install (own npm prefix, own `PI_CODING_AGENT_DIR`), never against the owner's real `~/.pi/agent` or global npm prefix. A spike Pi package lives on an orphan branch of the private repo and is installed by tag. Deterministic checks also run in a GitHub Actions matrix (Linux + Windows × Node 22.19 + 24); model-calling checks run on the owner's Linux server and, for Windows, through a short owner-run checklist.

**Tech Stack:** Node (22.19 and 24), Pi `@earendil-works/pi-coding-agent@1.4.0`, `pi-claude-bridge@0.9.3`, Pi native ChatGPT/Codex provider, `node:sqlite`, GitHub Actions, git worktrees.

**Spec:** `docs/superpowers/specs/2026-10-31-ai-factory-design.md` (architecture, §15 Phase 0) and `docs/superpowers/specs/2026-10-31-factory-methodology-design.md` (methodology). Executors read both.

## Global Constraints

- Pi version under test: exactly `1.4.0`. Bridge: exactly `pi-claude-bridge@0.9.3`. Record both in the report.
- Node minimum declared by the design: `22.19`; also test Node `24`.
- **Isolation**: every Pi invocation goes through `spikes/phase0/pi.mjs`, which sets `PI_CODING_AGENT_DIR=<repo>/spikes/phase0/.agent` and uses the Pi binary from `<repo>/spikes/phase0/.prefix`. Never read, write or print `~/.pi/agent/*` or any `auth.json`. `.agent/` and `.prefix/` are git-ignored.
- No `sudo`, no admin rights, no global installs outside a scratch npm prefix (`npm_config_prefix=<repo>/spikes/phase0/.npm-global`).
- No secrets in logs or the report: log response header **names** and only the values of rate-limit headers; never log request headers or tokens.
- Bridge runs with no `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` in the environment (bridge issue #107); `pi.mjs` deletes them from the child env.
- Spikes are throwaway (methodology §8 declared exception): no unit tests. Evidence = the exact command, its relevant output and exit code, pasted into the report.
- Model prompts in spikes are minimal (one or two short tool calls) to limit subscription usage.
- Outward-facing actions (creating the GitHub repo, pushing, tags, running CI) are hard gates: ask the owner first.
- Artifacts are in English.

## Review Focus

1. **Silent package-install failure** — Pi warns and keeps running when a package fails to install (docs/packages.md); a probe that "passes" because the package never loaded would be a false positive. Every package check must assert the package's marker, not just a zero exit code (Task 3).
2. **Private-repo auth on a clean machine** — git credentials missing or not used by npm/Pi; expected: a clear failure we can turn into a `doctor` message (Tasks 3, 4, 10).
3. **Windows quoting and paths** — Git Bash path translation, spaces in `PI_CODING_AGENT_DIR`, CRLF in scripts; expected: the probes behave identically on Windows (Tasks 2, 10).
4. **Isolation leak** — a spike touching the owner's real `~/.pi/agent`, global npm prefix or user working tree; expected: none (Task 1 adds a guard that aborts if `PI_CODING_AGENT_DIR` resolves to `~/.pi/agent`).
5. **Secrets in captured headers or transcripts** — expected: header names plus rate-limit values only (Task 6 filters).

---

### Task 1: Spike workspace, isolated Pi and report skeleton

**Files:**
- Create: `spikes/phase0/README.md` — how to run each probe, isolation rules, owner actions.
- Create: `spikes/phase0/pi.mjs` — isolated Pi launcher.
- Create: `spikes/phase0/.gitignore` — `.agent/`, `.prefix/`, `.npm-global/`, `out/`.
- Create: `docs/superpowers/spikes/2026-10-31-phase0-report.md` — report skeleton.

**Interfaces:**
- Produces: `node spikes/phase0/pi.mjs <pi args...>` runs Pi 1.4.0 with `PI_CODING_AGENT_DIR=spikes/phase0/.agent`, cwd unchanged, `ANTHROPIC_*` removed, exit code passed through. Exported `runPi(args: string[], opts?: { cwd?: string; env?: Record<string,string>; input?: string }): Promise<{ code: number; stdout: string; stderr: string }>`.
- Produces: report sections `S1`–`S10` (below), each with *Question / Method / Evidence / Verdict / Design impact*.

- [ ] **Step 1: Install Pi 1.4.0 into the scratch prefix**

Run: `npm install --prefix spikes/phase0/.prefix --ignore-scripts @earendil-works/pi-coding-agent@1.4.0`
Expected: exit 0; `spikes/phase0/.prefix/node_modules/.bin/pi` exists.

- [ ] **Step 2: Write `pi.mjs`**

Resolves the binary from `.prefix/node_modules/.bin/pi` (`pi.cmd` on Windows), sets the env as in Global Constraints, aborts with exit 2 if the resolved agent dir equals `os.homedir()/.pi/agent`, and spawns with `shell: false`.

- [ ] **Step 3: Verify isolation**

Run: `node spikes/phase0/pi.mjs --version` then `ls spikes/phase0/.agent`
Expected: `1.4.0`; the `.agent` directory was created by Pi; `~/.pi/agent/settings.json` modification time unchanged (record before/after `stat`).

- [ ] **Step 4: Write the report skeleton**

Sections: `S1 sqlite`, `S2 package from private git`, `S3 CLI install path`, `S4 bridge tools and gates`, `S5 prompt sections`, `S6 limit signals`, `S7 RPC subagent`, `S8 input/steering lifecycle`, `S9 Codex CLI hooks (desk check)`, `S10 Windows`. Header records date, host OS, Node versions, Pi and bridge versions.

- [ ] **Step 5: Commit**

```bash
git add spikes/phase0/README.md spikes/phase0/pi.mjs spikes/phase0/.gitignore docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): add isolated Pi workspace and phase 0 report skeleton"
```

---

### Task 2: S1 — `node:sqlite` FTS5 with diacritic folding

**Files:**
- Create: `spikes/phase0/sqlite-fts.mjs`

**Interfaces:**
- Produces: `node spikes/phase0/sqlite-fts.mjs` prints one JSON line `{"node": "<version>", "sqlite": "<version>", "fts5": true|false, "accentFolding": true|false, "warning": "<ExperimentalWarning text or null>"}` and exits 0 only when both booleans are true.

- [ ] **Step 1: Write the probe**

In-memory DB; `CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize="unicode61 remove_diacritics 2")`; insert `("Decisión de autenticación", "Usamos sesiones con migración en caché")`; `accentFolding` is true only if each of `decision`, `autenticacion`, `migracion`, `Decisión`, `cache` matches exactly 1 row. Capture the `ExperimentalWarning` via `process.on('warning')`.

- [ ] **Step 2: Run on Node 24 (local)**

Run: `node spikes/phase0/sqlite-fts.mjs`
Expected: exit 0, `"fts5":true,"accentFolding":true`.

- [ ] **Step 3: Run on Node 22.19**

Run: `npx -y node@22.19.0 spikes/phase0/sqlite-fts.mjs`
Expected: exit 0 with both true. If `node:sqlite` needs a flag on 22.19, record the exact flag/behavior; that is a design impact on the Node minimum (architecture §4, §6.2).

- [ ] **Step 4: Record S1 and commit**

```bash
git add spikes/phase0/sqlite-fts.mjs docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): verify node:sqlite FTS5 accent folding (S1)"
```

---

### Task 3: Private repo and S2 — Pi package from private git

**Files:**
- Create (orphan branch `spike/pkg`, not on `master`): `package.json`, `extensions/probe.ts`, `bin/factory-spike.mjs`.
- Modify: report S2.

**Interfaces:**
- Consumes: `runPi` (Task 1).
- Produces: tag `spike-pkg-v0.1.0` on `github.com/jrevenga/ai-factory` (private); package `ai-factory-spike` with `keywords: ["pi-package"]`, `pi.extensions: ["./extensions/probe.ts"]`, `dependencies: { "ms": "2.1.3" }`, `peerDependencies: { "@earendil-works/pi-coding-agent": "*" }`, `bin: { "factory-spike": "bin/factory-spike.mjs" }`.
- Produces: `extensions/probe.ts` — on `session_start` writes `process.env.SPIKE_MARKER` (a file path) with JSON `{"loaded": true, "ms": ms("2h")}` (expected `7200000`); emits `pi.events.emit("factory:handshake", { version: "0.1.0" })`.

- [ ] **Step 1: Owner approval for the private repo (hard gate)**

Ask the owner to approve: `gh repo create jrevenga/ai-factory --private --source . --remote origin --push`. Do not proceed without approval.

- [ ] **Step 2: Create the orphan branch with the spike package and push the tag (after approval)**

Run: `git switch --orphan spike/pkg`, add the three files, commit, `git tag spike-pkg-v0.1.0`, `git push origin spike/pkg spike-pkg-v0.1.0`, `git switch master`.
Expected: tag visible with `git ls-remote --tags origin`.

- [ ] **Step 3: Install by tag into the isolated agent dir**

Run: `node spikes/phase0/pi.mjs install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0` then `node spikes/phase0/pi.mjs list`
Expected: exit 0; the package listed with ref `spike-pkg-v0.1.0`; `ms` present under the installed package's `node_modules` (record path).

- [ ] **Step 4: Prove the extension loads (TS via jiti, dependency resolved) without a model call**

Start `node spikes/phase0/pi.mjs --mode rpc --no-session` with `SPIKE_MARKER=spikes/phase0/out/marker.json`, send `{"id":"1","type":"get_state"}`, read the response, close stdin.
Expected: `marker.json` contains `{"loaded":true,"ms":7200000}`. A zero exit without the marker is a **failure** (Review Focus 1).

- [ ] **Step 5: Prove failure behavior (Review Focus 1, 2)**

Run: `node spikes/phase0/pi.mjs install git:github.com/jrevenga/ai-factory@does-not-exist` and record the exit code; then start an RPC session with a settings entry pointing at the bad ref and record whether Pi starts without the package and what warning it prints.
Expected per docs: `pi install` exits non-zero; startup warns and continues. Record exact messages for `factory doctor` and the guard-extension design (architecture §6.2).

- [ ] **Step 6: Record S2 (incl. extension format decision: TS source via jiti is sufficient, or built JS needed) and commit on master**

```bash
git add docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): verify Pi package install from private git (S2)"
```

---

### Task 4: S3 — Persistent `factory` CLI install path

**Files:**
- Modify: report S3.

**Interfaces:**
- Consumes: tag `spike-pkg-v0.1.0` with `bin/factory-spike.mjs` (prints `factory-spike ok <node version>`).

- [ ] **Step 1: Global install from private git into the scratch prefix**

Run: `npm_config_prefix=spikes/phase0/.npm-global npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0`
Expected: exit 0; `spikes/phase0/.npm-global/bin/factory-spike` exists and prints `factory-spike ok v24…`. Record whether npm ran a build/prepare step and how long the install took.

- [ ] **Step 2: One-command form**

Run: `npm_config_prefix=spikes/phase0/.npm-global npx -y github:jrevenga/ai-factory#spike-pkg-v0.1.0`
Expected: runs `factory-spike` and prints the same line. Record whether `npx` can also leave a persistent install (design §6.2 one-command wrapper).

- [ ] **Step 3: Record S3 and commit**

```bash
git add docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): verify global CLI install from private git (S3)"
```

---

### Task 5: S4 + S5 — Gate hook and prompt sections through the bridge and native Codex

**Files:**
- Create: `spikes/phase0/gate-probe.ts` — local extension loaded with `--extension`.
- Modify: report S4, S5.

**Interfaces:**
- Consumes: `runPi`.
- Produces: `gate-probe.ts`:
  - `tool_call`: appends `{ts, toolName, inputKeys}` to `process.env.SPIKE_TOOLLOG` (JSONL); returns `{ block: true, reason: "spike gate" }` when `toolName` is `write` or `edit` and `process.env.SPIKE_BLOCK_WRITES === "1"`.
  - `before_agent_start`: mutates `event.systemPromptOptions` to add a section named `spike-role` with text `End every final answer with the word PINEAPPLE.` (follow `examples/extensions/prompt-customizer.ts` for the exact field shape; read `src/core/extensions/types.ts` at tag v1.4.0).

- [ ] **Step 1: Owner action — log in to Codex in the isolated agent dir**

Owner runs `node spikes/phase0/pi.mjs` interactively, `/login` → ChatGPT, then exits. Claude needs no action (bridge uses the existing Claude Code login).

- [ ] **Step 2: Install the bridge pinned and discover model ids**

Run: `node spikes/phase0/pi.mjs install npm:pi-claude-bridge@0.9.3`, then list models (`/model` in an interactive session, or the CLI listing flag if present) and record the exact ids for Claude Opus via `claude-bridge` and for `gpt-6.1-sol` via the native Codex provider.

- [ ] **Step 3: Bridge — tools visible to the hook, sections delivered**

In a fresh temp dir (`mktemp -d`), run: `node spikes/phase0/pi.mjs -p --no-session --model <claude-bridge opus id> --extension spikes/phase0/gate-probe.ts "Run the shell command: ls. Then answer in one sentence."` with `SPIKE_TOOLLOG=<tmp>/tools.jsonl`.
Expected: `tools.jsonl` has a `bash` entry (Pi tool names, lower-case); the answer ends with `PINEAPPLE` (S5 for bridge).

- [ ] **Step 4: Bridge — block works and no Claude Code built-in tool bypasses it**

Same dir, `SPIKE_BLOCK_WRITES=1`, prompt: `Create a file named created.txt containing hello. Use any tool you have.`
Expected: `created.txt` does **not** exist; `tools.jsonl` shows the blocked `write` (or `bash` attempt). If the file exists while no corresponding `tool_call` was logged, Claude Code built-in tools are executing outside Pi → record, then check the bridge's documented option to disable Claude Code built-in tools and repeat (architecture §8.4 [verify]).

- [ ] **Step 5: Native Codex — repeat Steps 3–4 with the `gpt-6.1-sol` id**

Expected: same results. Record any difference.

- [ ] **Step 6: Record S4, S5 and commit**

```bash
git add spikes/phase0/gate-probe.ts docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): verify tool gate and prompt sections on bridge and Codex (S4, S5)"
```

---

### Task 6: S6 — Subscription limit signals per provider

**Files:**
- Modify: `spikes/phase0/gate-probe.ts` — add an `after_provider_response` handler.
- Modify: report S6.

**Interfaces:**
- Produces: handler appends `{ts, provider, model, status, headerNames, rateLimit}` to `process.env.SPIKE_HEADERLOG`, where `rateLimit` contains only headers whose name matches `/ratelimit|rate-limit|retry-after|usage|quota/i` (Review Focus 5).

- [ ] **Step 1: Run one minimal prompt per provider**

Run (per provider): `node spikes/phase0/pi.mjs -p --no-session --model <id> --extension spikes/phase0/gate-probe.ts "Say ok."` with `SPIKE_HEADERLOG=spikes/phase0/out/headers-<provider>.jsonl`.
Expected: bridge → `anthropic-ratelimit-unified-*` names present (possibly one call late, per bridge README); Codex → record whatever rate/usage headers appear, or none.

- [ ] **Step 2: Record S6 (three-state limit signal feasibility per provider: known / unknown / exhausted-on-error) and commit**

```bash
git add spikes/phase0/gate-probe.ts docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): record provider limit signals (S6)"
```

---

### Task 7: S7 — Subagent over RPC with native Codex in a worktree

**Files:**
- Create: `spikes/phase0/rpc-subagent.mjs`
- Modify: report S7.

**Interfaces:**
- Consumes: `RpcClient` exported by `@earendil-works/pi-coding-agent@1.4.0` (from `.prefix`; see `src/modes/rpc/rpc-client.ts` at v1.4.0), `gate-probe.ts`.
- Produces: `node spikes/phase0/rpc-subagent.mjs <worktreePath> <modelId>` spawns `pi --mode rpc --no-session --model <modelId> --extension gate-probe.ts` with `cwd=<worktreePath>` and the isolated agent dir, sends one prompt with `promptAndWait`, waits for `agent_settled`, prints `{final, toolCalls, durationMs, usage}`.

- [ ] **Step 1: Create a scratch worktree of this repo**

Run: `git worktree add ../ai-factory-spike-wt -b spike/wt master`
Expected: worktree exists.

- [ ] **Step 2: Run the subagent**

Run: `node spikes/phase0/rpc-subagent.mjs ../ai-factory-spike-wt <gpt-6.1-sol id>` with prompt `Read README.md if it exists, otherwise list the files, and summarize in one sentence.`
Expected: `final` ends with `PINEAPPLE` (role section works in a subagent); tool calls logged from the child (hook active in subagents); `usage` present.

- [ ] **Step 3: Remove the scratch worktree**

Run: `git worktree remove ../ai-factory-spike-wt && git branch -D spike/wt`
Expected: clean `git worktree list`.

- [ ] **Step 4: Record S7 and commit**

```bash
git add spikes/phase0/rpc-subagent.mjs docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): verify RPC subagent with native Codex (S7)"
```

---

### Task 8: S8 — Input, steering and follow-up lifecycle

**Files:**
- Create: `spikes/phase0/lifecycle-probe.ts`
- Create: `spikes/phase0/rpc-steer.mjs`
- Modify: report S8.

**Interfaces:**
- Produces: `lifecycle-probe.ts` appends `{ts, event, detail}` to `process.env.SPIKE_EVENTLOG` for `input`, `before_agent_start`, `agent_start`, `turn_start`, `message_start`/`message_end` (role only), `agent_end`, `agent_settled`.
- Produces: `rpc-steer.mjs <modelId>` sends a `prompt` that makes the model run `sleep 5` via bash, then during the run sends a steering message and a follow-up message (RPC commands per `docs/rpc-commands.md` at v1.4.0), and waits for `agent_settled`.

- [ ] **Step 1: Run and capture the event log**

Run: `node spikes/phase0/rpc-steer.mjs <gpt-6.1-sol id>` with `SPIKE_EVENTLOG=spikes/phase0/out/events.jsonl`.
Expected: the log shows whether steering/follow-up fire `input` and whether they fire `before_agent_start` (the final review says they do not); identify the event that marks consumption of a queued input (e.g. `message_start` with role `user`).

- [ ] **Step 2: Record S8 with the concrete mechanism for `needs_reclassification` (methodology §3.4 [verify]) and commit**

```bash
git add spikes/phase0/lifecycle-probe.ts spikes/phase0/rpc-steer.mjs docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): map input and steering lifecycle (S8)"
```

---

### Task 9: S9 — Codex CLI hook mechanism (desk check)

**Files:**
- Modify: report S9.

- [ ] **Step 1: Inspect Codex CLI 0.163.0 capabilities**

Run: `codex --help`, `codex exec --help`, `codex features list` (if present), and read the official Codex docs on hooks/approvals/sandbox (Context7 or developers.openai.com).
Expected: a statement of what hook or approval mechanism exists for gating tool calls, with sources, for the future Codex adapter (architecture §7.5 [verify]). No implementation.

- [ ] **Step 2: Record S9 and commit**

```bash
git add docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "docs(spike): record Codex CLI hook capabilities (S9)"
```

---

### Task 10: S10 — Windows: CI matrix and owner checklist

**Files:**
- Create: `.github/workflows/spike-phase0.yml` (`workflow_dispatch` only)
- Create: `spikes/phase0/ci-checks.mjs`
- Create: `spikes/phase0/windows-checklist.md`
- Modify: report S10.

**Interfaces:**
- Consumes: `sqlite-fts.mjs`, `pi.mjs`, tag `spike-pkg-v0.1.0`.
- Produces: `node spikes/phase0/ci-checks.mjs` runs, in order, S1 probe, isolated Pi install, Task 3 Step 3–4 (install by tag + marker), Task 4 Step 1 (CLI install + run), and prints one JSON summary `{checks: [{name, ok, ms, detail}], totalMs}`; exit 0 only if all ok.
- Workflow: matrix `os: [ubuntu-latest, windows-latest]` × `node: ["22.19.0", "24"]`; configures git to use `${{ github.token }}` for `https://github.com/jrevenga/` (`git config --global url."https://x-access-token:${{ github.token }}@github.com/".insteadOf "https://github.com/"`), runs `ci-checks.mjs` under Git Bash on Windows (`shell: bash`).

- [ ] **Step 1: Write `ci-checks.mjs`, the workflow and the checklist**

Checklist (owner, on a Windows machine with Git for Windows and Node ≥ 22.19): clone, `node spikes/phase0/ci-checks.mjs`; `node spikes/phase0/pi.mjs` → `/login` ChatGPT; Task 5 Steps 3–5 with the Codex id only; Task 7 Step 2 with a Windows temp worktree; confirm Pi's `bash` tool runs through Git Bash (`!printf 'Bash is working\n'`); paste outputs into report S10.

- [ ] **Step 2: Owner approval, then push and dispatch (hard gate)**

Run (after approval): `git push origin master && gh workflow run spike-phase0.yml && gh run watch`
Expected: all four matrix jobs green; record each `totalMs` (input to the < 10 min install target) and any Windows-specific failure.

- [ ] **Step 3: Owner runs the Windows checklist**

Expected: all items pass, or failures recorded with output.

- [ ] **Step 4: Record S10 and commit**

```bash
git add .github/workflows/spike-phase0.yml spikes/phase0/ci-checks.mjs spikes/phase0/windows-checklist.md docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): Windows CI matrix and owner checklist (S10)"
```

---

### Task 11: Close Phase 0 — update the design from the evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-10-31-ai-factory-design.md`
- Modify: `docs/superpowers/specs/2026-10-31-factory-methodology-design.md`
- Modify: report — summary table.

- [ ] **Step 1: Summary table in the report**

One row per question S1–S10 and per **[verify]** marker in both specs: verdict (`confirmed | changed | blocked`), evidence section, design change.

- [ ] **Step 2: Apply design changes**

For each `changed` row, edit the spec section it names; replace each resolved **[verify]** with the verified fact and a link to the report section. A `blocked` row is raised with the owner before Phase 1 planning.

- [ ] **Step 3: Verify no unresolved markers remain**

Run: `grep -n "\[verify\]" docs/superpowers/specs/*.md`
Expected: only the notation-legend lines (line 7 of each spec), or markers explicitly deferred with the owner's agreement.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "docs: resolve phase 0 verify items from spike evidence"
```
