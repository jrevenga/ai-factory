# Phase 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable, updatable, rollback-able factory skeleton: TypeScript repo with enforced layers, CI on Linux and Windows, release manifest, config layering with provenance, profiles, per-key managed Pi settings, `factory install/doctor/update/rollback/init/config explain`, the launcher, the startup handshake and the guard extension.

**Architecture:** One npm package that is both a Pi package (extension loaded by Pi's jiti from TypeScript source) and the `factory` CLI (a tiny `.mjs` bin that loads the same TypeScript source through `jiti`). `src/core` holds pure domain logic (config, manifest, managed-settings ownership, state/migration planning); `src/adapters` does all I/O (processes, files, git, npm, Pi); `src/cli` wires commands. Every install/update/rollback converges on one internal command, `factory _apply-release`, run by the CLI version being installed.

**Tech Stack:** Node ≥ 22.19 (ESM), TypeScript 7.0.2 (`tsc --noEmit` only), vitest 5.0.5, zod 4.6.7 (schemas + JSON Schema export), jiti 2.7.0 (same version Pi 1.4.0 uses), Pi 1.4.0, pi-claude-bridge 0.9.3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-31-ai-factory-design.md` (A). Phase row: A §15 "1. Foundations". Evidence: `docs/superpowers/spikes/2026-10-31-phase0-report.md`. The methodology spec (`2026-10-31-factory-methodology-design.md`) has no Phase 1 deliverables.

**Acceptance (A §15):** CI install < 10 min on clean runners; update → rollback round-trip restores state; a broken package install leaves write tools blocked.

## Builder rulings taken while planning

Each is `ruling — why — cost if wrong`. Verified facts are marked (verified 2026-10-31).

1. **npm + `package-lock.json`, not pnpm**, for this repo — Pi installs a git package by running `npm install --omit=dev --legacy-peer-deps` in the checkout (Pi 1.4.0 `dist/core/package-manager.js` `getGitDependencyInstallArgs`, verified), so only `package-lock.json` makes the Pi-side install reproducible (A §6.1 manifest) — switching later means regenerating one lockfile. The global "use pnpm" rule governs the developer environment; the product's install path is dictated by Pi.
2. **No build step; TypeScript source everywhere**: imports use explicit `.ts` specifiers (`allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly`); Pi loads the extension through its own jiti (proven in S2); the CLI bin loads `src/cli/main.ts` through `jiti` 2.7.0 as a runtime dependency. Node's built-in type stripping is not usable because Node refuses it for files under `node_modules` (where a global install lives) — cost if wrong: add a `dist/` build later; source layout does not change.
3. **Layer lint = a repo script** (`scripts/check-layers.ts`, run by `npm run lint` in CI) instead of an ESLint plugin — fewer dependencies, same enforcement (A §5.1 "lint rule in CI") — cost: swap for ESLint later.
4. **Pinned Pi lives in a factory-owned prefix** `~/.factory/pi/<version>/` (`npm install --prefix … --ignore-scripts @earendil-works/pi-coding-agent@<version>`), and the factory always runs it as `node <prefix>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`. A user's own `pi` on PATH (e.g. the owner's installer-managed 1.3.0/1.4.0) is never replaced or shadowed, and rollback keeps old prefixes side by side. Satisfies A §6.2 step 1 "user-level install" — cost if wrong: one adapter.
5. **Peer dependency handling (A §6.2/C2, [builder])**: `peerDependencies` pins `@earendil-works/pi-coding-agent` to the manifest's exact Pi version (a manifest check enforces equality), and every factory-run global install uses `--legacy-peer-deps`. The `npx` bootstrap cannot pass flags to npx's own install, so the exact pin guarantees that whatever npx auto-installs is the manifest's version — cost: npx downloads Pi once into its cache.
6. **Login detection without reading credentials**: Claude = `claude auth status --json` exit code / `loggedIn` field (Claude Code 2.1.316 has the subcommand, verified); Codex = the pinned Pi's `--list-models openai-codex` (offline, stdin closed) lists at least one `openai-codex/` model. No `auth.json` is ever opened — cost if wrong: a detection reports `unknown`, doctor says so.
7. **Local release fixtures over dumb HTTP**: Pi 1.4.0 rejects `git:file://…` (`Path does not exist`, verified) but installs `git:http://127.0.0.1:<port>/fixture/ai-factory.git@<tag>` from a static file server over a bare repo after `git update-server-info` (verified). CI's round-trip uses that; production uses `https://github.com/jrevenga/ai-factory.git`. The source is overridable only through `FACTORY_SOURCE` (dev/test; `doctor` warns when set).
8. **Guard ↔ handshake transport**: `pi.events` (`factory:handshake`); a listener in one extension receives an event emitted by another at `session_start` regardless of load order (verified with Pi 1.4.0, both orders). The guard allows only `read`, `grep`, `find`, `ls` until it receives `{ ok: true }`. Any extension could spoof the event; this is a guardrail (A §11), not a boundary.
9. **CI model-free Pi tests use Pi's faux provider**: a test extension registers `fauxProvider({ provider: "factory-test", models: [{ id: "faux" }] })` from `@earendil-works/pi-ai` with scripted tool calls; `pi -p --model factory-test/faux` then exercises real `tool_call` hooks offline with no credentials (verified: a scripted `write` ran with no blocker and was blocked by a `tool_call` blocker).
10. **Rollback order**: the *newer* CLI (the one running `factory rollback`) restores the state backup and only then installs the older CLI and runs the older CLI's `_apply-release --reason rollback`, so older versions never need rollback knowledge. `_apply-release` flags are a compatibility contract from v0.1.0 on (tested by the round-trip e2e).
11. **Out of scope here, by spec phase**: the C4 marker-control test (first step of the bridge isolation work, which belongs with roles in Phase 4/5), C12 (Codex adapter, Phase 9), GatePolicy (Phase 2; the handshake reports `policy: "none"` in Phase 1), memory DB creation (Phase 6; backups copy `memory.db` if it exists).

## Global Constraints

- Node `>=22.19.0` (`engines`); CI matrix Node `22.19.0` and `24` on `ubuntu-latest` and `windows-latest`; Windows legs check out into a directory whose name contains a space (as in `.github/workflows/spike-phase0.yml`).
- Exact pins (release manifest): Pi `@earendil-works/pi-coding-agent` `1.4.0`; `pi-claude-bridge` `npm:pi-claude-bridge@0.9.3`; supported Pi range `>=1.4.0 <1.5.0`.
- Production source: `https://github.com/jrevenga/ai-factory.git`; tags `v<semver>`; first release of this phase `0.1.0`.
- Runtime `dependencies` only `zod` `4.6.7` and `jiti` `2.7.0` (exact). Host packages (`@earendil-works/*`, `typebox`) are never in `dependencies` (Pi docs/packages.md).
- Never use sudo/admin; everything user-level. Never read, print or upload any `auth.json`. Never write the real `~/.pi/agent` or `~/.factory` from tests: tests set `FACTORY_HOME`, `PI_CODING_AGENT_DIR` and a temp `npm_config_prefix`/`npm_config_cache` under a per-test temp dir whose path contains a space.
- Every Pi process started by factory code or tests: stdin closed (A §7.3/C10), `PI_TELEMETRY=0`; tests also `PI_OFFLINE=1`.
- No `shell: true` anywhere. `.cmd` executables on Windows run through `cmd.exe /d /s /c ""<exe>" <args>"` with `windowsVerbatimArguments: true` (S10 fix).
- npm is located via `npm_execpath`, else `npm` on PATH — never relative to `process.execPath` (A §6.2/C3).
- Every `git:` package ref is resolved with `git ls-remote` before it is written to Pi settings; abort on failure (A §6.2/C1).
- Git and npm child processes get `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` and a timeout; nothing may hang on a credential prompt.
- Factory state under `FACTORY_HOME` (default `~/.factory`); Pi agent dir = `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
- `core` imports nothing from `adapters`/`cli`, no `@earendil-works/*`, no `node:fs`, `node:child_process`, `node:os`, `node:net`, `node:http`; `adapters` never imports `cli`; `cli` never imports `src/adapters/pi/**` (Pi-process code); only `src/adapters/pi/**`, `guard/**` and `test/**` may import `@earendil-works/*`, and outside `test/**` only with `import type`.
- `.gitattributes`: `* text=auto eol=lf` (CRLF breaks hashes and Git Bash scripts).
- Artifacts in English; conventional commits, no AI attribution.

## Review Focus

1. **Spaces and backslashes in paths** (`C:\Users\a b\…`, the owner's `C:\Users\jorge\ai factory\…`): every spawn, settings path and Pi package path must work. Pinned by: per-test temp dirs containing a space (Task 1 helper) and the Windows CI checkout dir.
2. **Hand-edited or malformed Pi `settings.json`**: the factory must never clobber it; malformed JSON aborts with the file path and no write. Pinned by Task 5 tests `refuses malformed settings` and `keeps user-edited key`.
3. **Failure halfway through install/update** (network drop, bad tag, Ctrl+C): state must stay coherent and the message must name the recovery (`factory rollback` or rerun). Pinned by Task 11 `apply failure leaves previous state.json` and Task 12 `update aborts before swap on unresolvable tag`.
4. **A user's own Pi already on PATH at another version**: the factory uses only its pinned Pi and leaves the user's untouched. Pinned by Task 9 `runs pinned pi, not PATH pi`.
5. **No git credentials or offline**: doctor/install must explain (S2 strings) within the timeout, never hang. Pinned by Task 9 `classifies credential errors` and Task 10 `offline doctor makes no network call`.

---

## File structure

```
package.json, package-lock.json, tsconfig.json, vitest.config.ts, .gitattributes, .gitignore
release.json                      release manifest (Task 4)
CHANGELOG.md                      Keep-a-Changelog style, one "## [x.y.z]" section per release
bin/factory.mjs                   jiti loader for src/cli/main.ts
schemas/*.schema.json             generated from zod (Task 3/4/5/6), freshness-checked in CI
profiles/claude-codex.json, profiles/codex-only.json   core data (Task 3)
defaults/config.json              core defaults layer (Task 3)
guard/factory-guard.ts            guard extension, copied into <piAgentDir>/extensions/ (Task 8)
skills/.gitkeep, prompts/.gitkeep Pi package resource dirs (empty in Phase 1)
scripts/check-layers.ts           layer lint (Task 1)
scripts/gen-schemas.ts            writes schemas/ (Task 3)
scripts/manifest-check.ts         release manifest consistency (Task 4)
src/core/config/{schema.ts,resolve.ts,explain.ts}
src/core/profiles/{schema.ts,propose.ts}
src/core/release/{manifest.ts,changelog.ts,semver.ts}
src/core/settings/managed.ts
src/core/state/{schema.ts,migrations.ts,rollback-plan.ts}
src/core/handshake.ts
src/adapters/platform/{process.ts,paths.ts,json-file.ts,npm.ts}
src/adapters/vcs/git.ts
src/adapters/pi/{runtime.ts,settings-file.ts,extension.ts}
src/adapters/providers/logins.ts
src/adapters/store/{state-store.ts,lock.ts,backup.ts}
src/cli/{main.ts,io.ts}
src/cli/commands/{doctor.ts,install.ts,apply-release.ts,update.ts,rollback.ts,launch.ts,init.ts,config.ts}
test/helpers/{tmp.ts,pi-harness.ts,git-server.ts}
test/fixtures/faux-provider.ts
test/** mirrors src/**; test/e2e/{guard.e2e.test.ts,roundtrip.e2e.test.ts}
.github/workflows/ci.yml, .github/workflows/e2e.yml
```

---

### Task 1: Toolchain, layout, layer lint, CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitattributes`, `.gitignore`, `scripts/check-layers.ts`, `test/helpers/tmp.ts`, `test/scripts/check-layers.test.ts`, `test/helpers/tmp.test.ts`, `.github/workflows/ci.yml`, `skills/.gitkeep`, `prompts/.gitkeep`
- Keep untouched: `spikes/`, `.github/workflows/spike-phase0.yml`

**Interfaces:**
- Produces: `npm run typecheck` (`tsc --noEmit`), `npm run lint` (`typecheck` + `node scripts/check-layers.ts` via jiti), `npm test` (`vitest run --exclude test/e2e/**`), `npm run test:e2e` (`vitest run test/e2e`).
- Produces: `checkLayers(root: string): LayerViolation[]` where `LayerViolation = { file: string; line: number; specifier: string; rule: string }`.
- Produces: `makeTmp(prefix: string): Promise<{ dir: string; cleanup(): Promise<void> }>` — creates `os.tmpdir()/<prefix> <random>` (path always contains a space); `cleanup` refuses any path not under `os.tmpdir()`.

`package.json` essentials: `"name": "ai-factory"`, `"version": "0.1.0"`, `"type": "module"`, `"private": true`, `"bin": { "factory": "bin/factory.mjs" }`, `"keywords": ["pi-package"]`, `"pi": { "extensions": ["./src/adapters/pi/extension.ts"], "skills": ["./skills"], "prompts": ["./prompts"] }`, `"engines": { "node": ">=22.19.0" }`, `"dependencies": { "zod": "4.6.7", "jiti": "2.7.0" }`, `"peerDependencies": { "@earendil-works/pi-coding-agent": "1.4.0" }`, devDependencies exact: `typescript 7.0.2`, `vitest 5.0.5`, `@types/node` latest `22.x` (match the Node floor), `@earendil-works/pi-coding-agent 1.4.0` (types + faux harness), `@earendil-works/pi-ai 1.4.0`. `"files"` is not used (git installs take the whole tree).

`tsconfig.json`: `strict`, `noEmit`, `module`/`moduleResolution` `nodenext`, `target` `es2023`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, include `src scripts test guard bin`.

Layer rules for `checkLayers` (from Global Constraints), each a named rule: `core-no-adapters`, `core-no-cli`, `core-no-io-builtins`, `core-no-pi`, `adapters-no-cli`, `cli-no-pi-adapter`, `pi-import-type-only`. Scan `import … from "x"`, `export … from "x"`, `import("x")` in `.ts/.mjs` under `src/`, `guard/`, `scripts/`, `bin/`.

- [ ] **Step 1: Write failing tests** `test/scripts/check-layers.test.ts`: build a temp tree with `src/core/a.ts` importing `../adapters/x.ts` → one violation `core-no-adapters` at line 1; `src/core/b.ts` importing `node:fs` → `core-no-io-builtins`; `src/adapters/pi/c.ts` with `import { x } from "@earendil-works/pi-coding-agent"` → `pi-import-type-only`, and with `import type` → none; `src/cli/d.ts` importing `../adapters/pi/extension.ts` → `cli-no-pi-adapter`; the real repo root → `[]`. `test/helpers/tmp.test.ts`: dir contains a space and exists; `cleanup` removes it.
- [ ] **Step 2: Run** `npm test` → FAIL (module not found).
- [ ] **Step 3: Implement** the files above; `npm install` to produce `package-lock.json`.
- [ ] **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: CI** `.github/workflows/ci.yml`: on `push` and `pull_request`; matrix as Global Constraints (`fail-fast: false`, spaced checkout dir on Windows, `shell: bash`); steps `actions/checkout@v4`, `actions/setup-node@v4`, `npm ci`, `npm run lint`, `npm test`; `timeout-minutes: 15`; `permissions: contents: read`.
- [ ] **Step 6: Commit** `chore: scaffold TypeScript toolchain, layer lint and CI`.

### Task 2: Platform adapter — processes, npm, paths, JSON files

**Files:**
- Create: `src/adapters/platform/process.ts`, `src/adapters/platform/npm.ts`, `src/adapters/platform/paths.ts`, `src/adapters/platform/json-file.ts`
- Test: `test/adapters/platform/{process,npm,paths,json-file}.test.ts`, fixtures `test/fixtures/proc/{spawn-tree.mjs,ignore-term.mjs}`

**Interfaces:**
- Produces:
  - `runBounded(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<RunResult>`; `RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; orphans: boolean }`. Port of `spikes/phase0/pi.mjs` `spawnBounded`/`terminateTree` (POSIX detached group, SIGTERM → SIGKILL after 2 s, poll until gone; Windows awaited `taskkill /PID <pid> /T /F`; one cancellation path; parent SIGINT/SIGTERM tears down active children). `.cmd`/`.bat` targets on Windows are wrapped per Global Constraints. Stdin is always closed (written `input ?? ""` then ended).
  - `resolveNpm(env?: NodeJS.ProcessEnv): { cmd: string; args: string[] }` — `npm_execpath` ending in `.js`/`.cjs` → `[process.execPath, [execpath]]`; else `npm` on PATH (Windows: `npm.cmd`, and when `<dir>/node_modules/npm/bin/npm-cli.js` exists next to it use `[process.execPath, [that]]`). Throws `NpmNotFound` with a fix message.
  - `npm(args: string[], opts): Promise<RunResult>` using `resolveNpm` + `runBounded`, env adds `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`.
  - `factoryPaths(env?: NodeJS.ProcessEnv): FactoryPaths` — `{ home, config, state, managedSettings, memoryDb, backups, sessions, lock, piPrefixes, piAgentDir, piSettings, piExtensions }` (`home` = `FACTORY_HOME` or `~/.factory`; `piAgentDir` = `PI_CODING_AGENT_DIR` or `~/.pi/agent`; `piSettings` = `<piAgentDir>/settings.json`; `piExtensions` = `<piAgentDir>/extensions`).
  - `readJson(path): Promise<unknown | undefined>` (undefined when missing; throws `MalformedJson { path }` on parse error); `writeJsonAtomic(path, value): Promise<void>` (write `<path>.tmp-<pid>`, fsync, rename; 2-space indent + trailing newline).

- [ ] **Step 1: Write failing tests**: `runBounded` returns stdout/exit of `node -e`; timeout of `spawn-tree.mjs` (spawns a grandchild that writes its pid to a file and runs `ignore-term.mjs`) resolves `timedOut: true` and afterwards `process.kill(grandchildPid, 0)` throws `ESRCH` — runs on Linux AND Windows (this exercises the Windows teardown path Phase 0 did not, A §7.3); `AbortSignal` cancels the same way; stdin is closed (`node -e "process.stdin.resume();process.stdin.on('end',()=>process.exit(7))"` → code 7). `resolveNpm` with `npm_execpath=/x/npm-cli.js` → `[process.execPath, ["/x/npm-cli.js"]]`; with no PATH entry → throws `NpmNotFound`. `factoryPaths({FACTORY_HOME: "/a b", PI_CODING_AGENT_DIR: "/c d"})` fields. `writeJsonAtomic` then `readJson` round-trips; `readJson` on `{bad` throws `MalformedJson` with the path.
- [ ] **Step 2: Run** `npx vitest run test/adapters/platform` → FAIL.
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4: Run** → PASS (locally Linux; Windows via CI).
- [ ] **Step 5: Commit** `feat(platform): add bounded process runner, npm resolution, paths and atomic JSON`.

### Task 3: Config layering, provenance, profiles

**Files:**
- Create: `src/core/config/{schema.ts,resolve.ts,explain.ts}`, `src/core/profiles/{schema.ts,propose.ts}`, `defaults/config.json`, `profiles/claude-codex.json`, `profiles/codex-only.json`, `scripts/gen-schemas.ts`, `schemas/{personal-config,project-config,profile}.schema.json`
- Test: `test/core/config/*.test.ts`, `test/core/profiles/*.test.ts`, `test/scripts/gen-schemas.test.ts`

**Interfaces:**
- Produces (zod schemas, exported with inferred types):
  - `CoreConfig` (`defaults/config.json`): `{ schema: 1, autonomy: "low"|"medium"|"high" = "medium", parallelism: int 1..16 = 3, language?: string, radar: false, maintainer: false, gates: { hard: string[]; soften: SoftGateId[] = [] }, budgets: Record<ProviderId, { weeklyTokens?: number }> = {} }` with `SoftGateId = "design-approval"|"new-dependency"|"design-deviation"|"review-disagreement"|"quota-low"` (A §8.2) and `gates.hard` = `["destructive","remote-mutation","secrets","integration","outside-root-write"]` (A §8.1).
  - `PersonalConfig`: `{ schema: 1, profile: string, autonomy?, parallelism?, language?, radar?, maintainer?, gates?: { soften?: SoftGateId[] }, budgets?, machine?: Record<string,string> }`.
  - `ProjectConfig` (`.factory/config.json`): `{ schema: 1, minFactoryVersion?: string, context?: string, conventions?: string, overrides?: { language?: string; gates?: { soften?: SoftGateId[] } } }`.
  - `Profile`: `{ schema: 1, name: string, requires: ("claude"|"codex")[], roles: Record<"orchestrator"|"implementer"|"reviewer"|"researcher", { model: string; options?: Record<string, unknown> }> }`.
- Produces: `resolveConfig(layers: { core: CoreConfig; personal?: PersonalConfig; project?: ProjectConfig }): ResolvedConfig` where `ResolvedConfig = { value: EffectiveConfig; provenance: Map<string, Provenance>; violations: ConfigViolation[] }`, `Provenance = { source: "core"|"personal"|"project"; overridden: { source: string; value: unknown }[] }`, `ConfigViolation = { key: string; source: "personal"|"project"; reason: "locked"|"personal-only" }`.
- Produces: `explainKey(resolved: ResolvedConfig, key: string): { key: string; value: unknown; source: string; overridden: {source: string; value: unknown}[] } | undefined` (dotted keys, e.g. `gates.soften`).
- Produces: `proposeProfile(logins: { claude: LoginState; codex: LoginState }, profiles: Profile[]): Profile | undefined`, `LoginState = "present"|"absent"|"unknown"` — first profile whose `requires` are all `present`, preferring `claude-codex` over `codex-only`.
- Profile files are read by `loadProfiles` (Task 6, `src/adapters/store/state-store.ts`); this task only defines and validates the data.

Rules: deep merge core ← personal ← project (`project.overrides` only). Locked keys (no layer may set): `gates.hard`, `schema`. Personal-only keys (project may not set): everything except `language` and `gates.soften` — and a project `gates.soften` is intersected with the personal/core `gates.soften` (a project can only make gates stricter, A §11 "never auto-trusts overrides that relax policy"). A violation drops the value and is recorded.

Profiles data (A §7.1, models are data): `claude-codex` requires `["claude","codex"]`: orchestrator `claude-bridge/claude-opus-5-5`, implementer `claude-bridge/claude-opus-5-5`, reviewer `openai-codex/gpt-6.1-sol`, researcher `openai-codex/gpt-6-luna`. `codex-only` requires `["codex"]`: orchestrator `openai-codex/gpt-6-astra`, implementer `openai-codex/gpt-6.1-sol`, reviewer `openai-codex/gpt-6.1-sol` with `options: { freshContext: true }`, researcher `openai-codex/gpt-6-luna`.

- [ ] **Step 1: Write failing tests**: core only → `autonomy` `medium` from `core`; personal `autonomy: "high"` → `high`, provenance `personal`, overridden `[{source:"core",value:"medium"}]`; personal setting `gates.hard: []` → value unchanged, violation `{key:"gates.hard",source:"personal",reason:"locked"}`; project `overrides.gates.soften: ["design-approval"]` with personal soften `[]` → effective `[]` (stricter wins); project setting `autonomy` (not allowed in `ProjectConfig.overrides`) → schema parse error from `ProjectConfig.parse`; `explainKey(…, "parallelism")` → `{value:3, source:"core"}`; `explainKey(…, "nope")` → `undefined`. `proposeProfile({claude:"present",codex:"present"})` → `claude-codex`; `{claude:"absent",codex:"present"}` → `codex-only`; `{claude:"unknown",codex:"absent"}` → `undefined`. Both shipped profile files parse. `gen-schemas` output equals committed `schemas/*.schema.json` (freshness test).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `scripts/gen-schemas.ts` uses `z.toJSONSchema()`; add `npm run schemas`.
- [ ] **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(config): add layered config with provenance, locked keys and profiles`.

### Task 4: Release manifest and changelog

**Files:**
- Create: `release.json`, `CHANGELOG.md`, `src/core/release/{manifest.ts,changelog.ts,semver.ts}`, `scripts/manifest-check.ts`, `schemas/release.schema.json`
- Modify: `scripts/gen-schemas.ts`, `package.json` (script `manifest:check`, added to `lint`)
- Test: `test/core/release/*.test.ts`, `test/scripts/manifest-check.test.ts`

**Interfaces:**
- Produces: `ReleaseManifest` zod schema: `{ schema: 1, factory: string /*semver*/, source: { git: string }, stateSchema: number, node: { min: "22.19.0" }, pi: { package: "@earendil-works/pi-coding-agent", version: string, supportedRange: string }, companions: { "pi-claude-bridge": { source: string; when: "claude" } }, lockfileSha256: string, reviewedInstallScripts: string[] }`.
- Produces: `tagFor(version: string): string` (`v${version}`); `packageRef(m: ReleaseManifest, sourceOverride?: string): string` (`git:${source}@v${factory}`); `npmInstallSpec(m, sourceOverride?): string` (`git+${source}#v${factory}`).
- Produces: `compareSemver(a, b): -1|0|1`, `satisfies(version, range): boolean` (only `>=x.y.z <x.y.z` ranges are supported; anything else throws).
- Produces: `changelogBetween(markdown: string, from: string, to: string): string` — the `## [x.y.z]` sections with `from < x.y.z <= to`, newest first.
- Produces: `checkManifest(root: string): string[]` (list of problems; empty = ok).

