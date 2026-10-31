# Phase 0 feasibility spikes report

- Date: 2026-10-31
- Host OS: Linux 6.8.0-71-generic (Ubuntu)
- Node versions: v24.13.1 (Homebrew node@24); design minimum 22.19 (to be tested)
- Pi version: 1.4.0
- Bridge version: pi-claude-bridge@0.9.3

## S1 sqlite

**Question:** Can the memory store use Node's built-in `node:sqlite` with FTS5 and diacritic folding (`unicode61 remove_diacritics 2`) on the declared minimum Node 22.19 and on Node 24, without flags?

**Method:** `spikes/phase0/sqlite-fts.mjs` opens an in-memory DB (dynamic `import('node:sqlite')` inside try/catch so unsupported Node still prints JSON), creates `fts5(title, body, tokenize="unicode61 remove_diacritics 2")`, inserts `("Decisión de autenticación", "Usamos sesiones con migración en caché")`, and requires `decision`, `autenticacion`, `migracion`, `Decisión`, `cache` to each match exactly 1 row. Node 22.19.0 ran via `npx` through the isolated runner `spikes/phase0/npm.mjs s1`.

**Evidence:**

```
$ node spikes/phase0/sqlite-fts.mjs        # local Node 24.13.1
{"node":"24.13.1","sqlite":"3.51.2","fts5":true,"accentFolding":true,"warning":"SQLite is an experimental feature and might change at any time"}
exit=0   (stderr: ExperimentalWarning: SQLite is an experimental feature and might change at any time)

$ node spikes/phase0/npm.mjs s1 npx -y node@22.19.0 spikes/phase0/sqlite-fts.mjs
{"node":"22.19.0","sqlite":"3.50.4","fts5":true,"accentFolding":true,"warning":"SQLite is an experimental feature and might change at any time"}
exit=0   (stderr: same ExperimentalWarning; npm update notice only)
```

**Verdict:** PASS on Node 22.19.0 (SQLite 3.50.4) and Node 24.13.1 (SQLite 3.51.2). No `--experimental-sqlite` flag needed on 22.19.

**Design impact:** `node:sqlite` with FTS5 and accent-folding is viable at the Node 22.19 minimum; no native dependency required. It still emits an `ExperimentalWarning` (stderr) on both versions: the CLI should suppress or filter that warning, and the API is flagged as possibly changing, so isolate it behind a thin store adapter. Bundled SQLite version differs between Node versions (3.50.4 vs 3.51.2); keep FTS queries to features common to both.

## S2 package from private git

**Question:** Can Pi 1.4.0 install a Pi package (TS extension with a runtime dependency) from a private GitHub repo by tag, load it without a build step, and what exactly happens when the ref is wrong or credentials are missing?

**Method:** Private repo `jrevenga/ai-factory` created (owner-approved). Orphan branch `spike/pkg` (commit 8a9eb98, tag `spike-pkg-v0.1.0`) holds only `package.json`, `extensions/probe.ts` (TS source, imports `ms`, type-only `ExtensionAPI`), `bin/factory-spike.mjs`. Node v24.13.1 (Node 22.19 not re-run here). All Pi/npm calls via `spikes/phase0/pi.mjs` / `npm.mjs`; RPC probes use `--model openai-codex/gpt-6.1-sol`, only `get_state`, nonce-stamped marker deleted before each run. Pi docs key for packages in settings is `packages` (docs/packages.md v1.4.0). `session_start` handler receives `SessionStartEvent {reason, previousSessionFile?}`.

