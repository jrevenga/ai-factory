# Phase 0 — Feasibility Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every open **[verify]** item and every Phase 0 feasibility question in the design before any product code is written, and record the evidence in one spike report.

**Architecture:** Throwaway probes under `spikes/phase0/` run against an **isolated** Pi 1.4.0 install (own npm prefix, own `PI_CODING_AGENT_DIR`), never against the owner's real `~/.pi/agent` or global npm prefix. A spike Pi package lives on an orphan branch of the private repo and is installed by tag. Deterministic checks also run in a GitHub Actions matrix (Linux + Windows × Node 22.19 + 24); model-calling checks run on the owner's Linux server and, for Windows, through a short owner-run checklist.

**Tech Stack:** Node (22.19 and 24), Pi `@earendil-works/pi-coding-agent@1.4.0`, `pi-claude-bridge@0.9.3`, Pi native ChatGPT/Codex provider, `node:sqlite`, GitHub Actions, git worktrees.

**Spec:** `docs/superpowers/specs/2026-10-31-ai-factory-design.md` (architecture, §15 Phase 0) and `docs/superpowers/specs/2026-10-31-factory-methodology-design.md` (methodology). Executors read both.

## Global Constraints

- Pi version under test: exactly `1.4.0`. Bridge: exactly `pi-claude-bridge@0.9.3`. Record both in the report.
- Node minimum declared by the design: `22.19`; also test Node `24`.
- **Isolation**: every Pi invocation (including RPC children) goes through `spikes/phase0/pi.mjs`, which forces `PI_CODING_AGENT_DIR=<repo>/spikes/phase0/.agent`, `PI_CODING_AGENT_SESSION_DIR=<repo>/spikes/phase0/.agent/sessions` (Pi honours it independently of the agent dir — `src/main.ts` v1.4.0), and `npm_config_prefix=<repo>/spikes/phase0/.npm-global`, and refuses to start unless all three resolve inside `spikes/phase0/`. Paths are resolved from the launcher's own location (`import.meta.url`), never from the cwd. Never read, write or print `~/.pi/agent/*` or any `auth.json`. `.agent*/`, `.prefix/`, `.npm-global*/` and `out/` are git-ignored.
- No `sudo`, no admin rights, no global installs outside a scratch npm prefix.
- **Non-inference RPC probes pass an explicit catalog model** (`--model openai-codex/gpt-6.1-sol`; if Pi's catalog spells it differently, use the catalog id and record it): without authentication or an explicit model Pi selects no model and exits before RPC initialization (`model-resolver.ts`, `main.ts` v1.4.0). Such probes send only `get_state` and never prompt, so no inference or login is needed.
- **Fresh state per evidence**: every marker carries a per-run nonce and is deleted before the run; failure scenarios use their own empty agent dir and prefix (`.agent-<scenario>`, `.npm-global-<scenario>`), because Pi's git checkout path does not include the ref and a previous valid checkout could otherwise be loaded (`src/core/package-manager.ts` v1.4.0).
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
- Create: `spikes/phase0/npm.mjs` — isolated npm/npx runner.
- Create: `spikes/phase0/.gitignore` — `.agent*/`, `.prefix/`, `.npm-global*/`, `out/`.
- Create: `docs/superpowers/spikes/2026-10-31-phase0-report.md` — report skeleton.

**Interfaces:**
- Produces: `node spikes/phase0/pi.mjs <pi args...>` runs Pi 1.4.0 with the isolated env (Global Constraints), `ANTHROPIC_*` removed, exit code passed through. It spawns `process.execPath` with Pi's **JavaScript bin entry** (resolved from `.prefix/node_modules/@earendil-works/pi-coding-agent/package.json` → `bin`), never `pi.cmd`, so it works on Windows with `shell: false`.
- Produces: exported `runPi(args: string[], opts?: { cwd?: string; env?: Record<string,string>; input?: string; scenario?: string }): Promise<{ code: number; stdout: string; stderr: string }>` (`scenario` switches to `.agent-<scenario>` / `.npm-global-<scenario>`), and exported `SPIKE = { root, launcher, agentDir, out }` absolute paths for other probes. `pi.mjs` is also usable as `RpcClient`'s `cliPath`.
- Produces: `node spikes/phase0/npm.mjs <scenario> <npm|npx> <args...>` and exported `runNpm(tool: "npm" | "npx", args: string[], opts: { scenario: string; env?: Record<string,string> }): Promise<{ code: number; stdout: string; stderr: string }>`. It forces `npm_config_prefix=<root>/.npm-global-<scenario>` and `npm_config_cache=<root>/out/npm-cache-<scenario>`, refuses to start unless both resolve inside `spikes/phase0/`, and invokes npm's JS entry (`npm-cli.js` / `npx-cli.js` next to `process.execPath`'s npm install) with `process.execPath`, `shell: false`. **Every npm/npx command in this plan, other than Task 1 Step 1's local `--prefix` install, goes through `npm.mjs`.**
- Produces: report sections `S1`–`S10` (below), each with *Question / Method / Evidence / Verdict / Design impact*.