`release.json` for this phase: `factory` `0.1.0`, `source.git` `https://github.com/jrevenga/ai-factory.git`, `stateSchema` `1`, `pi.version` `1.4.0`, `pi.supportedRange` `>=1.4.0 <1.5.0`, bridge source `npm:pi-claude-bridge@0.9.3`.

`checkManifest` problems: `release.factory !== package.json version`; `peerDependencies["@earendil-works/pi-coding-agent"] !== release.pi.version`; `!satisfies(pi.version, supportedRange)`; `lockfileSha256` ≠ sha256 of `package-lock.json` with CRLF normalized to LF; sorted names of packages in `package-lock.json` with `hasInstallScript: true` ≠ sorted `reviewedInstallScripts`; `CHANGELOG.md` has no `## [<factory>]` section.

- [ ] **Step 1: Write failing tests**: `compareSemver("0.10.0","0.9.1") === 1`; `satisfies("1.4.0",">=1.4.0 <1.5.0")`, not `1.5.0`; `satisfies("1.4.0","^1.4.0")` throws; `changelogBetween` with sections 0.3.0/0.2.0/0.1.0 from `0.1.0` to `0.3.0` → 0.3.0 then 0.2.0; `packageRef` → `git:https://github.com/jrevenga/ai-factory.git@v0.1.0`; with override `http://127.0.0.1:9/fixture/ai-factory.git` → `git:http://127.0.0.1:9/fixture/ai-factory.git@v0.1.0`; `checkManifest` on a temp copy with the peer pin changed to `*` → one problem naming the peer; on the real repo → `[]`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `CHANGELOG.md` gets `## [0.1.0] - unreleased` listing the Phase 1 deliverables.
- [ ] **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(release): add release manifest, changelog parsing and manifest check`.

### Task 5: Per-key managed Pi settings

**Files:**
- Create: `src/core/settings/managed.ts`, `src/adapters/pi/settings-file.ts`, `schemas/managed-settings.schema.json`
- Modify: `scripts/gen-schemas.ts`
- Test: `test/core/settings/managed.test.ts`, `test/adapters/pi/settings-file.test.ts`

**Interfaces:**
- Produces: `ManagedRecord` zod: `{ schema: 1, keys: Record<string, { value: unknown; writtenAt: string; factoryVersion: string }> }`.
- Produces: `DESIRED_PI_SETTINGS: Readonly<Record<string, unknown>>` = `{ enableInstallTelemetry: false, transport: "sse" }` (A §6.2 step 3, §13 C5).
- Produces: `planManagedSettings(current: Record<string, unknown>, record: ManagedRecord, desired: Record<string, unknown>, ctx: { now: string; factoryVersion: string }): { next: Record<string, unknown>; record: ManagedRecord; changes: SettingChange[] }`, `SettingChange = { key: string; action: "set"|"updated"|"kept-user-value"|"kept-foreign-value"|"unchanged"|"released" }`.
- Produces (adapter): `readPiSettings(path): Promise<Record<string, unknown>>` (missing → `{}`; malformed → throws `MalformedJson`), `writePiSettings(path, value)` via `writeJsonAtomic`; `applyManagedPiSettings(paths: FactoryPaths, factoryVersion: string): Promise<SettingChange[]>`.

Ownership algorithm (A §5.2): for each desired key — absent from `current` and not in record → set, record it (`set`); in record and `current[key]` deep-equals `record.value` → write desired, update record (`updated`, or `unchanged` if equal); in record but user changed it → leave, keep record entry (`kept-user-value`, doctor reports); present in `current` but never written by the factory → leave, do not record (`kept-foreign-value`, doctor reports). A recorded key no longer desired and still equal to the recorded value → delete from settings and record (`released`). Keys not desired and not recorded are never read or touched. Unknown keys (e.g. `packages`) pass through untouched.

- [ ] **Step 1: Write failing tests**: empty settings → both keys `set`, record holds both; user changed `transport` to `"websocket"` after the factory wrote `"sse"` → `kept-user-value`, value stays `websocket`; user had `transport: "auto"` before any factory write → `kept-foreign-value`, record has no `transport`; desired drops `transport` while recorded value still `sse` → `released`, key removed; `packages` array preserved byte-for-byte; adapter: malformed `settings.json` → `MalformedJson`, file unchanged (compare bytes) — Review Focus 2.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(settings): add per-key ownership for managed Pi settings`.