**Evidence:**
- Install: `node spikes/phase0/pi.mjs install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0` -> "added 1 package ... Installed git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0", exit 0 (re-install also exit 0). Pi ran `npm install` inside the checkout. `pi list` -> `User packages: git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0` at `spikes/phase0/.agent/git/github.com/jrevenga/ai-factory`; `ms` present at `<that path>/node_modules/ms`.
- Load: RPC `get_state` returned success (exit 0) and `out/marker.json` = `{"loaded":true,"nonce":"a71557da-4c12-4e0f-81dd-b79b89b52d48","ms":7200000}` (this run's nonce) -> TS loaded via jiti, `ms` dependency resolved, `ms("2h")` = 7200000.
- Bad ref, install: `pi install git:github.com/jrevenga/ai-factory@does-not-exist` (fresh `.agent-badref`) -> exit 1; stdout `Installing git:...@does-not-exist...`; stderr `error: pathspec 'does-not-exist' did not match any file(s) known to git` / `Error: git checkout does-not-exist failed with code 1`.
- Bad ref, startup: `.agent-badref/settings.json` = `{"packages":["git:github.com/jrevenga/ai-factory@does-not-exist"]}`; RPC start with fresh nonce -> **Pi does NOT warn and continue: it crashes with an unhandled exception**, exit 1, no RPC response, stderr ends `Error: git checkout does-not-exist failed with code 1 at ChildProcess.<anonymous> (.../chunk-MM3LKT73.js:497) ... Node.js v24.13.1`. No marker written (nonce absent). `pi --list-models` in the same agent dir crashes identically, so it affects every command, not just RPC. This contradicts docs/packages.md ("warns and keeps running"), at least for a missing ref on first resolve with an empty checkout dir.
- No credentials (`spikes/phase0/nocreds.mjs`: empty `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, empty askpass vars, no `SSH_AUTH_SOCK`/`NETRC`/`GIT_CONFIG_*`, scratch HOME, ssh `-F /dev/null -o BatchMode=yes -o IdentityFile=/dev/null`):
  - Pi: exit 1 in 640 ms, no hang. stderr: `fatal: could not read Username for 'https://github.com': terminal prompts disabled` / `Error: git clone https://github.com/jrevenga/ai-factory <agentDir>/git/github.com/jrevenga/ai-factory failed with code 128`.
  - npm (`npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0`): exit 128 in 1.3 s, no hang. `npm error code 128 / An unknown git error occurred / command git --no-replace-objects ls-remote ssh://git@github.com/jrevenga/ai-factory.git / Load key "/dev/null": error in libcrypto / git@github.com: Permission denied (publickey). / fatal: Could not read from remote repository.` (npm tried SSH only, no HTTPS message).
- Positive control with the owner's normal git credentials: `npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0` exit 0; the installed `factory-spike` bin prints `factory-spike ok v24.13.1`; `factory-spike install` (spawns node + npm-cli.js, no shell) exit 0 and creates the bin in a fresh prefix.

**Verdict:** PASS for install-by-tag from a private repo with credentials, and for TS-source extensions with dependencies (no build needed). Failure modes are loud, bounded and distinguishable, but a stale/bad ref in settings is fatal for Pi startup, not a warning.

**Design impact:** (1) Ship TS source; jiti is sufficient, a built JS artifact is not required. (2) Declare Pi as `peerDependencies`, third-party libs in `dependencies`; they land in the checkout's `node_modules`. (3) Pinned refs must be validated before being written to settings, because an unresolvable ref in `settings.json` crashes every Pi command (including `pi list`/`--list-models`); `factory doctor` and the bootstrap must verify the tag exists (`git ls-remote --tags`) first, and recovery needs a non-Pi path (edit settings.json). The guard-extension idea (arch 6.2) cannot help here because Pi dies before extensions load. (4) `factory doctor` credential diagnostics: match `could not read Username for 'https://github.com'` (Pi/git HTTPS) and `Permission denied (publickey)` (npm SSH fallback); exit codes 1 (Pi) and 128 (npm). (5) Marker/nonce assertion is the only valid load check; a zero exit alone proves nothing. (6) Private install needs git credentials for HTTPS (credential helper such as gh) or SSH key; Pi never prompts when terminal prompts are off.

## S3 CLI install path

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S4 bridge tools and gates

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S5 prompt sections

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S6 limit signals

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S7 RPC subagent

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S8 input/steering lifecycle

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S9 Codex CLI hooks (desk check)

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S10 Windows

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD
