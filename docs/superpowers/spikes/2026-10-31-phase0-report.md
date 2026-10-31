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

**Method:** Private repo `jrevenga/ai-factory` (owner-approved). Orphan branch `spike/pkg`, commit `8a9eb98` (tag `spike-pkg-v0.1.0`), contains exactly three files: `package.json`, `extensions/probe.ts` (TS source; `import ms from "ms"`, type-only `ExtensionAPI`; on `session_start` writes the marker if `SPIKE_MARKER` is set and emits `factory:handshake`), `bin/factory-spike.mjs`. Probes run through `spikes/phase0/s2-probe.mjs` (resets the scenario's agent dir, npm prefix and npm cache before each run, fresh nonce per run, marker deleted first, explicit `--model openai-codex/gpt-6.1-sol`, only `get_state`) and `spikes/phase0/nocreds.mjs` (resets scenario `nocreds` and scratch HOME). Runners take `timeoutMs` and kill the whole process tree on timeout (`spawnBounded` in `pi.mjs`). Pi settings key for packages is `packages` (docs/packages.md v1.4.0). `session_start` handler gets `SessionStartEvent {reason, previousSessionFile?}`. Node 24.13.1 and 22.19.0 (via `npx -y node@22.19.0` in runner scenario `s2n22x`).

**Evidence:**

### 1. Install by tag, list, marker load (Node 24.13.1)
Command:
```
node spikes/phase0/s2-probe.mjs load s2n24   # resets .agent-s2n24/.npm-global-s2n24/out/npm-cache-s2n24; nonce = randomUUID(); exit code of script: 0
```
Output (verbatim; trimmed: blank lines, git detached-HEAD advice, npm update notices, long lines marked):
```
node v24.13.1; reset scenario s2n24
$ pi install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
exit=0 timedOut=false
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
added 1 package, and audited 2 packages in 630ms
found 0 vulnerabilities
Installed git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-s2n24/git/github.com/jrevenga/ai-factory'...
HEAD is now at 8a9eb98 chore(spike): add Pi package spike (S2)
$ pi list
exit=0 timedOut=false
--- stdout ---
User packages:
  git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
    /home/jorge/projects/ai-factory/spikes/phase0/.agent-s2n24/git/github.com/jrevenga/ai-factory
--- stderr ---
ms dir exists: true
nonce=600de39d-f698-4df5-a817-c5d2e7d58bb3
$ pi --mode rpc --no-session --model openai-codex/gpt-6.1-sol  <<< get_state
exit=0 timedOut=false
--- stdout ---
{"id":"1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"gpt-6.1-sol","name":"GPT-6.1 Sol","api":"openai-codex-responses","provid [stdout truncated]
--- stderr ---
marker: {"loaded":true,"nonce":"600de39d-f698-4df5-a817-c5d2e7d58bb3","ms":7200000}
marker carries this run's nonce: true
```

`ms` is at `spikes/phase0/.agent-s2n24/git/github.com/jrevenga/ai-factory/node_modules/ms` (`ms dir exists: true`). Script exit 0 means: RPC exit 0 AND marker carries this run's nonce.

### 2. Same on Node 22.19.0 (declared minimum)
Command:
```
node spikes/phase0/npm.mjs s2n22x npx -y node@22.19.0 spikes/phase0/s2-probe.mjs load s2n22   # runner scenario s2n22x differs from the probe scenario so the reset does not delete the npx cache; exit 0
```
Output (verbatim; trimmed: blank lines, git detached-HEAD advice, npm update notices, long lines marked):
```
node v22.19.0; reset scenario s2n22
$ pi install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
exit=0 timedOut=false
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
added 1 package, and audited 2 packages in 618ms
found 0 vulnerabilities
Installed git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-s2n22/git/github.com/jrevenga/ai-factory'...
HEAD is now at 8a9eb98 chore(spike): add Pi package spike (S2)
$ pi list
exit=0 timedOut=false
--- stdout ---
User packages:
  git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
    /home/jorge/projects/ai-factory/spikes/phase0/.agent-s2n22/git/github.com/jrevenga/ai-factory
--- stderr ---
ms dir exists: true
nonce=122f1398-aa79-418d-bde5-e02410afe641
$ pi --mode rpc --no-session --model openai-codex/gpt-6.1-sol  <<< get_state
exit=0 timedOut=false
--- stdout ---
{"id":"1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"gpt-6.1-sol","name":"GPT-6.1 Sol","api":"openai-codex-responses","provid [stdout truncated]
--- stderr ---
marker: {"loaded":true,"nonce":"122f1398-aa79-418d-bde5-e02410afe641","ms":7200000}
marker carries this run's nonce: true
```


### 3. Bad ref: install, then startup (Node 24.13.1)
Command:
```
node spikes/phase0/s2-probe.mjs badref badref   # reset scenario; pi install ...@does-not-exist; write .agent-badref/settings.json {"packages":["git:github.com/jrevenga/ai-factory@does-not-exist"]}; fresh nonce; RPC get_state; script exit 0 = no marker with this nonce
```
Output (verbatim; trimmed: blank lines, git detached-HEAD advice, npm update notices, long lines marked):
```
node v24.13.1; reset scenario badref
$ pi install git:github.com/jrevenga/ai-factory@does-not-exist
exit=1 timedOut=false
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@does-not-exist...
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-badref/git/github.com/jrevenga/ai-factory'...
error: pathspec 'does-not-exist' did not match any file(s) known to git
Error: git checkout does-not-exist failed with code 1
nonce=65195ea9-2aa0-4541-93ec-c09771628635
$ pi --mode rpc --no-session --model openai-codex/gpt-6.1-sol  <<< get_state
exit=1 timedOut=false
--- stdout ---
 [stdout truncated]
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-badref/git/github.com/jrevenga/ai-factory'...
error: pathspec 'does-not-exist' did not match any file(s) known to git
file:///home/jorge/projects/ai-factory/spikes/phase0/.prefix/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js:497
`,"utf-8")}getNpmInstallRoot(scope,temporary){return temporary?this.getTemporaryDir("npm"):scope==="project"?(this.assertProjectTrustedForScope(scope),join5(this.cwd,CONFIG_DIR_NAME,"npm")):join5(this [line truncated]
                                                                                                                                                                                                         [line truncated]
Error: git checkout does-not-exist failed with code 1
    at ChildProcess.<anonymous> (file:///home/jorge/projects/ai-factory/spikes/phase0/.prefix/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js:497:12870)
    at ChildProcess.emit (node:events:508:28)
    at ChildProcess._handle.onexit (node:internal/child_process:294:12)
Node.js v24.13.1
marker: null
marker carries this run's nonce: null
```

Pi does NOT warn and continue: it dies with an unhandled exception, exit 1, no RPC response, no marker. `pi --list-models` in the same agent dir (scenario badref, settings as above) crashes identically. Command: `node --input-type=module -e "import {runPi} from './spikes/phase0/pi.mjs'; const r=await runPi(['--list-models'],{scenario:'badref',timeoutMs:60000}); console.log(r.code, r.stderr)"`; filtered output:
```
exit=1 timedOut=false
error: pathspec 'does-not-exist' did not match any file(s) known to git
Error: git checkout does-not-exist failed with code 1
Node.js v24.13.1
```
This contradicts docs/packages.md ("warns and keeps running").

Same on Node 22.19.0:
Command:
```
node spikes/phase0/npm.mjs s2n22x npx -y node@22.19.0 spikes/phase0/s2-probe.mjs badref badref22   # exit 0 = no marker
```
Output (same trims):
```
node v22.19.0; reset scenario badref22
$ pi install git:github.com/jrevenga/ai-factory@does-not-exist
exit=1 timedOut=false
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@does-not-exist...
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-badref22/git/github.com/jrevenga/ai-factory'...
error: pathspec 'does-not-exist' did not match any file(s) known to git
Error: git checkout does-not-exist failed with code 1
nonce=19048ec0-fea9-40c1-89b2-cfd683e0e359
$ pi --mode rpc --no-session --model openai-codex/gpt-6.1-sol  <<< get_state
exit=1 timedOut=false
--- stdout ---
 [stdout truncated]
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-badref22/git/github.com/jrevenga/ai-factory'...
error: pathspec 'does-not-exist' did not match any file(s) known to git
file:///home/jorge/projects/ai-factory/spikes/phase0/.prefix/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js:497
`,"utf-8")}getNpmInstallRoot(scope,temporary){return temporary?this.getTemporaryDir("npm"):scope==="project"?(this.assertProjectTrustedForScope(scope),join5(this.cwd,CONFIG_DIR_NAME,"npm")):join5(this [line truncated]
                                                                                                                                                                                                         [line truncated]
Error: git checkout does-not-exist failed with code 1
    at ChildProcess.<anonymous> (file:///home/jorge/projects/ai-factory/spikes/phase0/.prefix/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js:497:12870)
    at ChildProcess.emit (node:events:519:28)
    at ChildProcess._handle.onexit (node:internal/child_process:293:12)
Node.js v22.19.0
marker: null
marker carries this run's nonce: null
```


### 4. No credentials, Pi (Node 24.13.1), then Node 22.19.0
Environment built by `nocreds.mjs`: `GIT_CONFIG_GLOBAL=<abs>/out/empty.gitconfig`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=`, `SSH_ASKPASS=`, HOME/USERPROFILE/HOMEDRIVE/HOMEPATH = `<abs>/out/home-nocreds` (recreated empty each run), `GIT_SSH_COMMAND="ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null"`, `SSH_AUTH_SOCK`, `NETRC`, `GIT_CONFIG_COUNT/KEY_*/VALUE_*/PARAMETERS` removed; 120 s timeout with tree kill; scenario `nocreds` reset first. The argument is validated (`pi|npm`, otherwise usage + exit 2).
Command:
```
node spikes/phase0/nocreds.mjs pi   # script exits 0 and prints Pi's own exit code on the first line
```
Output (verbatim; trimmed: blank lines, git detached-HEAD advice, npm update notices, long lines marked):
```
exit=1 timedOut=false elapsed=650ms
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory'...
fatal: could not read Username for 'https://github.com': terminal prompts disabled
Error: git clone https://github.com/jrevenga/ai-factory /home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory failed with code 128
```

Command:
```
node spikes/phase0/npm.mjs s2n22x npx -y node@22.19.0 spikes/phase0/nocreds.mjs pi
```
Output (verbatim; trimmed: blank lines, git detached-HEAD advice, npm update notices, long lines marked):
```
exit=1 timedOut=false elapsed=499ms
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory'...
fatal: could not read Username for 'https://github.com': terminal prompts disabled
Error: git clone https://github.com/jrevenga/ai-factory /home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory failed with code 128
```


### 5. No credentials, npm (Node 24.13.1)
Command:
```
node spikes/phase0/nocreds.mjs npm   # npm.mjs scenario nocreds; exit code printed on first line
```
Output (verbatim; trimmed: blank lines, git detached-HEAD advice, npm update notices, long lines marked):
```
exit=128 timedOut=false elapsed=1277ms
--- stdout ---
--- stderr ---
npm error code 128
npm error An unknown git error occurred
npm error command git --no-replace-objects ls-remote ssh://git@github.com/jrevenga/ai-factory.git
npm error Load key "/dev/null": error in libcrypto
npm error git@github.com: Permission denied (publickey).
npm error fatal: Could not read from remote repository.
npm error
npm error Please make sure you have the correct access rights
npm error and the repository exists.
npm error A complete log of this run can be found in: /home/jorge/projects/ai-factory/spikes/phase0/out/npm-cache-nocreds/_logs/2026-10-31T15_47_08_166Z-debug-0.log
```

npm tried only SSH (pacote falls back from HTTPS). The npm leg on Node 22.19.0 was not run: the `node@22.19.0` npm package ships no bundled npm, and `npm.mjs` resolves npm's JS entry next to `process.execPath`. The npm client itself is identical (the system npm), so only the Node binary differs.

### 6. Positive control with the owner's normal git credentials
Command:
```
node spikes/phase0/npm.mjs npmok npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0 ; node spikes/phase0/.npm-global-npmok/bin/factory-spike ; (npm_config_prefix=$PWD/spikes/phase0/.npm-global-npmok2 npm_config_cache=$PWD/spikes/phase0/out/npm-cache-npmok2 node .../factory-spike.mjs install)   # scenario dirs deleted beforehand
```
Output (verbatim; trimmed: blank lines, git detached-HEAD advice, npm update notices, long lines marked):
```
$ node spikes/phase0/npm.mjs npmok npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
added 122 packages in 11s
9 packages are looking for funding
  run `npm fund` for details
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
exit=0
$ node spikes/phase0/.npm-global-npmok/bin/factory-spike
factory-spike ok v24.13.1
exit=0
$ npm_config_prefix=.../.npm-global-npmok2 npm_config_cache=.../out/npm-cache-npmok2 node spikes/phase0/.npm-global-npmok/lib/node_modules/ai-factory-spike/bin/factory-spike.mjs install
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
added 122 packages in 12s
9 packages are looking for funding
  run `npm fund` for details
exit=0
factory-spike
```

Note: 122 packages were installed because npm auto-installs the `@earendil-works/pi-coding-agent` peer dependency for a global npm install of the package. Design impact below.

### 7. Timeout kills and reaps the whole tree
Command: `node spikes/phase0/timeout-proof.mjs` (runNpm with `timeoutMs: 3000` on a private-repo install whose git credential helper is `sleep 300`; ps listed at t=2 s and after the timeout)
```
descendants while running (t=2s):
2065555 2065548 2065555 npm install git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
2065566 2065555 2065555 git --no-replace-objects ls-remote https://github.com/jrevenga/ai-factory.git
2065570 2065568 2065555 /bin/sh -c sleep 300 #spike-tmo-marker get sleep 300 #spike-tmo-marker get
result: code=null timedOut=true elapsed=3022ms
leftover processes after timeout: none
exit=0
```

**Verdict:** PASS on Node 24.13.1 and 22.19.0 for install-by-tag from a private repo with credentials, and for TS-source extension plus dependency (no build step). Failure modes (bad tag, missing credentials) are loud, bounded and distinguishable, but an unresolvable ref in settings is fatal for every Pi command rather than a warning.

**Design impact:** (1) Ship TS source; jiti is sufficient, no built JS artifact required. (2) Pi stays in `peerDependencies`, libraries in `dependencies`; they land in the checkout's `node_modules`. (3) Pinned refs must be validated before being written to settings (e.g. `git ls-remote --tags`), because a bad ref in `settings.json` crashes every Pi command including `pi list`/`--list-models`; recovery needs a non-Pi path (edit settings.json). The guard-extension idea (architecture 6.2) cannot cover this since Pi dies before extensions load. (4) `factory doctor` credential diagnostics: match `could not read Username for 'https://github.com'` (Pi/git HTTPS, Pi exit 1, git 128) and `Permission denied (publickey)` (npm SSH fallback, exit 128). (5) Only a nonce-carrying marker proves a load; exit 0 alone proves nothing. (6) Private installs need git credentials (HTTPS credential helper or SSH key); with prompts off nothing hangs. (7) `npm install -g` of the package also installs Pi as a peer dependency (npm 7+), so the self-install path must account for that or use `--legacy-peer-deps`/`--omit=peer`.

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