### Task 6: State, lock, sessions, backups, migrations, rollback planning

**Files:**
- Create: `src/core/state/{schema.ts,migrations.ts,rollback-plan.ts}`, `src/adapters/store/{state-store.ts,lock.ts,backup.ts}`, `schemas/state.schema.json`
- Test: `test/core/state/*.test.ts`, `test/adapters/store/*.test.ts`

**Interfaces:**
- Produces: `FactoryState` zod: `{ schema: 1, version: string, installedAt: string, source: string, piVersion: string, piCli: string /* absolute path to cli.js */, history: { version: string; at: string; reason: "install"|"update"|"rollback" }[] }`.
- Produces: `STATE_FILES = ["config.json","state.json","managed-settings.json","memory.db"] as const`.
- Produces: `Migration = { id: string; file: (typeof STATE_FILES)[number]; from: number; to: number; up(doc: unknown): unknown }`; `MIGRATIONS: Migration[]` (empty in 0.1.0; the array literal's last line is the comment `// migrations: append above` so the Task 14 fixture can insert one by text edit in a temp clone); `planMigrations(docs: Record<string, { schema: number }>, registry: Migration[], target: number): Migration[]` (throws `NoMigrationPath { file, from, to }`). Within a major, migrations must be additive: `planMigrations` rejects `to < from`.
- Produces: `planRollback(input: { currentSchemas: Record<string, number | undefined>; targetStateSchema: number; backupPresent: Record<string, boolean> }): { keep: string[]; restore: string[]; dataLoss: string[] }` — a file whose current schema ≤ target keeps current data (`keep`); a newer schema restores the backup (`restore`, and appears in `dataLoss`); a newer schema with no backup → `dataLoss` only.
- Produces (adapters): `readState(paths)/writeState(paths, s)`, `loadProfiles(dir): Promise<Profile[]>`, `readPersonalConfig(paths)`, `writePersonalConfig(paths, c)`; `acquireLock(paths, opts?: { ownerPid?: number }): Promise<Lock>` (file `lock` containing `{pid, at}`; existing lock whose pid is alive → throws `Locked { pid }`; stale → replaced), `Lock.release()`; `registerSession(paths): Promise<() => Promise<void>>` writes `sessions/<pid>.json`; `liveSessions(paths): Promise<number[]>` (pids alive, stale files removed); `backupState(paths, fromVersion): Promise<string>` copies existing `STATE_FILES` plus `pi-packages.json` (the `packages` array from Pi settings) into `backups/<fromVersion>/` (overwriting an older backup of the same version); `restoreState(paths, version, files: string[]): Promise<void>`.

- [ ] **Step 1: Write failing tests**: `planMigrations` with one `config.json` migration 1→2 and docs at schema 1, target 2 → that migration; target 3 → `NoMigrationPath`; `planRollback` current config schema 1, target 1 → keep; current 2, target 1, backup present → restore + dataLoss; no backup → dataLoss only. Lock: second `acquireLock` while the first holder's pid (current process) is alive → `Locked`; lock file with pid `999999` (dead) → acquired; `ownerPid` equal to holder pid → acquired (used by `_apply-release --parent-lock`). Sessions: registered pid listed, dead pid file removed. Backup/restore round-trip of a temp `FACTORY_HOME` with config/state/managed-settings and a Pi settings file; backup when `memory.db` absent → no error.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(state): add factory state, lock, sessions, backups and migration/rollback planning`.

### Task 7: Pi test harness, Pi package skeleton, startup handshake

**Files:**
- Create: `test/helpers/pi-harness.ts`, `test/fixtures/faux-provider.ts`, `src/core/handshake.ts`, `src/adapters/pi/extension.ts`
- Test: `test/core/handshake.test.ts`, `test/e2e/handshake.e2e.test.ts`
- Modify: `.github/workflows/ci.yml` (add `npm run test:e2e` step after `npm test`)

**Interfaces:**
- Produces (test helper): `ensurePinnedPi(): Promise<string>` — installs Pi `1.4.0` once into `node_modules/.cache/factory-test-pi/1.4.0` with `npm install --prefix … --ignore-scripts` and returns the `cli.js` path; `runPiPrint(opts: { cli: string; agentDir: string; cwd: string; extensions: string[]; env?: NodeJS.ProcessEnv; prompt?: string; model?: string /* default factory-test/faux */; timeoutMs?: number }): Promise<RunResult>` — `node <cli> -p --no-session -e <each> --model <model> <prompt ?? "go">`, env `PI_CODING_AGENT_DIR=agentDir`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, stdin closed.
- Produces (fixture): `test/fixtures/faux-provider.ts` registers `fauxProvider({ provider: "factory-test", models: [{ id: "faux" }] })` and scripts responses from env `FAUX_SCRIPT` (JSON array of `{ tool: string; args: object }` turned into one `fauxToolCall` message each with `stopReason: "toolUse"`, then `fauxAssistantMessage("done")`).
- Produces: `evaluateHandshake(input: { expectedVersion: string | undefined; packageVersion: string; configOk: boolean; storeWritable: boolean }): HandshakeResult`, `HandshakeResult = { ok: boolean; version: string; policy: "none"; reasons: string[] }` — reasons: `"not-installed"` (no state), `"version-mismatch"`, `"config-invalid"`, `"store-unwritable"`.
- Produces: the extension default export: on `session_start` computes the handshake (expected version from `state.json`, package version from its own `package.json`, personal config parses, `FACTORY_HOME` writable via a probe file), emits `pi.events.emit("factory:handshake", result)`; when `!ok`, registers its own `tool_call` blocker for every tool except `read`, `grep`, `find`, `ls` with reason `factory handshake failed: <reasons>`, and notifies the UI once (`ctx.ui.notify` when available).

Rationale for the extension's own blocker: covers "handshake failed" even when the guard file is missing; the guard (Task 8) covers "extension never loaded".

- [ ] **Step 1: Write failing tests**: unit — `evaluateHandshake({expectedVersion:undefined,…})` → `ok:false, reasons:["not-installed"]`; matching version + ok config + writable → `ok:true`, `policy:"none"`. e2e (`test/e2e/handshake.e2e.test.ts`, temp `FACTORY_HOME` + agent dir): with a valid `state.json` (version `0.1.0`) and `FAUX_SCRIPT=[{"tool":"write","args":{"path":"<tmp>/out.txt","content":"x"}}]` and `-e src/adapters/pi/extension.ts` → `out.txt` exists; with `state.json` version `9.9.9` → `out.txt` absent and stdout/stderr or the session shows the reason `version-mismatch`; harness self-check: faux only (no factory extension) → `out.txt` exists.
- [ ] **Step 2: Run** `npm run test:e2e` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pi): add Pi package skeleton with startup handshake and faux-provider test harness`.

### Task 8: Guard extension and the broken-install acceptance test

**Files:**
- Create: `guard/factory-guard.ts`
- Test: `test/guard/guard.test.ts`, `test/e2e/guard.e2e.test.ts`

**Interfaces:**
- Produces: `guard/factory-guard.ts` — self-contained (only `import type` from Pi; no imports from `src/`), exports `READ_ONLY_TOOLS = ["read","grep","find","ls"]`, `guardDecision(toolName: string, handshake: { ok: boolean } | undefined): { block: true; reason: string } | undefined`, and a default export that listens on `pi.events.on("factory:handshake", …)` and blocks via `tool_call` with reason `factory guard: factory extension not loaded or handshake failed — run "factory doctor"`.
- Produces: constant `GUARD_FILE_NAME = "factory-guard.ts"` (consumed by Task 11 to copy it into `paths.piExtensions`).

- [ ] **Step 1: Write failing tests**: unit — `guardDecision("write", undefined)` blocks; `guardDecision("read", undefined)` allows; `guardDecision("bash", {ok:true})` allows; `guardDecision("edit", {ok:false})` blocks; `guardDecision("codemode", undefined)` blocks (unknown tools fail closed). e2e (acceptance "a broken package install leaves write tools blocked"): guard copied into `<agentDir>/extensions/`, factory extension absent (simulates a failed package install), faux scripts `write` → `out.txt` absent; same with a `bash` call `echo x > out2.txt` → `out2.txt` absent; faux scripts `read` of an existing file → allowed (tool result has no `factory guard` error); guard + factory extension (`-e`) + valid state → `write` succeeds; guard + factory extension + mismatched state → blocked. Not in this test: an unresolvable package ref in Pi settings, because Pi crashes before any extension loads (S2); that case is prevented by ref validation (Task 9).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm run test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(guard): add guard extension that blocks writes until the factory handshake succeeds`.