- [ ] **Step 1: Install Pi 1.4.0 into the scratch prefix**

Run: `npm install --prefix spikes/phase0/.prefix --ignore-scripts @earendil-works/pi-coding-agent@1.4.0`
Expected: exit 0; `spikes/phase0/.prefix/node_modules/.bin/pi` exists.

- [ ] **Step 2: Write `pi.mjs`**

As specified in Interfaces; exits 2 with a clear message if any isolated path resolves outside `spikes/phase0/` or equals `os.homedir()/.pi/agent`.

- [ ] **Step 3: Verify isolation with a real runtime start (no model call)**

Version: `node spikes/phase0/pi.mjs --version` → `1.4.0` (this exits before runtime initialization, so it checks the binary only). Runtime: record `stat` of `~/.pi/agent` (dir and files) before; start `node spikes/phase0/pi.mjs --mode rpc --model openai-codex/gpt-6.1-sol` (sessions enabled), send `{"id":"1","type":"get_state"}`, read the response, close stdin; record `stat` after.
Expected: `get_state` succeeds and its `sessionFile` path lies under `spikes/phase0/.agent/sessions/` (an empty session writes no file until a message exists — `session-manager.ts` v1.4.0 — so actual persistence is asserted in Task 6); any new files appear only under `spikes/phase0/.agent/`; nothing under `~/.pi/agent` changed.

- [ ] **Step 4: Write the report skeleton**

Sections: `S1 sqlite`, `S2 package from private git`, `S3 CLI install path`, `S4 bridge tools and gates`, `S5 prompt sections`, `S6 limit signals`, `S7 RPC subagent`, `S8 input/steering lifecycle`, `S9 Codex CLI hooks (desk check)`, `S10 Windows`. Header records date, host OS, Node versions, Pi and bridge versions.

- [ ] **Step 5: Commit**

```bash
git add spikes/phase0/README.md spikes/phase0/pi.mjs spikes/phase0/npm.mjs spikes/phase0/.gitignore docs/superpowers/spikes/2026-10-31-phase0-report.md
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
- Produces: `extensions/probe.ts` — on `session_start` writes `process.env.SPIKE_MARKER` (a file path) with JSON `{"loaded": true, "nonce": process.env.SPIKE_NONCE, "ms": ms("2h")}` (expected `7200000`); emits `pi.events.emit("factory:handshake", { version: "0.1.0" })`.
- Produces: `bin/factory-spike.mjs` — no argument: prints `factory-spike ok <node version>`; `install`: runs `npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0` (inheriting `npm_config_prefix`) and exits with npm's code, simulating the one-command bootstrap's self-install.

- [ ] **Step 1: Owner approval for the private repo (hard gate)**

Ask the owner to approve: `gh repo create jrevenga/ai-factory --private --source . --remote origin --push`. Do not proceed without approval.

- [ ] **Step 2: Create the orphan branch with the spike package and push the tag (after approval)**

Run: `git switch --orphan spike/pkg`, add the three files, commit, `git tag spike-pkg-v0.1.0`, `git push origin spike/pkg spike-pkg-v0.1.0`, `git switch master`.
Expected: tag visible with `git ls-remote --tags origin`.

- [ ] **Step 3: Install by tag into the isolated agent dir**

Run: `node spikes/phase0/pi.mjs install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0` then `node spikes/phase0/pi.mjs list`
Expected: exit 0; the package listed with ref `spike-pkg-v0.1.0`; `ms` present under the installed package's `node_modules` (record path).

- [ ] **Step 4: Prove the extension loads (TS via jiti, dependency resolved) without a model call**

Delete `spikes/phase0/out/marker.json`; generate a nonce; start `node spikes/phase0/pi.mjs --mode rpc --no-session --model openai-codex/gpt-6.1-sol` with `SPIKE_MARKER=<abs>/out/marker.json` and `SPIKE_NONCE=<nonce>`, send `{"id":"1","type":"get_state"}`, read the response, close stdin.
Expected: `marker.json` exists and contains `{"loaded":true,"nonce":"<this nonce>","ms":7200000}`. A zero exit without a marker carrying this run's nonce is a **failure** (Review Focus 1).

- [ ] **Step 5: Prove failure behavior with fresh state (Review Focus 1)**

Scenario `badref` (empty `.agent-badref`): run `pi install git:github.com/jrevenga/ai-factory@does-not-exist`, record exit code and message. Then write `.agent-badref/settings.json` with `packages: ["git:github.com/jrevenga/ai-factory@does-not-exist"]`, start an RPC session (`--model openai-codex/gpt-6.1-sol`, `get_state` only) with a fresh nonce, and record: does Pi start, what warning it prints, and confirm **no** marker with this nonce was written (the package must not load from any cache).
Expected per docs: `pi install` exits non-zero; startup warns and continues without the package. Record exact messages for `factory doctor` and the guard-extension design (architecture §6.2).

- [ ] **Step 6: Missing-credential behavior (Review Focus 2)**

Scenario `nocreds` (empty `.agent-nocreds`; npm via `npm.mjs nocreds`, which gives a fresh prefix and cache), with an environment that has **no** HTTPS or SSH credentials and no prompting: `GIT_CONFIG_GLOBAL=<abs>/out/empty.gitconfig` (empty file), `GIT_CONFIG_NOSYSTEM=1`, any inherited `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`/`GIT_CONFIG_PARAMETERS` removed, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=` and `SSH_ASKPASS=` (empty), `SSH_AUTH_SOCK` and `NETRC` removed, `HOME` (and on Windows `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`) pointed at an empty scratch home `<abs>/out/home-nocreds` so neither git/curl `.netrc` nor a user `.npmrc` can supply credentials, and `GIT_SSH_COMMAND="ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null"` (npm falls back from HTTPS to SSH for hosted repos — pacote in Node 22.19's npm — so SSH must fail too; on Windows use `NUL` for `/dev/null`). Each command bounded to 120 s. Run the **valid** tag install via Pi (`pi install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0`) and via `node spikes/phase0/npm.mjs nocreds npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0`.
Expected: both fail without hanging; record exit codes and diagnostics verbatim (input for `factory doctor`). The owner's real git config is never modified.

- [ ] **Step 7: Record S2 (incl. extension format decision: TS source via jiti is sufficient, or built JS needed) and commit on master**

```bash
git add docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "chore(spike): verify Pi package install from private git (S2)"
```

---

### Task 4: S3 — Persistent `factory` CLI install path

**Files:**
- Modify: report S3.

**Interfaces:**
- Consumes: tag `spike-pkg-v0.1.0` with `bin/factory-spike.mjs` (Task 3 Interfaces).
- Note: npm puts global executables in `<prefix>/bin/` on POSIX and **directly in `<prefix>/`** on Windows (`factory-spike.cmd`); checks must use the right location per OS.

- [ ] **Step 1: Global install from private git into an empty scratch prefix**

Scenario `cli`: `node spikes/phase0/npm.mjs cli npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0`
Expected: exit 0; the executable exists at the OS-specific location and prints `factory-spike ok v…`. Record whether npm ran a build/prepare step and the install duration.

- [ ] **Step 2: One-command bootstrap from an empty prefix**

Scenario `bootstrap`: `node spikes/phase0/npm.mjs bootstrap npx -y github:jrevenga/ai-factory#spike-pkg-v0.1.0 install` (the `install` subcommand inherits the forced `npm_config_prefix=.npm-global-bootstrap`), then, in a **new** process without npx, run the executable from that prefix's OS-specific location. Before and after, record `npm prefix -g` of the owner's normal environment to confirm it was not touched.
Expected: the persistent `factory-spike` exists after the npx process has exited and prints `factory-spike ok`. If this does not work reliably, record it and adopt the two-command design (`npm install -g …` then `factory install`) in Task 11.

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
  - `session_start`: writes the effective tool inventory (`pi.getAllTools()` names, exposure, annotations) to `process.env.SPIKE_INVENTORY`.
  - `tool_call`: appends `{ts, toolCallId, toolName, inputKeys, decision}` to `process.env.SPIKE_TOOLLOG` (JSONL). When `process.env.SPIKE_BLOCK_WRITES === "1"` it returns `{ block: true, reason: "spike gate" }` for `write`, `edit` **and `bash`** (so no shell alternative can write), and logs `decision: "blocked"`; otherwise `decision: "allowed"`.
  - `tool_execution_end`: appends `{toolCallId, toolName, isError, textHead}` (first 200 chars of the result text) to the same log. Blocked calls do **not** go through `tool_result` in Pi 1.4.0 (they are immediate outcomes — `packages/agent/src/agent-loop.ts` v1.4.0), so `tool_execution_end` (or `message_end` with role `toolResult`) is the event used to observe denials.
  - `before_agent_start`: mutates `event.systemPromptOptions` to add a section named `spike-role` with text `End every final answer with the word PINEAPPLE.` (follow `examples/extensions/prompt-customizer.ts` for the exact field shape; read `src/core/extensions/types.ts` at tag v1.4.0).
- All probe paths passed to Pi are **absolute** (`SPIKE.root`); the temp dir is passed only as `cwd`.

- [ ] **Step 1: Owner action — log in to Codex in the isolated agent dir**

Owner runs `node spikes/phase0/pi.mjs` interactively, `/login` → ChatGPT, then exits. Claude needs no action (bridge uses the existing Claude Code login).

- [ ] **Step 2: Install the bridge pinned and discover model ids**

Run: `node spikes/phase0/pi.mjs install npm:pi-claude-bridge@0.9.3`, then list models (`/model` in an interactive session, or the CLI listing flag if present) and record the exact ids for Claude Opus via `claude-bridge` and for `gpt-6.1-sol` via the native Codex provider.

- [ ] **Step 3: Bridge — control run (unblocked): tools visible to the hook, sections delivered**

In a fresh temp dir `T1` (`mktemp -d`), with cwd `T1`: `node <abs>/pi.mjs -p --no-session --model <claude-bridge opus id> --extension <abs>/gate-probe.ts "Create a file named created.txt containing hello, then answer in one sentence."` with `SPIKE_TOOLLOG`, `SPIKE_INVENTORY` under `out/`.
Expected: `T1/created.txt` exists **and** `tools.jsonl` has an `allowed` entry for the tool that created it (proves writes pass through the hook); the answer ends with `PINEAPPLE` (S5 for bridge).

- [ ] **Step 4: Bridge — blocked run: denial asserted, no bypass**

Fresh temp dir `T2`, `SPIKE_BLOCK_WRITES=1`, same prompt.
Expected: `T2/created.txt` does **not** exist; `tools.jsonl` contains **at least one** `blocked` attempt (zero attempts is an inconclusive run: repeat once with a more explicit prompt, then record as inconclusive); for each blocked `toolCallId` there is a matching `tool_execution_end` with `isError: true` and text containing `spike gate`; no `allowed` write-capable call exists. A file created without a logged `tool_call` means a tool executes outside Pi → record and stop for the owner (architecture §8.4 [verify]).

- [ ] **Step 5: Bridge — built-in tool absence from the effective configuration**

Inspect `SPIKE_INVENTORY` and confirm only Pi tools are exposed; cite the pinned bridge source that starts Claude Code with `tools: []` on the provider path (`src/index.ts` v0.9.3, lines ~128, ~595, ~916). Expected: no Claude Code built-in tool names in the inventory or in `tools.jsonl`.

- [ ] **Step 6: Native Codex — repeat Steps 3–4 with the `gpt-6.1-sol` id**

Expected: same results. Record any difference.

- [ ] **Step 7: Record S4, S5 and commit**

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

- [ ] **Step 1: Bounded same-session calls per provider**

Per provider, one RPC session **with sessions enabled** (via `pi.mjs`, absolute `--extension`) with `SPIKE_HEADERLOG=<abs>/out/headers-<provider>.jsonl`; afterwards assert the session file exists under `spikes/phase0/.agent/sessions/` (completes Task 1's isolation check). Three sequential prompts in the same session: `Say ok.`, `Run the shell command: echo hi. Then say done.` (crosses a tool boundary), `Say ok again.` Wait for `agent_settled` after each.
Expected: bridge → `anthropic-ratelimit-unified-*` names appear on at least one call (they can arrive one provider call late, per bridge README); Codex → record whatever rate/usage headers appear across all calls.

- [ ] **Step 2: Exhaustion path (desk check)**

Read how the pinned bridge and Pi's native Codex provider surface quota exhaustion (429 / limit errors) to extensions (`after_provider_response` status, error messages); cite source lines.

- [ ] **Step 3: Record S6 per provider as `known` (observed), `not observed` (absent in this run but possibly available) or `unavailable` (source shows it is never exposed), plus the exhaustion signal, and commit**

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
- Produces: `node spikes/phase0/rpc-subagent.mjs <worktreePath> <modelId>` creates an `RpcClient` with `cliPath` = absolute `pi.mjs` (so the child gets the isolated env), `cwd=<worktreePath>`, args `--mode rpc --no-session --model <modelId> --extension <absolute gate-probe.ts>`; sends one prompt with `promptAndWait`, waits for `agent_settled`, prints `{final, toolCalls, durationMs, usage}`.

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

`ci-checks.mjs` also runs Task 4 Step 2 (bootstrap from an empty prefix) and uses the OS-specific executable location.
Checklist (owner, on a Windows machine with Git for Windows and Node ≥ 22.19): clone; `node spikes/phase0/ci-checks.mjs`; `node spikes/phase0/pi.mjs` → `/login` ChatGPT; Task 5 Steps 3–4 and 6 (Codex); Task 6 Step 1 (Codex); Task 7 Step 2 with a Windows temp worktree; confirm Pi's `bash` tool runs through Git Bash (`!printf 'Bash is working\n'`). **Bridge on Windows**: if Claude Code is installed and logged in on that machine, also run Task 5 Steps 3–5 and Task 6 Step 1 with the bridge; if not, record "not run — no Claude Code on the Windows machine" and Task 11 marks bridge-on-Windows as unverified (the Windows team profile is codex-only). Paste outputs into report S10.

- [ ] **Step 2: Commit the workflow and scripts**

```bash
git add .github/workflows/spike-phase0.yml spikes/phase0/ci-checks.mjs spikes/phase0/windows-checklist.md
git commit -m "chore(spike): Windows CI matrix and owner checklist (S10)"
```

- [ ] **Step 3: Owner approval, then push and dispatch (hard gate)**

`workflow_dispatch` requires the workflow on the default branch (`master`). Run (after approval): `git push origin master && gh workflow run spike-phase0.yml --ref master && gh run watch`
Expected: all four matrix jobs green; record each `totalMs` (input to the < 10 min install target) and any Windows-specific failure.

- [ ] **Step 4: Owner runs the Windows checklist**

Expected: all items pass, or failures recorded with output.

- [ ] **Step 5: Record S10 and commit**

```bash
git add docs/superpowers/spikes/2026-10-31-phase0-report.md
git commit -m "docs(spike): record Windows results (S10)"
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
