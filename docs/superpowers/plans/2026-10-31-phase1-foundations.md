# Phase 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable, updatable, rollback-able factory skeleton: TypeScript repo with enforced layers, CI on Linux and Windows, release manifest, config layering with provenance, profiles, per-key managed Pi settings, `factory install/doctor/update/rollback/init/config explain`, the launcher, the startup handshake and the guard extension.

**Architecture:** One npm package that is both a Pi package (extension loaded by Pi's jiti from TypeScript source) and the `factory` CLI (a tiny `.mjs` bin that loads the same TypeScript source through `jiti`). `src/core` holds pure domain logic (config, manifest, managed-settings ownership, state/migration/rollback planning); `src/adapters` does all I/O (processes, files, git, npm, host-side Pi); `src/adapters/pi/extension/` is the only code that runs inside Pi; `src/cli` is the composition root and wires commands. Every install/update/rollback converges on one internal command, `factory _apply-release`, run by the CLI version being installed.

**Tech Stack:** Node ≥ 22.19 (ESM), TypeScript 7.0.2 (`tsc --noEmit` only), vitest 5.0.5, zod 4.6.7 (schemas + JSON Schema export), jiti 2.7.0 (same version Pi 1.4.0 uses), proper-lockfile 4.1.2 (same lock protocol Pi 1.4.0 uses for `settings.json`), Pi 1.4.0, pi-claude-bridge 0.9.3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-31-ai-factory-design.md` (A). Phase row: A §15 "1. Foundations". Evidence: `docs/superpowers/spikes/2026-10-31-phase0-report.md`. The methodology spec (`2026-10-31-factory-methodology-design.md`) has no Phase 1 deliverables.

**Acceptance (A §15):** CI install < 10 min on clean runners; update → rollback round-trip restores state; a broken package install leaves write tools blocked.

## Builder rulings taken while planning

Each is `ruling — why — cost if wrong`. Facts marked (verified) were checked on 2026-10-31 against Pi 1.4.0 source/docs or by running it.

1. **npm + `package-lock.json`, not pnpm**, for this repo — Pi installs a git package by running `npm install --omit=dev --legacy-peer-deps` in the checkout (`dist/core/package-manager.js` `getGitDependencyInstallArgs`, verified), so only `package-lock.json` makes the Pi-side install reproducible (A §6.1 manifest) — switching later means regenerating one lockfile. The global "use pnpm" rule governs the developer environment; the product's install path is dictated by Pi.
2. **No build step; TypeScript source everywhere**: explicit `.ts` import specifiers (`allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly`); Pi loads the extension through its own jiti (proven in S2); the CLI bin loads `src/cli/main.ts` through `jiti` 2.7.0 (runtime dependency). Node's built-in type stripping is refused for files under `node_modules`, where a global install lives — cost if wrong: add a `dist/` build later; the source layout does not change.
3. **Layer lint = a repo script** (`scripts/check-layers.ts`, part of `npm run lint` in CI) instead of an ESLint plugin — fewer dependencies, same enforcement (A §5.1 "lint rule in CI") — cost: swap for ESLint later.
4. **Pinned Pi in a factory-owned prefix** `~/.factory/pi/<version>/` (`npm install --prefix … --ignore-scripts @earendil-works/pi-coding-agent@<version>`), always run as `node <prefix>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`. A user's own `pi` on PATH is never replaced or shadowed; rollback keeps old prefixes side by side. Satisfies A §6.2 step 1 "user-level install" — cost: one adapter.
5. **Peer dependency handling (A §6.2/C2, [builder])**: `peerDependencies` pins `@earendil-works/pi-coding-agent` to the manifest's exact Pi version (manifest check enforces equality) and every factory-run global install uses `--legacy-peer-deps`. `npx` cannot take flags for its own install; the exact pin guarantees whatever it auto-installs is the manifest's version — cost: npx caches one Pi copy.
6. **Login detection without opening credentials**: Claude = `claude auth status --json` (exit 0 and `loggedIn: true` → present; Claude Code 2.1.316 has it, verified). Codex = pinned Pi `auth check --provider openai-codex --json --no-refresh` (never `--credentials`): `ready`/exit 0 → `present`, `not_ready`/1 → `absent`, `invalid`/2 → `invalid` (verified: an empty agent dir prints `{"status":"not_ready","provider":"openai-codex","reason":"credentials_not_configured"}`, exit 1). Pi reads its own credential store; factory code never opens an `auth.json` — cost: a detection reports `unknown`, doctor says so.
7. **Local release fixtures over smart HTTP**: Pi 1.4.0 rejects `git:file://…` (verified) and accepts `git:http://127.0.0.1:<port>/<path>.git@<tag>` (verified with a dumb-HTTP server). Dumb HTTP cannot serve shallow clones, so the test git server is **smart HTTP**: a Node `http` server on `127.0.0.1` that bridges requests to `git http-backend` (CGI; ships with Git on Linux and Git for Windows). Production source `https://github.com/jrevenga/ai-factory.git`; override only via `FACTORY_SOURCE` (dev/test; `doctor` warns) — cost: ~80-line test helper.
8. **Guard ↔ handshake transport**: `pi.events` `factory:handshake`; a listener in one extension receives an event emitted by another at `session_start` in either load order (verified). The guard allows only `read`, `grep`, `find`, `ls` until it receives `{ ok: true }`. Spoofable by any extension: guardrail (A §11), not a boundary.
9. **Model-free Pi tests use Pi's faux provider**: a test extension registers `fauxProvider({ provider: "factory-test", models: [{ id: "faux" }] })` from `@earendil-works/pi-ai` with scripted tool calls; `pi -p --model factory-test/faux` exercises real `tool_call` hooks offline, no credentials (verified both allow and block).
10. **Rollback order**: the *newer* CLI (running `factory rollback`) snapshots, restores state and only then installs the older CLI and runs its `_apply-release --reason rollback`, so older versions need no rollback knowledge. `_apply-release` flags are a compatibility contract from v0.1.0 on (round-trip e2e).
11. **State compatibility model (A §6.2 migration policy)**: each persisted document carries an integer `schema` that changes **only on a breaking change**, which is allowed only in a major release (A §6.2; no 0.x exception). Additive changes add optional fields without bumping `schema`, and every persisted-document reader uses `z.looseObject` so older versions read newer additive documents and preserve unknown fields when rewriting. Hence a rollback within the same schemas keeps all current data; only a document whose schema is newer than the target supports is restored from a snapshot. Per-document targets live in `release.json` `stateSchemas`.
12. **Immutable transaction snapshots + journal**: every update/rollback writes a new snapshot directory `backups/<id>/` (`id` = `<UTC yyyymmddThhmmssZ>-<from>-to-<to>`, never reused or overwritten; `snapshot.json` lists files) and a journal `~/.factory/txn.json` `{ id, kind, from, to, snapshot, startedAt }` before any mutation; `_apply-release` deletes the journal only after writing `state.json`. `factory rollback` with a pending journal recovers that transaction exactly (restore every file of its snapshot, reinstall `from`). Fixes the "failed update then rollback overwrites the recovery backup" hole. The spec's `backups/<from-version>/` layout is refined to per-transaction directories for this reason.
13. **Pi settings writes use Pi's lock protocol**: `proper-lockfile` `lock(path, { realpath: false })` around read-merge-write of `settings.json` (Pi 1.4.0 `dist/core/settings-manager.js` uses `lockfile.lockSync(path, { realpath: false })`, verified), then atomic rename. Pi's own package commands (`pi install`) take the same lock.
14. **Windows process teardown scope**: Phase 1 cancels on Windows with awaited `taskkill /PID <pid> /T /F` while the leader is alive (tested on Windows CI). Detecting descendants that outlive a normally exited leader is POSIX-only here; on Windows it needs a Job Object or a process snapshot and is deferred to the Phase 5 `SubagentRunner`, which is where A §7.3 requires orphan detection. Phase 1 children are short-lived npm/git/pi commands — cost if wrong: an orphaned npm on Windows after a crash.
15. **`.cmd` invocation is constrained, not general**: npm runs through its JS entry whenever found (Global Constraints), so `.cmd` wrapping is a fallback. The serializer `quoteCmdArgs` quotes arguments containing spaces and **rejects** any argument containing `"`, `%`, `!`, `&`, `|`, `<`, `>`, `^`, CR or LF, or ending in `\` — paths go through environment variables (`npm_config_prefix`, `npm_config_cache`) instead of arguments where possible.
16. **Launcher refuses extension-disabling flags**: `--no-extensions`/`-ne` would disable discovery of both the factory package and the guard (Pi `dist/cli/args.js`, verified), so the launcher rejects them with exit 2. Running plain `pi -ne` outside the launcher is out of scope (A §11 guardrails).
17. **Provider reachability (A §6.2 doctor)**: online-only check `provider-reachability` does an HTTPS `HEAD` with a 5 s timeout to `https://chatgpt.com/` (Codex) and `https://api.anthropic.com/` (Claude) for the providers the active profile requires; any HTTP response = reachable. `fetch` is injected so tests never hit the network.
18. **Out of scope here, by spec phase**: the C4 marker-control test (first step of bridge isolation, which belongs with roles, Phase 4/5), C12 (Codex adapter, Phase 9), GatePolicy (Phase 2; the handshake reports `policy: "none"`), memory DB creation (Phase 6; snapshots copy `memory.db` if present).

## Global Constraints

- Node `>=22.19.0` (`engines`); CI matrix Node `22.19.0` and `24` on `ubuntu-latest` and `windows-latest`; Windows legs check out into a directory whose name contains a space (as in `.github/workflows/spike-phase0.yml`).
- Exact pins (release manifest): Pi `@earendil-works/pi-coding-agent` `1.4.0`; `pi-claude-bridge` `npm:pi-claude-bridge@0.9.3`; supported Pi range `>=1.4.0 <1.5.0`.
- Production source `https://github.com/jrevenga/ai-factory.git`; tags `v<semver>`; first release `0.1.0`.
- Runtime `dependencies` only `zod` `4.6.7`, `jiti` `2.7.0`, `proper-lockfile` `4.1.2` (exact). Host packages (`@earendil-works/*`, `typebox`) are never in `dependencies` (Pi docs/packages.md).
- Never use sudo/admin; everything user-level. Never open, print or upload any `auth.json`. Tests never write the real `~/.pi/agent` or `~/.factory`: they set `FACTORY_HOME`, `PI_CODING_AGENT_DIR`, `npm_config_prefix`, `npm_config_cache` under a per-test temp dir whose path contains a space.
- Every Pi process started by factory code or tests: stdin closed (A §7.3/C10), `PI_TELEMETRY=0`; tests also `PI_OFFLINE=1`.
- No `shell: true` anywhere. Windows `.cmd`/`.bat`: `cmd.exe /d /s /c ""<exe>" <quoteCmdArgs(args)>"` with `windowsVerbatimArguments: true` (ruling 15).
- npm is located via `npm_execpath`, else `npm` on PATH — never relative to `process.execPath` (A §6.2/C3).
- Every `git:` package ref is resolved with `git ls-remote` before it is written to Pi settings; abort on failure (A §6.2/C1).
- Git and npm children get `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and a timeout.
- One effective package source everywhere: `effectiveSource(manifest, env)` = `env.FACTORY_SOURCE ?? manifest.source.git` (install, doctor, update, rollback, apply).
- Factory state under `FACTORY_HOME` (default `~/.factory`); Pi agent dir = `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
- Layers: `core` imports nothing from `adapters`/`cli`, no `@earendil-works/*`, no `node:fs`, `node:child_process`, `node:os`, `node:net`, `node:http`; `adapters` never imports `cli`; nothing outside `src/adapters/pi/extension/**` imports from it; `src/adapters/pi/extension/**` imports only `core` and itself; only `src/adapters/pi/extension/**`, `guard/**` and `test/**` may import `@earendil-works/*`, and outside `test/**` only with `import type`. `cli` is the composition root and may import `core` and any adapter except the extension.
- `.gitattributes`: `* text=auto eol=lf`.
- Artifacts in English; conventional commits, no AI attribution.

## Review Focus

1. **Spaces and backslashes in paths** (`C:\Users\a b\…`, the owner's `C:\Users\jorge\ai factory\…`): every spawn, settings path and Pi package path. Pinned by per-test temp dirs containing a space (Task 1 helper), the Windows CI checkout dir, and Task 2 `quoteCmdArgs` tests.
2. **Hand-edited, malformed or concurrently written Pi `settings.json`**: never clobbered; malformed aborts with the path and no write; concurrent Pi writers coordinate through the lock. Pinned by Task 5 tests.
3. **Failure halfway through install/update/rollback** (network drop, bad tag, Ctrl+C, failure after migration): state stays recoverable and the message names the recovery. Pinned by Task 11 `apply failure leaves previous state.json`, Task 12 `failed update after migration recovers exactly` and `update aborts before swap on unresolvable tag`.
4. **A user's own Pi on PATH at another version**: only the pinned Pi is used. Pinned by Task 9 `runs pinned pi, not PATH pi`.
5. **No git credentials or offline**: doctor/install explain (S2 strings) within the timeout, never hang. Pinned by Task 9 `classifies credential errors` and Task 10 `offline doctor makes no network call`.

---

## File structure

```
package.json, package-lock.json, tsconfig.json, vitest.config.ts, .gitattributes, .gitignore, README.md
release.json                      release manifest (Task 4)
CHANGELOG.md                      one "## [x.y.z]" section per release
bin/factory.mjs                   jiti loader for src/cli/main.ts
schemas/*.schema.json             generated from zod, freshness-checked
profiles/{claude-codex,codex-only}.json, defaults/config.json   core data (Task 3)
guard/factory-guard.ts            guard extension, copied into <piAgentDir>/extensions/ (Task 8)
skills/.gitkeep, prompts/.gitkeep Pi package resource dirs (empty in Phase 1)
scripts/{check-layers,gen-schemas,manifest-check}.ts
src/core/config/{schema,resolve,explain}.ts
src/core/profiles/{schema,propose}.ts
src/core/release/{manifest,changelog,semver}.ts
src/core/settings/managed.ts
src/core/state/{schema,migrations,rollback-plan}.ts
src/core/handshake.ts
src/adapters/platform/{process,cmd-quote,paths,json-file,npm}.ts
src/adapters/vcs/git.ts
src/adapters/pi/{runtime,settings-file}.ts          host side (CLI may import)
src/adapters/pi/extension/index.ts                  runs inside Pi (package.json "pi.extensions")
src/adapters/providers/{logins,reachability}.ts
src/adapters/store/{state-store,lock,sessions,snapshots,transaction}.ts
src/cli/{main,io}.ts
src/cli/commands/{doctor,install,apply-release,update,rollback,launch,init,config}.ts
test/helpers/{tmp,pi-harness,git-server}.ts, test/fixtures/faux-provider.ts, test/fixtures/proc/*.mjs
test/** mirrors src/**; test/e2e/*.e2e.test.ts
.github/workflows/{ci,e2e}.yml
```

---

### Task 1: Toolchain, layout, layer lint, CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitattributes`, `.gitignore`, `scripts/check-layers.ts`, `test/helpers/tmp.ts`, `test/scripts/check-layers.test.ts`, `test/helpers/tmp.test.ts`, `.github/workflows/ci.yml`, `skills/.gitkeep`, `prompts/.gitkeep`
- Keep untouched: `spikes/`, `.github/workflows/spike-phase0.yml`

**Interfaces:**
- Produces scripts: `typecheck` (`tsc --noEmit`), `lint` (`typecheck` + layer check; Task 3/4 append schema and manifest checks), `test` (`vitest run --exclude "test/e2e/**"`), `test:e2e` (`vitest run test/e2e`).
- Produces: `checkLayers(root: string): LayerViolation[]`, `LayerViolation = { file: string; line: number; specifier: string; rule: string }`.
- Produces: `makeTmp(prefix: string): Promise<{ dir: string; cleanup(): Promise<void> }>` — `os.tmpdir()/<prefix> <random>` (always contains a space); `cleanup` refuses paths not under `os.tmpdir()`.

`package.json`: `"name": "ai-factory"`, `"version": "0.1.0"`, `"type": "module"`, `"private": true`, `"bin": { "factory": "bin/factory.mjs" }`, `"keywords": ["pi-package"]`, `"pi": { "extensions": ["./src/adapters/pi/extension/index.ts"], "skills": ["./skills"], "prompts": ["./prompts"] }`, `"engines": { "node": ">=22.19.0" }`, `"dependencies"` per Global Constraints, `"peerDependencies": { "@earendil-works/pi-coding-agent": "1.4.0" }`, devDependencies exact: `typescript` `7.0.2`, `vitest` `5.0.5`, `@types/node` latest `22.x`, `@types/proper-lockfile` latest, `@earendil-works/pi-coding-agent` `1.4.0`, `@earendil-works/pi-ai` `1.4.0`.

`tsconfig.json`: `strict`, `noEmit`, `module`/`moduleResolution` `nodenext`, `target` `es2023`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, include `src scripts test guard bin`.

Layer rules (named): `core-no-adapters`, `core-no-cli`, `core-no-io-builtins`, `core-no-pi`, `adapters-no-cli`, `no-import-extension` (anything outside `src/adapters/pi/extension/**` importing it), `extension-core-only`, `pi-import-type-only`. Scan `import … from`, `export … from`, `import()` in `.ts`/`.mjs` under `src/`, `guard/`, `scripts/`, `bin/`.

- [ ] **Step 1: Write failing tests**: temp tree `src/core/a.ts` importing `../adapters/x.ts` → `core-no-adapters` at line 1; `src/core/b.ts` importing `node:fs` → `core-no-io-builtins`; `src/adapters/pi/extension/c.ts` with a value import from `@earendil-works/pi-coding-agent` → `pi-import-type-only`, `import type` → none; `src/adapters/pi/extension/d.ts` importing `../runtime.ts` → `extension-core-only`; `src/cli/e.ts` importing `../adapters/pi/extension/index.ts` → `no-import-extension`; `src/cli/f.ts` importing `../adapters/pi/runtime.ts` → none; real repo root → `[]`. `makeTmp`: dir contains a space and exists; `cleanup` removes it.
- [ ] **Step 2: Run** `npm test` → FAIL (module not found).
- [ ] **Step 3: Implement**; `npm install` to produce `package-lock.json`.
- [ ] **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: CI** `.github/workflows/ci.yml`: on `push` and `pull_request`; matrix per Global Constraints (`fail-fast: false`, spaced checkout on Windows, `shell: bash`); `actions/checkout@v4`, `actions/setup-node@v4`, `npm ci`, `npm run lint`, `npm test`; `timeout-minutes: 15`; `permissions: contents: read`.
- [ ] **Step 6: Commit** `chore: scaffold TypeScript toolchain, layer lint and CI`.

### Task 2: Platform adapter — processes, cmd quoting, npm, paths, JSON files

**Files:**
- Create: `src/adapters/platform/{process,cmd-quote,npm,paths,json-file}.ts`, fixtures `test/fixtures/proc/{spawn-tree.mjs,ignore-term.mjs,exit-leave-child.mjs}`
- Test: `test/adapters/platform/{process,cmd-quote,npm,paths,json-file}.test.ts`

**Interfaces:**
- Produces:
  - `runBounded(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<RunResult>`, `RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; orphans: boolean }`. Port of `spikes/phase0/pi.mjs` `spawnBounded`/`terminateTree` (POSIX: detached group, SIGTERM → SIGKILL after 2 s, poll until gone, post-exit orphan cancel; Windows: awaited `taskkill /T /F`, ruling 14; one cancellation path). Parent SIGINT/SIGTERM handlers are **installed when the first child becomes active and removed when the active set empties**; while installed they tear down active children and then re-raise the signal's default behaviour (exit `130`/`143`). Stdin always closed (`input ?? ""` then end). `.cmd`/`.bat` on Windows wrapped per Global Constraints.
  - `quoteCmdArgs(args: string[]): string` (ruling 15; throws `UnsafeCmdArgument { arg }`).
  - `resolveNpm(env?: NodeJS.ProcessEnv): { cmd: string; args: string[] }` — `npm_execpath` ending `.js`/`.cjs` → `[process.execPath, [execpath]]`; else `npm` on PATH (Windows `npm.cmd`; when `<its dir>/node_modules/npm/bin/npm-cli.js` exists → `[process.execPath, [that]]`). Throws `NpmNotFound` with a fix message.
  - `npm(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<RunResult>` (adds `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`).
  - `factoryPaths(env?: NodeJS.ProcessEnv): FactoryPaths` = `{ home, config, state, managedSettings, memoryDb, backups, sessions, lock, txn, piPrefixes, piAgentDir, piSettings, piExtensions }` (`txn` = `<home>/txn.json`).
  - `readJson(path): Promise<unknown | undefined>` (missing → undefined; parse error → `MalformedJson { path }`); `writeJsonAtomic(path, value): Promise<void>` (tmp `<path>.tmp-<pid>-<rand>`, fsync, rename with up to 5 retries on Windows `EPERM`/`EBUSY` at 50 ms; 2-space indent + newline).

- [ ] **Step 1: Write failing tests**: `runBounded` stdout/exit of `node -e`; timeout of `spawn-tree.mjs` (spawns a grandchild running `ignore-term.mjs` that writes its pid) → `timedOut: true` and afterwards `process.kill(grandchildPid, 0)` throws `ESRCH` — runs on Linux AND Windows; `AbortSignal` cancels the same way; POSIX only: `exit-leave-child.mjs` (leader exits, child with detached stdio survives) → `orphans: true` and the child is gone afterwards; stdin closed (`process.stdin.on('end',()=>process.exit(7))` → 7); after a run completes `process.listenerCount("SIGINT")` equals its value before. `quoteCmdArgs(["install","C:\\a b\\x"])` → `install "C:\a b\x"`; each of `"`, `%`, `!`, `&`, `|`, `<`, `>`, `^`, a trailing `\` → throws. `resolveNpm({npm_execpath:"/x/npm-cli.js"})` → `[process.execPath, ["/x/npm-cli.js"]]`; empty PATH → `NpmNotFound`. `factoryPaths({FACTORY_HOME:"/a b",PI_CODING_AGENT_DIR:"/c d"})` fields. `writeJsonAtomic`/`readJson` round-trip; `{bad` → `MalformedJson` with path.
- [ ] **Step 2: Run** `npx vitest run test/adapters/platform` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS (Linux locally; Windows via CI).
- [ ] **Step 5: Commit** `feat(platform): add bounded process runner, cmd quoting, npm resolution, paths and atomic JSON`.

### Task 3: Config layering, provenance, profiles

**Files:**
- Create: `src/core/config/{schema,resolve,explain}.ts`, `src/core/profiles/{schema,propose}.ts`, `defaults/config.json`, `profiles/{claude-codex,codex-only}.json`, `scripts/gen-schemas.ts`, `schemas/{personal-config,project-config,profile}.schema.json`
- Modify: `package.json` (`schemas` script; `lint` adds `schemas --check`)
- Test: `test/core/config/*.test.ts`, `test/core/profiles/*.test.ts`, `test/scripts/gen-schemas.test.ts`

**Interfaces:**
- Produces (zod, exported with inferred types; persisted documents use `z.looseObject`, ruling 11):
  - `SoftGateId = "design-approval"|"new-dependency"|"design-deviation"|"review-disagreement"|"quota-low"` (A §8.2); `HARD_GATES = ["destructive","remote-mutation","secrets","integration","outside-root-write"]` (A §8.1).
  - `CoreConfig` (`defaults/config.json`): `{ schema: 1, autonomy: "low"|"medium"|"high" = "medium", parallelism: int 1..16 = 3, language?: string, radar: false, maintainer: false, gates: { hard: HARD_GATES; soften: SoftGateId[] = [] }, budgets: Record<"claude"|"codex", { weeklyTokens?: number }> = {} }`.
  - `PersonalConfig` (`~/.factory/config.json`): `{ schema: 1, profile: string, autonomy?, parallelism?, language?, radar?, maintainer?, gates?: { soften?: SoftGateId[] }, budgets?, machine?: Record<string,string> }` plus unknown fields preserved.
  - `ProjectConfig` (`.factory/config.json`): `{ schema: 1, minFactoryVersion?: string, context?: string, conventions?: string, overrides?: { language?: string; gates?: { soften?: SoftGateId[] } } }` — `overrides` is a strict object (unknown override keys are a parse error).
  - `Profile`: `{ schema: 1, name: string, requires: ("claude"|"codex")[], roles: Record<"orchestrator"|"implementer"|"reviewer"|"researcher", { model: string; options?: Record<string, unknown> }> }`.
- Produces: `resolveConfig(layers: { core: CoreConfig; personal?: PersonalConfig; project?: ProjectConfig }): ResolvedConfig`, `ResolvedConfig = { value: EffectiveConfig; provenance: Map<string, Provenance>; violations: ConfigViolation[] }`, `Provenance = { source: "core"|"personal"|"project"; overridden: { source: string; value: unknown }[] }`, `ConfigViolation = { key: string; source: "personal"|"project"; reason: "locked" }`.
- Produces: `explainKey(resolved, key: string): { key; value; source; overridden; violations: ConfigViolation[] } | undefined` (dotted keys).
- Produces: `proposeProfile(logins: { claude: LoginState; codex: LoginState }, profiles: Profile[]): Profile | undefined`, `LoginState = "present"|"absent"|"invalid"|"unknown"` — first profile whose `requires` are all `present`, `claude-codex` preferred over `codex-only`.

Rules: deep merge core ← personal ← project (`project.overrides` only). Locked keys (no layer may set): `gates.hard`, `schema` — the value is dropped and a violation recorded. A project `gates.soften` is intersected with the personal-or-core `gates.soften` (a project can only make gates stricter, A §11).

Profiles data (A §7.1): `claude-codex` requires `["claude","codex"]`: orchestrator `claude-bridge/claude-opus-5-5`, implementer `claude-bridge/claude-opus-5-5`, reviewer `openai-codex/gpt-6.1-sol`, researcher `openai-codex/gpt-6-luna`. `codex-only` requires `["codex"]`: orchestrator `openai-codex/gpt-6-astra`, implementer `openai-codex/gpt-6.1-sol`, reviewer `openai-codex/gpt-6.1-sol` with `options: { freshContext: true }`, researcher `openai-codex/gpt-6-luna`.

- [ ] **Step 1: Write failing tests**: core only → `autonomy` `medium` from `core`; personal `high` → provenance `personal`, overridden `[{source:"core",value:"medium"}]`; personal `gates.hard: []` → unchanged + violation `locked`; project soften `["design-approval"]` with personal `[]` → effective `[]`; `ProjectConfig.parse({schema:1,overrides:{autonomy:"high"}})` throws; `PersonalConfig.parse({schema:1,profile:"x",futureField:1})` keeps `futureField`; `explainKey(…,"parallelism")` → `{value:3,source:"core"}`; unknown key → `undefined`. `proposeProfile` both present → `claude-codex`; claude absent → `codex-only`; claude unknown + codex absent → `undefined`; codex `invalid` → `undefined`. Shipped profiles parse. `gen-schemas --check` passes on the committed `schemas/`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (`z.toJSONSchema()` in `scripts/gen-schemas.ts`).
- [ ] **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(config): add layered config with provenance, locked keys and profiles`.

### Task 4: Release manifest, changelog, effective source

**Files:**
- Create: `release.json`, `CHANGELOG.md`, `src/core/release/{manifest,changelog,semver}.ts`, `scripts/manifest-check.ts`, `schemas/release.schema.json`
- Modify: `scripts/gen-schemas.ts`, `package.json` (`manifest:check` in `lint`)
- Test: `test/core/release/*.test.ts`, `test/scripts/manifest-check.test.ts`

**Interfaces:**
- Produces: `STATE_DOCS = ["config.json","state.json","managed-settings.json"] as const` (in `manifest.ts`; `memory.db` joins in Phase 6).
- Produces: `ReleaseManifest`: `{ schema: 1, factory: string, source: { git: string }, stateSchemas: Record<(typeof STATE_DOCS)[number], number>, node: { min: string }, pi: { package: "@earendil-works/pi-coding-agent", version: string, supportedRange: string }, companions: { "pi-claude-bridge": { source: string; when: "claude" } }, lockfileSha256: string, reviewedInstallScripts: string[] }` (loose object).
- Produces: `effectiveSource(m, env): string`; `tagFor(version): string` (`v${version}`); `packageRef(m, env): string` (`git:${effectiveSource}@v${m.factory}`); `npmInstallSpec(m, env): string` (`git+${effectiveSource}#v${m.factory}`).
- Produces: `compareSemver(a, b): -1|0|1`; `satisfies(version, range): boolean` (only `>=x.y.z <x.y.z`; else throws).
- Produces: `changelogBetween(markdown, from, to): string` (sections `from < v <= to`, newest first).
- Produces: `checkManifest(root): string[]`.

`release.json`: `factory` `0.1.0`, `source.git` `https://github.com/jrevenga/ai-factory.git`, `stateSchemas` all `1`, `node.min` `22.19.0`, `pi.version` `1.4.0`, `pi.supportedRange` `>=1.4.0 <1.5.0`, bridge `npm:pi-claude-bridge@0.9.3`.

`checkManifest` problems: version ≠ `package.json`; peer pin ≠ `pi.version`; `!satisfies(pi.version, supportedRange)`; `lockfileSha256` ≠ sha256 of `package-lock.json` with CRLF → LF; sorted `hasInstallScript: true` package names in the lockfile ≠ sorted `reviewedInstallScripts`; no `## [<factory>]` in `CHANGELOG.md`; `stateSchemas` keys ≠ `STATE_DOCS`.

- [ ] **Step 1: Write failing tests**: `compareSemver("0.10.0","0.9.1") === 1`; `satisfies` true for `1.4.0`, false for `1.5.0`, throws on `^1.4.0`; `changelogBetween` 0.1.0→0.3.0 yields 0.3.0 then 0.2.0; `packageRef(m, {})` → `git:https://github.com/jrevenga/ai-factory.git@v0.1.0`; with `FACTORY_SOURCE=http://127.0.0.1:9/fixture/ai-factory.git` → that URL; `checkManifest` on a temp copy with peer `*` → one problem naming the peer; real repo → `[]`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `CHANGELOG.md` `## [0.1.0] - unreleased` listing Phase 1 deliverables.
- [ ] **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(release): add release manifest, changelog parsing and manifest check`.

### Task 5: Per-key managed Pi settings with Pi's lock

**Files:**
- Create: `src/core/settings/managed.ts`, `src/adapters/pi/settings-file.ts`, `schemas/managed-settings.schema.json`
- Modify: `scripts/gen-schemas.ts`
- Test: `test/core/settings/managed.test.ts`, `test/adapters/pi/settings-file.test.ts`

**Interfaces:**
- Produces: `ManagedRecord`: `{ schema: 1, keys: Record<string, { value: unknown; writtenAt: string; factoryVersion: string }> }` (loose).
- Produces: `DESIRED_PI_SETTINGS = { enableInstallTelemetry: false, transport: "sse" }` (A §6.2 step 3, §13 C5).
- Produces: `planManagedSettings(current, record, desired, ctx: { now: string; factoryVersion: string }): { next; record; changes: SettingChange[] }`, `SettingChange = { key; action: "set"|"updated"|"unchanged"|"kept-user-value"|"kept-foreign-value"|"released" }`.
- Produces (adapter): `withPiSettingsLock<T>(settingsPath, fn: (current: Record<string, unknown>) => Promise<{ next?: Record<string, unknown>; result: T }>): Promise<T>` — `proper-lockfile` `lock(settingsPath, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } })` (creating an empty `{}` file first if missing so the lock target exists), read (malformed → `MalformedJson`, nothing written), `fn`, atomic write when `next` given, release in `finally`; exhausted retries → `SettingsLocked { path }`. `applyManagedPiSettings(paths, factoryVersion): Promise<SettingChange[]>` (managed record at `paths.managedSettings`); `readPiSettings(path)`.

Ownership algorithm (A §5.2): absent + unrecorded → set & record; recorded and current deep-equals recorded → write desired (`updated`/`unchanged`); recorded but user changed → leave, keep record (`kept-user-value`); present but never written by the factory → leave, not recorded (`kept-foreign-value`); recorded, no longer desired, still equal → delete key & record (`released`). Keys neither desired nor recorded are untouched; unknown keys (e.g. `packages`) pass through.

- [ ] **Step 1: Write failing tests**: empty → both `set`; user changed `transport` to `websocket` after factory wrote `sse` → `kept-user-value`; pre-existing `transport: "auto"` → `kept-foreign-value`, unrecorded; desired drops `transport` while still `sse` → `released`; `packages` preserved; adapter: malformed file → `MalformedJson`, bytes unchanged; while the test holds `proper-lockfile.lockSync(path, {realpath:false})`, `applyManagedPiSettings` rejects with `SettingsLocked` and bytes unchanged; after release it succeeds and keeps a `packages` entry the test wrote under the lock just before releasing.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(settings): add per-key ownership for managed Pi settings under Pi's lock`.

### Task 6: State, lock, sessions, snapshots, journal, migration and rollback planning

**Files:**
- Create: `src/core/state/{schema,migrations,rollback-plan}.ts`, `src/adapters/store/{state-store,lock,sessions,snapshots,transaction}.ts`, `schemas/state.schema.json`
- Test: `test/core/state/*.test.ts`, `test/adapters/store/*.test.ts`

**Interfaces:**
- Produces: `FactoryState` (loose): `{ schema: 1, version: string, installedAt: string, source: string, piVersion: string, piCli: string, history: { version: string; at: string; reason: "install"|"update"|"rollback" }[] }`.
- Produces: `Migration = { id: string; doc: StateDoc; from: number; to: number; up(doc: unknown): unknown }`; `MIGRATIONS: Migration[]` (empty in 0.1.0); `planMigrations(current: Partial<Record<StateDoc, number>>, registry, targets: Record<StateDoc, number>): Migration[]` — per document; throws `NoMigrationPath { doc, from, to }`; a document already at its target needs none; `to < from` in the registry is rejected.
- Produces: `planRollback(input: { current: Partial<Record<StateDoc, number>>; target: Record<StateDoc, number>; snapshotHas: Partial<Record<StateDoc, boolean>> }): { keep: StateDoc[]; restore: StateDoc[]; refuse: StateDoc[] }` — current ≤ target → `keep`; newer and snapshot has it → `restore`; newer and no snapshot copy → `refuse` (caller aborts before any mutation).
- Produces (adapters):
  - `readState/writeState(paths)`, `readPersonalConfig/writePersonalConfig(paths)`, `loadProfiles(dir): Promise<Profile[]>`, `docSchemas(paths): Promise<Partial<Record<StateDoc, number>>>`.
  - `acquireLock(paths, opts?: { ownerPid?: number }): Promise<Lock>` — exclusive create of `lock` (`{pid, at}`); held by a live pid other than `ownerPid` → `Locked { pid }`; dead pid → replaced; `Lock.release()`.
  - Sessions: `registerSession(paths): Promise<Session>` — acquires the lock briefly (`Locked` propagates: an update is in progress), writes `sessions/<launcherPid>.json` `{ launcherPid, piPid?: number, at }`, releases the lock; `Session.setPiPid(pid)`, `Session.end()`. `liveSessions(paths): Promise<number[]>` — a record is live when either pid is alive; stale records are removed.
  - Snapshots: `createSnapshot(paths, input: { from: string; to: string; kind: "update"|"rollback"; now: Date }): Promise<SnapshotInfo>` — new `backups/<id>/` (ruling 12; existing id → throws), copies present `STATE_DOCS`, `memory.db` if present, and `pi-packages.json` (Pi settings `packages`); writes `snapshot.json` `{ id, from, to, kind, at, files }`. `listSnapshots(paths): Promise<SnapshotInfo[]>` newest first; `restoreSnapshot(paths, id, docs: string[]): Promise<void>`.
  - Journal: `beginTxn(paths, t: { id; kind; from; to; snapshot }): Promise<void>` (refuses if one exists), `readTxn(paths)`, `clearTxn(paths)`.

- [ ] **Step 1: Write failing tests**: `planMigrations` config 1→2 with target `{config:2, state:1, managed:1}` → that migration only; target config 3 → `NoMigrationPath`; `planRollback` equal → keep; config current 2/target 1/snapshot has → restore; no snapshot copy → refuse. Lock: held by current pid → `Locked`; dead pid `999999` → acquired; `ownerPid` = holder → acquired. Sessions: `registerSession` while another holder has the lock → `Locked`; record with dead launcher but live `piPid` (current process pid) → listed; both dead → removed. Snapshots: two snapshots with the same from/to at different seconds → two dirs, first untouched; `memory.db` absent → fine; restore round-trip byte-equal. Journal: second `beginTxn` throws; `clearTxn` removes.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(state): add factory state, lock, sessions, snapshots, journal and migration/rollback planning`.

### Task 7: Pi test harness, Pi package skeleton, startup handshake

**Files:**
- Create: `test/helpers/pi-harness.ts`, `test/fixtures/faux-provider.ts`, `src/core/handshake.ts`, `src/adapters/pi/extension/index.ts`
- Test: `test/core/handshake.test.ts`, `test/e2e/handshake.e2e.test.ts`
- Modify: `.github/workflows/ci.yml` (add `npm run test:e2e` after `npm test`)

**Interfaces:**
- Produces (helper): `ensureTestPi(): Promise<string>` — installs Pi `1.4.0` once into `node_modules/.cache/factory-test-pi/1.4.0` (`npm install --prefix … --ignore-scripts`), returns `cli.js`; `runPiPrint(opts: { cli; agentDir; cwd; extensions: string[]; env?; prompt?; model? /* factory-test/faux */; args?: string[]; timeoutMs? }): Promise<RunResult>` — `node <cli> -p --no-session [-e each] [...args] --model <model> <prompt ?? "go">`, env `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, stdin closed.
- Produces (fixture): registers `fauxProvider({ provider: "factory-test", models: [{ id: "faux" }] })`; responses from env `FAUX_SCRIPT` (JSON array of `{ tool, args }` → one `fauxToolCall` message each with `stopReason: "toolUse"`, then `fauxAssistantMessage("done")`).
- Produces: `evaluateHandshake(input: { expectedVersion: string | undefined; packageVersion: string; configOk: boolean; storeWritable: boolean }): HandshakeResult`, `HandshakeResult = { ok: boolean; version: string; policy: "none"; reasons: ("not-installed"|"version-mismatch"|"config-invalid"|"store-unwritable")[] }`.
- Produces: extension default export: on `session_start`, handshake inputs = `state.json` version, own `package.json` version, personal config parses, `FACTORY_HOME` writable (probe file); `pi.events.emit("factory:handshake", result)`; when `!ok`, its own `tool_call` handler blocks every tool except `read`, `grep`, `find`, `ls` with reason `factory handshake failed: <reasons>` and notifies once via `ctx.ui.notify` when available. (Covers "loaded but handshake failed" even without the guard file; the guard covers "never loaded".)

- [ ] **Step 1: Write failing tests**: unit — no state → `ok:false`, `["not-installed"]`; all good → `ok:true`, `policy:"none"`. e2e (temp `FACTORY_HOME` + agent dir): valid `state.json` `0.1.0` + `FAUX_SCRIPT` writing `<tmp>/out.txt` + `-e src/adapters/pi/extension/index.ts` → file exists; state `9.9.9` → file absent and output contains `version-mismatch`; harness self-check (faux only) → file exists.
- [ ] **Step 2: Run** `npm run test:e2e` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pi): add Pi package skeleton with startup handshake and faux-provider test harness`.

### Task 8: Guard extension

**Files:**
- Create: `guard/factory-guard.ts`
- Test: `test/guard/guard.test.ts`, `test/e2e/guard.e2e.test.ts`

**Interfaces:**
- Produces: `guard/factory-guard.ts`, self-contained (only `import type` from Pi, nothing from `src/`): `READ_ONLY_TOOLS = ["read","grep","find","ls"]`, `guardDecision(toolName: string, handshake: { ok: boolean } | undefined): { block: true; reason: string } | undefined`, default export listening on `pi.events.on("factory:handshake")` and blocking via `tool_call` with reason `factory guard: factory extension not loaded or handshake failed — run "factory doctor"`.
- Produces: `GUARD_FILE_NAME = "factory-guard.ts"`.

- [ ] **Step 1: Write failing tests**: unit — `write`/`undefined` blocks; `read`/`undefined` allows; `bash`/`{ok:true}` allows; `edit`/`{ok:false}` blocks; `codemode`/`undefined` blocks. e2e: guard in `<agentDir>/extensions/`, no factory extension, faux `write` → file absent; faux `bash` `echo x > out2.txt` → absent; faux `read` of an existing file → result has no `factory guard` error; guard + factory extension (`-e`) + valid state → write succeeds; + mismatched state → blocked. (Unresolvable refs in settings crash Pi before extensions load (S2); prevented by Task 9's ref validation, not tested here.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm run test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(guard): add guard extension that blocks writes until the factory handshake succeeds`.

### Task 9: Git, pinned Pi runtime, login and reachability adapters

**Files:**
- Create: `src/adapters/vcs/git.ts`, `src/adapters/pi/runtime.ts`, `src/adapters/providers/{logins,reachability}.ts`, `test/helpers/git-server.ts`
- Test: `test/adapters/vcs/git.test.ts`, `test/helpers/git-server.test.ts`, `test/e2e/runtime.e2e.test.ts`, `test/adapters/providers/*.test.ts`

**Interfaces:**
- Produces (helper, ruling 7): `startGitServer(projectRoot: string): Promise<{ url(repoRelPath: string): string; close(): Promise<void> }>` — `http.createServer` on `127.0.0.1:0`; each request spawns `git http-backend` with CGI env (`GIT_PROJECT_ROOT`, `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `REMOTE_ADDR`), pipes the body, parses CGI headers (`Status:` line → status code). `makeBareRepo(fromWorkTree, dest, tags: { name: string; ref?: string }[]): Promise<void>`.
- Produces: `lsRemoteTags(url, opts?): Promise<string[]>` (no `refs/tags/`, peeled lines dropped); `resolveRef(url, tag): Promise<boolean>`; `cloneTag(url, tag, dest): Promise<void>` (`git clone --quiet --depth 1 --branch <tag> <url> <dest>`); `classifyGitError(stderr): "auth-https"|"auth-ssh"|"not-found"|"network"|"unknown"` (S2 strings: `could not read Username for 'https://github.com'`, `Permission denied (publickey)`; `Repository not found`/`not found`; connection refused/timeout → `network`). All git calls: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, 60 s default timeout.
- Produces: `PiRuntime` — `ensurePinned(paths, version): Promise<string>` (reuse prefix when its Pi `package.json` version matches), `run(cli, args, opts): Promise<RunResult>` (`node <cli> …`, stdin closed, `PI_TELEMETRY=0`), `installPackage(cli, ref, opts): Promise<void>` (`git:` refs → `resolveRef` first; failure → `UnresolvableRef { ref, kind }`, Pi settings untouched), `version(cli): Promise<string>`.
- Produces: `detectLogins(opts: { piCli?: string; env? }): Promise<{ claude: LoginState; codex: LoginState }>` per ruling 6 (no `piCli` → codex `unknown`; spawn error/timeout → `unknown`; `claude` missing → `absent`).
- Produces: `checkReachability(providers: ("claude"|"codex")[], fetchFn: typeof fetch): Promise<Record<string, "reachable"|"unreachable">>` per ruling 17.

- [ ] **Step 1: Write failing tests**: `classifyGitError` both S2 strings; `startGitServer` + `makeBareRepo` with tag `v0.0.1-test`: `lsRemoteTags` contains it, `cloneTag --depth 1` works (proves smart HTTP), `resolveRef` missing tag → `false`; `http://127.0.0.1:1/x/y.git` → rejects within 15 s classified `network`. Runtime e2e: `ensurePinned` into temp `FACTORY_HOME` → `version()` `1.4.0`; second call runs no npm (spy); **`runs pinned pi, not PATH pi`**: fake `pi` on `PATH` writing a marker → `run(cli,["--version"])` is `1.4.0`, no marker; `installPackage` of `git:<served>/fixture/ai-factory.git@v9.9.9` → `UnresolvableRef`, `<agentDir>/settings.json` absent; `installPackage` of `@v0.0.1-test` → Pi settings `packages` contains the ref. Logins: empty agent dir → codex `absent`; `PATH` without `claude` → claude `absent`. Reachability: fake fetch resolving → `reachable`; rejecting → `unreachable`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test && npm run test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(adapters): add git, pinned Pi runtime, login detection and provider reachability`.

### Task 10: CLI entry, router and `factory doctor`

**Files:**
- Create: `bin/factory.mjs`, `src/cli/main.ts`, `src/cli/io.ts`, `src/cli/commands/doctor.ts`
- Test: `test/cli/main.test.ts`, `test/cli/doctor.test.ts`

**Interfaces:**
- Produces: `bin/factory.mjs` — `#!/usr/bin/env node`; filters only `ExperimentalWarning` whose message matches `/SQLite/` (A §4 [builder]; other warnings still printed); `createJiti(import.meta.url)`, `await jiti.import("../src/cli/main.ts")`, `process.exitCode = await main(process.argv.slice(2))`.
- Produces: `main(argv, io?: CliIO): Promise<number>`; commands: none → launcher (Task 13), `install`, `doctor [--offline] [--json]`, `update [--to <v>] [--yes]`, `rollback [<v>] [--yes]`, `init [--yes]`, `config explain <key>`, `version`, hidden `_apply-release`. Unknown → usage, exit 2; `runs|eval|radar` → `factory <cmd> arrives in a later phase`, exit 2. `node:util` `parseArgs`.
- Produces: `CliIO = { out(s): void; err(s): void; confirm(q): Promise<boolean>; isTTY: boolean }` (no TTY → `false` unless `--yes`).
- Produces: `runDoctor(ctx: { paths; env; offline: boolean; manifest: ReleaseManifest; fetchFn?: typeof fetch }): Promise<DoctorCheck[]>`, `DoctorCheck = { id; status: "ok"|"warn"|"fail"; message; fix? }`; exit 1 on any `fail`.

Check ids (A §6.2): `node-version`, `node-sqlite-fts5` (in-memory FTS5 `unicode61 remove_diacritics 2`, `decision` matches `Decisión`), `git`, `npm`, `npm-prefix-writable` (fix never suggests sudo), `factory-home-writable`, `state` (parses; version = `manifest.factory`), `txn` (pending journal → fail, fix `factory rollback`), `pi-pinned` (cli exists, version = `manifest.pi.version`), `pi-settings` (parses), `managed-settings` (warn per `kept-user-value`/`kept-foreign-value`; `transport` ≠ `sse` → warn "Codex limits will be unknown"), `factory-package` (Pi `packages` contains `packageRef(manifest, env)`), `guard` (file equals shipped bytes), `source-override` (warn when `FACTORY_SOURCE` set), `logins` (both non-present → fail with both login instructions), online only: `repo-access` (`lsRemoteTags(effectiveSource)`, classified fix text incl. the Windows non-interactive credentials note, A §6.2) and `provider-reachability`, plus `parallelism` (warn when configured > `max(1, min(8, floor(totalmem GiB / 4)))`).

- [ ] **Step 1: Write failing tests**: `main(["nope"])` → 2; `version` prints `0.1.0`; `runs` → 2 with message. Doctor, empty temp env → `state` and `pi-pinned` fail, each failing check has `fix`; **`offline doctor makes no network call`**: offline + `FACTORY_SOURCE=http://127.0.0.1:1/x/y.git` + a `fetchFn` that throws if called → no `repo-access`/`provider-reachability`, < 5 s; online → `repo-access` fail `network` < 20 s; `factory-package` ok when Pi settings contain `packageRef` built from the `FACTORY_SOURCE` override; modified guard → fail with fix `factory install`; pending `txn.json` → `txn` fail; `node-sqlite-fts5` ok.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `node bin/factory.mjs version` prints `0.1.0`, empty stderr.
- [ ] **Step 5: Commit** `feat(cli): add factory entry point, command router and doctor`.

### Task 11: `_apply-release`, `factory install`, npx bootstrap, broken-install acceptance

**Files:**
- Create: `src/cli/commands/{apply-release,install}.ts`
- Test: `test/cli/apply-release.test.ts`, `test/cli/install.test.ts`, `test/e2e/broken-install.e2e.test.ts`

**Interfaces:**
- Produces: `applyRelease(ctx: ApplyContext, opts: { reason: "install"|"update"|"rollback"; from?: string; parentLockPid?: number; profile?: string }): Promise<void>`, `ApplyContext = { paths; env; manifest /* own release.json */; io; pi: PiRuntime; now(): Date }`. CLI contract: `factory _apply-release --reason <r> [--from <v>] [--parent-lock <pid>] [--profile <name>] [--yes]`.
  Order: (1) acquire lock (`ownerPid = parentLockPid`); (2) **copy the guard to `paths.piExtensions` first** (tmp + rename) so every later failure leaves writes blocked; (3) `pi.ensurePinned`; (4) `pi.installPackage(packageRef(manifest, env))`; (5) bridge when `detectLogins().claude === "present"`; (6) `applyManagedPiSettings`; (7) create personal config from `--profile` or `proposeProfile` if missing (never overwrite; no profile available → stop with the login instructions); (8) `planMigrations(docSchemas, MIGRATIONS, manifest.stateSchemas)` and apply; (9) write `state.json` **last** (`version`, `piCli`, history entry); (10) `clearTxn`; (11) offline doctor printed. Failure before (9): previous `state.json` untouched; message `Install did not complete: <error>. Previous state kept. Run "factory doctor"; after an update run "factory rollback".`; lock released.
- Produces: `install(ctx, opts: { yes: boolean; profile?: string }): Promise<number>` — minimum requirements (`node-version`, `node-sqlite-fts5`, `git`, `npm`, `npm-prefix-writable`; fail → fixes, exit 1); **bootstrap** when the CLI's own real path contains `/_npx/` or `\_npx\`: `npm install -g --legacy-peer-deps <npmInstallSpec(manifest, env)>`, then run `<npm root -g>/ai-factory/bin/factory.mjs install …same flags` with `process.execPath`, return its code; otherwise `applyRelease({ reason: "install" })`.

- [ ] **Step 1: Write failing tests** (fake `PiRuntime`, temp paths): order guard → `ensurePinned` → `installPackage(git:…@v0.1.0)` → state with `history[0].reason === "install"`; claude `absent` → no bridge; existing `config.json` bytes unchanged; **`apply failure leaves previous state.json`**: `installPackage` throws `UnresolvableRef` → previous state bytes unchanged, output has `Previous state kept`, guard present, lock released; bootstrap detection for `/home/u/.npm/_npx/abc/node_modules/ai-factory/bin/factory.mjs` (and the Windows form) → true; global path → false. **Acceptance e2e** `broken-install.e2e.test.ts`: empty temp agent dir and `FACTORY_HOME`, `FACTORY_SOURCE` = served fixture URL, real `PiRuntime`, apply for a tag that does not exist → apply fails; then real pinned Pi + faux `write` → file absent (guard installed by the failed apply blocks it).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test && npm run test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(cli): add factory install, npx bootstrap and the shared apply-release step`.

### Task 12: `factory update` and `factory rollback`

**Files:**
- Create: `src/cli/commands/{update,rollback}.ts`
- Test: `test/cli/update.test.ts`, `test/cli/rollback.test.ts`

**Interfaces:**
- Consumes: `applyRelease` contract, snapshots, journal, `planRollback`, `liveSessions`, `acquireLock`, `lsRemoteTags`, `cloneTag`, `changelogBetween`, `npm`, `effectiveSource`.
- Produces: `update(ctx, opts: { to?: string; yes: boolean }): Promise<number>`:
  1. pending journal → exit 1 (`A previous update did not finish. Run "factory rollback".`);
  2. **acquire lock**, then under it: `liveSessions` non-empty → release, exit 1 (`Close factory sessions first: pids …`);
  3. target = `--to` or highest `v*` tag > `state.version`; none → `Already up to date`, exit 0; `--to` tag missing → exit 1 before any mutation (**`update aborts before swap on unresolvable tag`**);
  4. `cloneTag` into a temp dir; read target `release.json`/`CHANGELOG.md`; print `changelogBetween`; target `node.min` > running Node → exit 1 with fix;
  5. `confirm("Update factory <a> → <b>?")` (or `--yes`);
  6. `createSnapshot({from:a,to:b,kind:"update"})`, `beginTxn`;
  7. `npm install -g --legacy-peer-deps <npmInstallSpec(target, env)>`;
  8. run the new global CLI `_apply-release --reason update --from <a> --parent-lock <pid> --yes` (it clears the journal on success); release lock; exit with its code. Failure in 7–8 → `Update failed. Your previous state is in snapshot <id>. Run "factory rollback".`
- Produces: `rollback(ctx, opts: { version?: string; yes: boolean }): Promise<number>`:
  1. acquire lock; live sessions → exit 1;
  2. **recovery mode** when a journal exists: target = `txn.from`, snapshot = `txn.snapshot`, restore **every** file in it; else **normal mode**: target = `opts.version` or the most recent `history` version ≠ `state.version`; snapshot = newest with `from === target`, whatever its `to` (a snapshot taken when leaving the target version holds that version's state, even after later upgrades; none → `planRollback` treats every doc as unsnapshotted);
  3. `cloneTag` target; read its `stateSchemas`;
  4. normal mode: `planRollback`; any `refuse` → exit 1 before mutation (`Cannot roll back <docs>: no snapshot holds a compatible copy.`); `restore` non-empty → print `Rolling back loses changes in: <docs>` and confirm (`--yes` accepts);
  5. `createSnapshot({from:current,to:target,kind:"rollback"})` (new dir; the recovery snapshot is never overwritten); `restoreSnapshot(chosen, docs)`;
  6. `npm install -g --legacy-peer-deps <target spec>`; run target CLI `_apply-release --reason rollback --from <current> --parent-lock <pid> --yes`; clear the journal (recovery mode) after it succeeds; release lock.

- [ ] **Step 1: Write failing tests** (fakes for npm/git/apply; temp paths): update picks `v0.2.0` over `v0.1.0`/`v0.1.1`; `--to v9.9.9` → exit 1, no snapshot dir, no journal; a session registered before `update` → exit 1; a session registration attempted while update holds the lock → `Locked`; happy-path order snapshot → journal → npm `-g --legacy-peer-deps` → apply with `--parent-lock <process.pid>`. Rollback normal: default target = previous history version; equal schemas → current `config.json` kept (post-upgrade edits preserved); config schema 2 vs target 1 with snapshot → restored + loss message; without snapshot copy → exit 1 and installation/state bytes unchanged; three releases `1.0.0 → 2.0.0 → 3.0.0` (snapshots `1.0.0-to-2.0.0`, `2.0.0-to-3.0.0`), config schema 2 at 3.0.0, `rollback 1.0.0` (target schema 1) → restores `config.json` from the `1.0.0-to-2.0.0` snapshot. **`failed update after migration recovers exactly`**: simulate update where the fake apply migrates `config.json` and then throws before writing state → journal remains; `rollback` → recovery mode restores the pre-update `config.json` bytes, the recovery snapshot dir is unchanged, a new rollback snapshot exists, apply called for `v0.1.0`, journal cleared.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): add factory update and rollback with immutable snapshots and recovery`.

### Task 13: Launcher, `factory init`, `factory config explain`

**Files:**
- Create: `src/cli/commands/{launch,init,config}.ts`
- Test: `test/cli/{launch,init,config}.test.ts`

**Interfaces:**
- Produces: `launch(ctx, piArgs: string[]): Promise<number>` — `piArgs` containing `--no-extensions` or `-ne` → exit 2 with reason (ruling 16); offline doctor: any `fail` in `state`, `txn`, `pi-pinned`, `factory-package`, `guard` → print with fixes, exit 1, Pi not started; other findings → one summary line; `registerSession` (`Locked` → exit 1 `A factory update is in progress`); spawn `process.execPath [state.piCli, ...piArgs]` with inherited stdio (not `runBounded`); `session.setPiPid(child.pid)`; SIGTERM/SIGHUP received by the launcher are forwarded to the child, and the launcher waits for the child before exiting; on exit `session.end()`; return the child's code (signal → `128 + n`).
- Produces: `init(ctx, opts: { yes; cwd }): Promise<number>` — requires a git repo; creates `<root>/.factory/`: `config.json` (`{ "schema": 1 }`), `knowledge/index.md` and `knowledge/conventions.md` (YAML frontmatter `type: index` / `type: conventions`, `schema: 1`, A §9.2), `knowledge/{specs,tasks,decisions,plans,ideas}/.gitkeep`, `.gitignore` with `worktrees/`. Never overwrites; when `.factory/` exists, lists additions and confirms first.
- Produces: `configExplain(ctx, key): Promise<number>` — layers from core defaults, personal, project (git root of `cwd`); prints `key = <json>  (from <source>)`, `overrides: <source>=<json>` lines and violations; unknown key → exit 1.

- [ ] **Step 1: Write failing tests**: launch `-ne` → 2, no spawn; missing state → 1, no spawn; fake `piCli` script recording argv and exiting 3 → returns 3, argv forwarded, session record had `piPid`, removed afterwards; sending SIGTERM to the launcher (POSIX) while the fake child sleeps → child receives SIGTERM, launcher exits only after it; registration while another process holds the update lock → 1. init in a temp git repo → files with frontmatter; second run → bytes unchanged; outside git → 1. `config explain autonomy` with personal `high` → `autonomy = "high"  (from personal)` and `overrides: core="medium"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): add launcher, factory init and config explain`.

### Task 14: End-to-end install and update → rollback round-trip in CI

**Files:**
- Create: `test/e2e/roundtrip.e2e.test.ts`, `.github/workflows/e2e.yml`, `README.md`
- Modify: `.github/workflows/ci.yml` only if the e2e suite moves out of it (it stays in `e2e.yml`; `ci.yml` keeps the faster e2e files from Tasks 7–11)

**Interfaces:**
- Consumes: everything above; `startGitServer`, `makeBareRepo`.

Flow (sequential, one spaced temp root holding `FACTORY_HOME`, `PI_CODING_AGENT_DIR`, `npm_config_prefix`, `npm_config_cache`; `PATH` prefixed with the temp prefix's bin dir):
1. Fixture releases from current `HEAD` in a temp clone (never committed to the real repo): `v0.1.0` = `HEAD`; `v0.2.0` = a commit on top setting `package.json`/`release.json` `factory` `0.2.0` and adding `## [0.2.0]` to `CHANGELOG.md` (additive release: same `stateSchemas`, same lockfile). Served by `startGitServer`; `FACTORY_SOURCE` = its URL.
2. **Bootstrap** `npx -y git+<served>#v0.1.0 install --yes --profile codex-only`, timed; exit 0; global `factory` in the temp prefix; `state.json` `0.1.0`; Pi `packages` contains `git:<served>@v0.1.0`; `transport: "sse"`, `enableInstallTelemetry: false`; guard present; `factory doctor --offline --json`: only `logins` (no logins on CI) and `source-override` may be non-ok.
3. `factory update --to v0.2.0 --yes` → `state.json` `0.2.0`; a snapshot `*-0.1.0-to-0.2.0` exists; Pi package ref `@v0.2.0`; no `txn.json`; doctor as in step 2.
4. User edit after the update: personal config `language: "es"`.
5. `factory rollback --yes` → `state.json` `0.1.0`; `config.json` still has `language: "es"` (compatible schemas keep current data, ruling 11); Pi package ref `@v0.1.0`; `factory version` prints `0.1.0`; snapshot `*-0.1.0-to-0.2.0` unchanged and a `*-0.2.0-to-0.1.0` snapshot exists; doctor as in step 2.
6. Step-2 wall time < 600 s, printed (A §3).

`.github/workflows/e2e.yml`: on `push` to `master`, `pull_request` and `workflow_dispatch`; matrix `ubuntu-latest`/`windows-latest` × Node `22.19.0`/`24`; spaced checkout on Windows; `npm ci`; `npx vitest run test/e2e/roundtrip.e2e.test.ts`; `timeout-minutes: 20`; no secrets (local server; Pi from the public npm registry).

`README.md`: requirements (A §6.2 minimum requirements), install (bootstrap + fallback), `factory`, `doctor`, `update`, `rollback`, `init`, `config explain`; short.

- [ ] **Step 1: Write the e2e test.**
- [ ] **Step 2: Run** `npx vitest run test/e2e/roundtrip.e2e.test.ts` locally → PASS (defects found in earlier code are fixed here, each with a regression test in the owning test file).
- [ ] **Step 3: Push the branch** (controller; the branch is not `master`) and run both workflows; Expected: 4/4 legs green each; record step-2 time per leg.
- [ ] **Step 4: Commit** `test(e2e): verify bootstrap install and update/rollback round-trip on Linux and Windows`.

---

## Phase completion checklist (controller, after Task 14)

- Acceptance 1: e2e step-2 time < 600 s on all 4 legs.
- Acceptance 2: e2e steps 3–5 green on all 4 legs.
- Acceptance 3: `test/e2e/broken-install.e2e.test.ts` and `test/e2e/guard.e2e.test.ts` green on all 4 legs.
- Final whole-branch review by Codex (latest Sol, `xhigh`).
- Merge to `master`, push and tag `v0.1.0` only with the owner's go-ahead (outward-facing).