### Task 9: Git, Pi runtime and login adapters

**Files:**
- Create: `src/adapters/vcs/git.ts`, `src/adapters/pi/runtime.ts`, `src/adapters/providers/logins.ts`, `test/helpers/git-server.ts`
- Test: `test/adapters/vcs/git.test.ts`, `test/adapters/pi/runtime.e2e.test.ts`, `test/adapters/providers/logins.test.ts`

**Interfaces:**
- Produces (test helper): `startGitServer(bareRepoParent: string): Promise<{ url(repoRelPath: string): string; close(): Promise<void> }>` — static file server on `127.0.0.1:0` (the scratch server shape verified while planning); `makeBareRepo(fromWorkTree: string, dest: string, tags: string[]): Promise<void>` runs `git clone --bare`, creates the tags, `git update-server-info`.
- Produces: `lsRemoteTags(url: string, opts?: { timeoutMs?: number }): Promise<string[]>` (tag names without `refs/tags/`, peeled `^{}` lines dropped); `resolveRef(url, tag): Promise<boolean>`; `shallowClone(url, tag, dest): Promise<void>`; `classifyGitError(stderr: string): "auth-https"|"auth-ssh"|"not-found"|"network"|"unknown"` — `could not read Username for 'https://github.com'` → `auth-https`; `Permission denied (publickey)` → `auth-ssh` (S2 strings); `not found`/`Repository not found` → `not-found`.
- Produces: `PiRuntime` with `ensurePinned(paths: FactoryPaths, version: string): Promise<string /* cli.js path */>` (reuses `paths.piPrefixes/<version>` when its `package.json` version matches), `run(cli: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<RunResult>` (`node <cli> …`, stdin closed, `PI_TELEMETRY=0`), `installPackage(cli, ref: string, opts): Promise<void>` — for `git:` refs first `resolveRef`; failure throws `UnresolvableRef { ref, kind }` and Pi settings are not touched; `version(cli): Promise<string>`.
- Produces: `detectLogins(opts: { piCli?: string; env?: NodeJS.ProcessEnv }): Promise<{ claude: LoginState; codex: LoginState }>` — per ruling 6; any spawn error or timeout → `unknown`; `claude` not on PATH → `absent`.

- [ ] **Step 1: Write failing tests**: `classifyGitError` for both S2 strings; with a fixture bare repo served by `startGitServer`: `lsRemoteTags` → contains `v0.0.1-test`; `resolveRef` for missing tag → `false`; unreachable `http://127.0.0.1:1/x/y.git` → rejects within 15 s with `network`. Runtime e2e: `ensurePinned` into a temp `FACTORY_HOME` → `version()` is `1.4.0`; second call does no npm run (spy on `npm`); **`runs pinned pi, not PATH pi`** (Review Focus 4): with a fake `pi` script on `PATH` that writes a marker file, `run(cli, ["--version"])` returns `1.4.0` and the marker does not exist; `installPackage` with an unresolvable `git:` tag throws `UnresolvableRef` and `<agentDir>/settings.json` is absent/unchanged. `detectLogins` with an empty agent dir → `codex: "absent"`; with `PATH` lacking `claude` → `claude: "absent"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test && npm run test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(adapters): add git, pinned Pi runtime and login detection`.

### Task 10: CLI entry, router and `factory doctor`

**Files:**
- Create: `bin/factory.mjs`, `src/cli/main.ts`, `src/cli/io.ts`, `src/cli/commands/doctor.ts`
- Test: `test/cli/main.test.ts`, `test/cli/doctor.test.ts`

**Interfaces:**
- Produces: `bin/factory.mjs` — `#!/usr/bin/env node`; suppresses only the `node:sqlite` `ExperimentalWarning` (A §4 [builder]: `process.removeAllListeners("warning")` is NOT acceptable; filter by `warning.name === "ExperimentalWarning" && /SQLite/.test(warning.message)` and re-emit others); `createJiti(import.meta.url)` then `await jiti.import("../src/cli/main.ts")` and `process.exitCode = await main(process.argv.slice(2))`.
- Produces: `main(argv: string[], io?: CliIO): Promise<number>`; commands: (none) → launcher (Task 13), `install`, `doctor [--offline] [--json]`, `update [--to <v>] [--yes]`, `rollback [<v>] [--yes]`, `init [--yes]`, `config explain <key>`, `version`, hidden `_apply-release`. Unknown command → usage, exit 2. Reserved `runs|eval|radar` → `"factory <cmd> arrives in a later phase"`, exit 2. Parsing with `node:util` `parseArgs`.
- Produces: `CliIO = { out(s: string): void; err(s: string): void; confirm(question: string): Promise<boolean>; isTTY: boolean }`; `confirm` without TTY returns `false` unless `--yes`.
- Produces: `runDoctor(ctx: { paths: FactoryPaths; env: NodeJS.ProcessEnv; offline: boolean; manifest: ReleaseManifest }): Promise<DoctorCheck[]>`, `DoctorCheck = { id: string; status: "ok"|"warn"|"fail"; message: string; fix?: string }`. Exit 1 when any `fail`.

Doctor checks (ids fixed; A §6.2 doctor): `node-version` (≥ `manifest.node.min`), `node-sqlite-fts5` (in-memory FTS5 table with `unicode61 remove_diacritics 2`, query `decision` matches `Decisión`), `git` (on PATH), `npm` (`resolveNpm` ok), `npm-prefix-writable` (`npm prefix -g` dir writable, fix never suggests sudo), `factory-home-writable`, `state` (state.json present and parses; version equals `manifest.factory`), `pi-pinned` (cli.js exists, version equals `manifest.pi.version`), `pi-settings` (parses), `managed-settings` (one `warn` per `kept-user-value`/`kept-foreign-value`; `transport` not `sse` → warn "Codex limits will be unknown (A §13)"), `factory-package` (Pi settings `packages` contains `packageRef(manifest)`), `guard` (`<piExtensions>/factory-guard.ts` exists and equals the shipped file byte-for-byte), `source-override` (warn when `FACTORY_SOURCE` set), `logins` (from `detectLogins`; `absent` both → fail with the two login instructions from A §6.2), `repo-access` (online only: `lsRemoteTags(source)`, failure classified with fix text for `auth-https`, `auth-ssh`, and the Windows non-interactive note from A §6.2), `parallelism` (warn when configured value > suggestion `max(1, min(8, floor(totalmem GiB / 4)))`).

- [ ] **Step 1: Write failing tests**: `main(["nope"])` → 2; `main(["version"])` prints `0.1.0`; `main(["runs"])` → 2 with the later-phase message. Doctor against a temp env with nothing installed → `state` fail, `pi-pinned` fail, every failing check has a `fix`; **`offline doctor makes no network call`** (Review Focus 5): with `offline: true` and `FACTORY_SOURCE=http://127.0.0.1:1/x/y.git`, `repo-access` absent from results and completes < 5 s; online with that source → `repo-access` fail with classification `network` < 20 s. Guard check: modified guard file → `fail` with fix `factory install`. `node-sqlite-fts5` → `ok` on the test Node.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; also `node bin/factory.mjs version` prints `0.1.0` with no warning on stderr.
- [ ] **Step 5: Commit** `feat(cli): add factory entry point, command router and doctor`.

### Task 11: `_apply-release` and `factory install` (with npx bootstrap)

**Files:**
- Create: `src/cli/commands/apply-release.ts`, `src/cli/commands/install.ts`
- Test: `test/cli/apply-release.test.ts`, `test/cli/install.test.ts`

**Interfaces:**
- Consumes: Tasks 2–10.
- Produces: `applyRelease(ctx: ApplyContext, opts: { reason: "install"|"update"|"rollback"; from?: string; parentLockPid?: number; profile?: string }): Promise<void>`, `ApplyContext = { paths: FactoryPaths; env: NodeJS.ProcessEnv; manifest: ReleaseManifest /* this CLI's own release.json */; io: CliIO; pi: PiRuntime; now(): string }`. CLI form (compatibility contract): `factory _apply-release --reason <r> [--from <v>] [--parent-lock <pid>] [--profile <name>] [--yes]`.
  Steps, in order: acquire lock (`ownerPid = parentLockPid`); `pi.ensurePinned(manifest.pi.version)`; `pi.installPackage(packageRef(manifest, env.FACTORY_SOURCE))`; when `detectLogins().claude === "present"` install `manifest.companions["pi-claude-bridge"].source`; `applyManagedPiSettings`; copy `guard/factory-guard.ts` to `paths.piExtensions`; personal config: create from `proposeProfile` (or `--profile`) if missing — never overwrite an existing one; run `planMigrations` for existing state docs to `manifest.stateSchema` and apply; write `state.json` **last** (`version`, `piCli`, history entry with `reason`); run `runDoctor({offline:true})` and print it. Any failure before the `state.json` write leaves the previous `state.json` untouched and prints `Install did not complete: <error>. Previous state kept. Run "factory doctor"; after an update run "factory rollback".`
- Produces: `install(ctx, opts: { yes: boolean; profile?: string }): Promise<number>` — step 1 minimum requirements (doctor checks `node-version`, `node-sqlite-fts5`, `git`, `npm`, `npm-prefix-writable`; any fail → print fixes, exit 1); **bootstrap**: when this CLI runs from an npx cache (its own real path contains `/_npx/` or `\_npx\`) it runs `npm install -g --legacy-peer-deps <npmInstallSpec(manifest, FACTORY_SOURCE)>`, then executes the globally installed CLI (`<npm root -g>/ai-factory/bin/factory.mjs`, run with `process.execPath`) with `install` and the same flags, and returns its exit code; otherwise calls `applyRelease({reason:"install"})`.

- [ ] **Step 1: Write failing tests** with a fake `PiRuntime` (records calls) and temp paths: happy path → call order `ensurePinned` → `installPackage(git:…@v0.1.0)` → state written with `history[0].reason === "install"`; claude `absent` → bridge not installed; existing `config.json` → unchanged bytes; **`apply failure leaves previous state.json`** (Review Focus 3): fake `installPackage` throws `UnresolvableRef` → previous `state.json` bytes unchanged, output contains `Previous state kept`; guard file copied and byte-identical; lock released after failure. Bootstrap detection: path `/home/u/.npm/_npx/abc/node_modules/ai-factory/bin/factory.mjs` → bootstrap; global path → no bootstrap.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): add factory install and the shared apply-release step`.

### Task 12: `factory update` and `factory rollback`

**Files:**
- Create: `src/cli/commands/update.ts`, `src/cli/commands/rollback.ts`
- Test: `test/cli/update.test.ts`, `test/cli/rollback.test.ts`

**Interfaces:**
- Consumes: `applyRelease` contract, `backupState`, `restoreState`, `planRollback`, `liveSessions`, `acquireLock`, `lsRemoteTags`, `shallowClone`, `changelogBetween`, `npm`.
- Produces: `update(ctx, opts: { to?: string; yes: boolean }): Promise<number>`:
  1. refuse (exit 1) if `liveSessions` non-empty (`Close factory sessions first: pids …`) or the lock is held;
  2. target = `opts.to` or the highest `v*` tag from `lsRemoteTags(source)` greater than `state.version`; none → `Already up to date`, exit 0; `--to` tag missing → exit 1 before any change (**`update aborts before swap on unresolvable tag`**);
  3. `shallowClone(source, tag, tmp)`; read target `release.json` + `CHANGELOG.md`; print `changelogBetween(current, target)`; target `node.min` > running Node → exit 1 with fix;
  4. `confirm("Update factory <a> → <b>?")` (or `--yes`);
  5. acquire lock; `backupState(paths, state.version)`;
  6. `npm install -g --legacy-peer-deps <npmInstallSpec(target, FACTORY_SOURCE)>`;
  7. run the new global CLI `_apply-release --reason update --from <a> --parent-lock <pid> --yes`; release lock; exit with its code. On failure in 6–7: `Update failed after backup. Your previous state is in <backups/a>. Run "factory rollback <a>".`
- Produces: `rollback(ctx, opts: { version?: string; yes: boolean }): Promise<number>`:
  1. same refusal rules as update;
  2. target = `opts.version` or the most recent `history` entry with a version different from `state.version`; none → exit 1;
  3. `shallowClone` target; read its `release.json` (`stateSchema`);
  4. `planRollback` with current file schemas, target schema, backup presence; print `keep`/`restore`; when `dataLoss` is non-empty, print `Rolling back loses data in: <files>` and `confirm` it (`--yes` accepts);
  5. acquire lock; `backupState(paths, state.version)` (enables roll-forward); `restoreState(paths, target, plan.restore)` (the Pi package entry is not restored from the backup: `_apply-release` of the target reinstalls the target's own package ref);
  6. `npm install -g --legacy-peer-deps <target spec>`; run the target CLI `_apply-release --reason rollback --from <current> --parent-lock <pid> --yes`; release lock.

- [ ] **Step 1: Write failing tests** with fakes for npm/git/apply (record calls; temp paths): update picks `v0.2.0` over `v0.1.0`/`v0.1.1`; `--to v9.9.9` missing → exit 1 and no backup dir created; live session pid (current process registered) → exit 1 `Close factory sessions first`; happy path order: backup → npm global install with `--legacy-peer-deps` → apply with `--parent-lock <process.pid>`; rollback default target = previous history version; rollback with current config schema 2 and target stateSchema 1 → `config.json` restored from backup and output lists data loss; with equal schemas → current `config.json` kept.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): add factory update and rollback with state backup and restore`.

### Task 13: Launcher, `factory init`, `factory config explain`

**Files:**
- Create: `src/cli/commands/launch.ts`, `src/cli/commands/init.ts`, `src/cli/commands/config.ts`
- Test: `test/cli/launch.test.ts`, `test/cli/init.test.ts`, `test/cli/config.test.ts`

**Interfaces:**
- Produces: `launch(ctx, piArgs: string[]): Promise<number>` — offline doctor; any `fail` among `state`, `pi-pinned`, `factory-package`, `guard` → print them with fixes and exit 1 without starting Pi; other failures/warnings → print one summary line and continue; `registerSession`; spawn `process.execPath [state.piCli, ...piArgs]` with **inherited stdio** (interactive TUI; not `runBounded`), forward SIGINT/SIGTERM is not needed (same foreground process group) but SIGTERM to the launcher is forwarded; on exit unregister the session and return Pi's exit code (signal → 128+n).
- Produces: `init(ctx, opts: { yes: boolean; cwd: string }): Promise<number>` — requires a git repo (`git rev-parse --show-toplevel`); creates under `<root>/.factory/`: `config.json` (`{ "schema": 1 }`), `knowledge/index.md`, `knowledge/conventions.md`, `knowledge/{specs,tasks,decisions,plans,ideas}/.gitkeep`, `.gitignore` containing `worktrees/`; Markdown files start with YAML frontmatter `type: index` / `type: conventions` and `schema: 1` (A §9.2, §6.2 migration policy). Existing files are never overwritten; when `.factory/` exists, list what would be added and `confirm` first.
- Produces: `configExplain(ctx, key: string): Promise<number>` — resolves layers (core defaults, personal, project from the git root of `cwd` if any) and prints `key = <json>  (from <source>)` plus `overrides: <source>=<json>` lines and any violations for that key; unknown key → exit 1.

- [ ] **Step 1: Write failing tests**: launch with missing state → exit 1, Pi not spawned (spawn spy); with a fake `piCli` script that records argv and exits 3 → launcher returns 3, argv forwarded, session file removed afterwards; init in a temp git repo → files created with the frontmatter; second run → nothing overwritten (bytes equal); outside a git repo → exit 1; `config explain autonomy` with personal `high` → output `autonomy = "high"  (from personal)` and `overrides: core="medium"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): add launcher, factory init and config explain`.

### Task 14: End-to-end install and update → rollback round-trip in CI

**Files:**
- Create: `test/e2e/roundtrip.e2e.test.ts`, `.github/workflows/e2e.yml`
- Modify: `README.md` (create if missing: install, update, rollback, doctor, requirements per A §6.2 — short)

**Interfaces:**
- Consumes: everything above; `startGitServer`, `makeBareRepo`.

Test flow (one test file, sequential steps, isolated temp `HOME`-like dirs: `FACTORY_HOME`, `PI_CODING_AGENT_DIR`, `npm_config_prefix`, `npm_config_cache`, all inside one spaced temp dir; `PATH` prefixed with the temp npm prefix bin dir):
1. Build fixture releases from the current `HEAD` into a bare repo: tag `v0.1.0` as-is; tag `v0.2.0` = a commit on top that sets `package.json`/`release.json` `factory` to `0.2.0`, adds a `## [0.2.0]` changelog section, bumps `stateSchema` to `2`, and registers a test migration `config.json` 1→2 (adds `"e2eMarker": true`) — created by the test via a temp clone, never committed to the real repo; `lockfileSha256` unchanged since the lockfile is unchanged. `FACTORY_SOURCE` = the served URL.
2. **Bootstrap**: `npx -y git+<served>#v0.1.0 install --yes --profile codex-only` (time it); expect exit 0, global `factory` on the temp prefix, `state.json` version `0.1.0`, Pi settings `packages` contains `git:<served>@v0.1.0`, `transport: "sse"`, `enableInstallTelemetry: false`, guard present. `factory doctor --offline` exit code may be 1 only because `logins` fails (no logins on CI) — assert every other check is `ok`/`warn` via `--json`.
3. Write a personal config edit (`language: "es"`) — the "user data" to preserve.
4. `factory update --to v0.2.0 --yes` → `state.json` `0.2.0`, `config.json` has `e2eMarker: true` and still `language: "es"`, `backups/0.1.0/config.json` exists, Pi settings package ref `@v0.2.0`.
5. `factory rollback --yes` → `state.json` `0.1.0`; `config.json` equals the 0.1.0 backup (schema 2 > target 1 → restored; data-loss line printed); Pi settings package ref `@v0.1.0`; `factory version` prints `0.1.0`; `factory doctor --offline --json` same as step 2.
6. Assert total wall time of step 2 < 600 s and print it (A §3 "< 10 minutes … verified in CI").

`.github/workflows/e2e.yml`: on `push` to `master` and `workflow_dispatch`; matrix `ubuntu-latest`/`windows-latest` × Node `22.19.0`/`24`; spaced checkout dir on Windows; `npm ci`; `npm run test:e2e`; `timeout-minutes: 20`; no secrets needed (everything is served locally; Pi from the public npm registry).

- [ ] **Step 1: Write the e2e test** (it fails until all earlier tasks are in).
- [ ] **Step 2: Run** `npm run test:e2e` locally → PASS (fix defects found in earlier tasks' code within this task, each with a regression test in the owning test file).
- [ ] **Step 3: Push the branch and run CI + e2e workflows**; Expected: 4/4 legs green on both workflows; record the step-2 install time per leg in the PR/branch notes.
- [ ] **Step 4: Commit** `test(e2e): verify bootstrap install and update/rollback round-trip on Linux and Windows`.

---

## Phase completion checklist (controller, after Task 14)

- Acceptance 1: e2e step 2 time < 600 s on all 4 legs (CI log).
- Acceptance 2: e2e steps 4–5 green on all 4 legs.
- Acceptance 3: `test/e2e/guard.e2e.test.ts` green on all 4 legs.
- Final whole-branch review by Codex (latest Sol, `xhigh`).
- Release `v0.1.0` (tag + `CHANGELOG.md` date) only after the owner merges; pushing a tag is outward-facing and follows the owner's merge decision.
