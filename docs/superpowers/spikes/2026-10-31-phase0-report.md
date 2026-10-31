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

**Method:** Private repo `jrevenga/ai-factory` (owner-approved). Orphan branch `spike/pkg`, commit `8a9eb98` (tag `spike-pkg-v0.1.0`), contains exactly three files: `package.json`, `extensions/probe.ts` (TS source; `import ms from "ms"`, type-only `ExtensionAPI`; on `session_start` writes the marker if `SPIKE_MARKER` is set and emits `factory:handshake`), `bin/factory-spike.mjs`. Probes run through `spikes/phase0/s2-probe.mjs` (resets the scenario's agent dir, npm prefix and npm cache before each run, fresh nonce per run, marker deleted first, explicit `--model openai-codex/gpt-6.1-sol`, only `get_state`) and `spikes/phase0/nocreds.mjs` (resets scenario `nocreds` and scratch HOME). Runners (`spawnBounded` in `pi.mjs`) take `timeoutMs`/`signal`; on timeout they SIGTERM the child process group, poll `kill(-pgid, 0)` until the group is gone, escalate to SIGKILL after 2 s, and resolve only then (Windows: awaited `taskkill /T /F`); the parent also traps SIGINT/SIGTERM, tears down all active groups and exits 130/143. `runNpm` accepts `opts.node` to run the system npm JS entry under another node binary. Pi settings key for packages is `packages` (docs/packages.md v1.4.0). `session_start` handler gets `SessionStartEvent {reason, previousSessionFile?}`. Node 24.13.1 and 22.19.0 (binary installed by `node spikes/phase0/npm.mjs n22 npm install --prefix /home/jorge/projects/ai-factory/spikes/phase0/out/node22 node@22.19.0`, exit 0, `node@22.19.0` then reports `v22.19.0`; used below as `$N22` = `/home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node`).

**Evidence:**

### 0. Node 22.19.0 binary
```
rm -rf /home/jorge/projects/ai-factory/spikes/phase0/out/node22 /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-n22 /home/jorge/projects/ai-factory/spikes/phase0/out/npm-cache-n22; mkdir -p /home/jorge/projects/ai-factory/spikes/phase0/out/node22
node spikes/phase0/npm.mjs n22 npm install --prefix /home/jorge/projects/ai-factory/spikes/phase0/out/node22 node@22.19.0   # exit 0, 'added 2 packages in 7s'
/home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node -v   # v22.19.0
```

### 1. Install by tag, list, marker load (Node 24.13.1)
Scenario cleanup (performed inside the script by `resetScenario('s2n24')`, equivalent to): `rm -rf spikes/phase0/.agent-s2n24 spikes/phase0/.npm-global-s2n24 spikes/phase0/out/npm-cache-s2n24` followed by `mkdir -p` of the same three paths, after the guard confirmed each resolves inside spikes/phase0/.

Command (cwd /home/jorge/projects/ai-factory):
```
node spikes/phase0/s2-probe.mjs load s2n24   # script exit 0
```
The script deletes `spikes/phase0/out/marker-s2n24.json`, generates `nonce = crypto.randomUUID()`, passes `SPIKE_MARKER`/`SPIKE_NONCE` to the RPC child and checks the marker's nonce. `ms` is at `/home/jorge/projects/ai-factory/spikes/phase0/.agent-s2n24/git/github.com/jrevenga/ai-factory/node_modules/ms` (`ms dir exists: true`). Script exit 0 means RPC exit 0 AND marker carries this run's nonce.
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
node v24.13.1; reset scenario s2n24
$ pi install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
exit=0 timedOut=false
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
added 1 package, and audited 2 packages in 615ms
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
nonce=a442a807-9475-4797-8c30-96903e9afe74
$ pi --mode rpc --no-session --model openai-codex/gpt-6.1-sol  <<< get_state
exit=0 timedOut=false
--- stdout ---
{"id":"1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"gpt-6.1-sol","name":"GPT-6.1 Sol","api":"openai-codex-responses","provid [stdout truncated]
--- stderr ---
marker: {"loaded":true,"nonce":"a442a807-9475-4797-8c30-96903e9afe74","ms":7200000}
marker carries this run's nonce: true
```

### 2. Same on Node 22.19.0 (declared minimum)
Scenario cleanup (performed inside the script by `resetScenario('s2n22')`, equivalent to): `rm -rf spikes/phase0/.agent-s2n22 spikes/phase0/.npm-global-s2n22 spikes/phase0/out/npm-cache-s2n22` followed by `mkdir -p` of the same three paths, after the guard confirmed each resolves inside spikes/phase0/.

Command (cwd /home/jorge/projects/ai-factory):
```
/home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node spikes/phase0/s2-probe.mjs load s2n22   # script exit 0
```
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
node v22.19.0; reset scenario s2n22
$ pi install git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0
exit=0 timedOut=false
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
added 1 package, and audited 2 packages in 598ms
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
nonce=d5224662-c957-4f32-8669-d9201e423ea9
$ pi --mode rpc --no-session --model openai-codex/gpt-6.1-sol  <<< get_state
exit=0 timedOut=false
--- stdout ---
{"id":"1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"gpt-6.1-sol","name":"GPT-6.1 Sol","api":"openai-codex-responses","provid [stdout truncated]
--- stderr ---
marker: {"loaded":true,"nonce":"d5224662-c957-4f32-8669-d9201e423ea9","ms":7200000}
marker carries this run's nonce: true
```

### 3. Bad ref: install, then startup
Scenario cleanup (performed inside the script by `resetScenario('badref')`, equivalent to): `rm -rf spikes/phase0/.agent-badref spikes/phase0/.npm-global-badref spikes/phase0/out/npm-cache-badref` followed by `mkdir -p` of the same three paths, after the guard confirmed each resolves inside spikes/phase0/.

Command (cwd /home/jorge/projects/ai-factory):
```
node spikes/phase0/s2-probe.mjs badref badref   # after the failed install it writes spikes/phase0/.agent-badref/settings.json = {"packages":["git:github.com/jrevenga/ai-factory@does-not-exist"]}, fresh nonce, RPC get_state; script exit 0 = no marker with this nonce
```
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
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
nonce=9943fb1c-bd0c-427f-aa80-c53170836d7c
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

Pi does NOT warn and continue: it dies with an unhandled exception, exit 1, no RPC response, no marker. This contradicts docs/packages.md ("warns and keeps running").

`--list-models` in the same agent dir (scenario badref, settings as above) crashes identically (it affects every command):
Command (cwd /home/jorge/projects/ai-factory):
```
node --input-type=module -e "import {runPi} from './spikes/phase0/pi.mjs'; const r=await runPi(['--list-models'],{scenario:'badref',timeoutMs:60000}); console.log('exit='+r.code+' timedOut='+r.timedOut); console.log(r.stderr.split('\n').filter(l=>/pathspec|^Error|Node.js/.test(l)).join('\n'));"
```
(output filtered by the one-liner to pathspec/Error/Node.js lines)
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
exit=1 timedOut=false
error: pathspec 'does-not-exist' did not match any file(s) known to git
Error: git checkout does-not-exist failed with code 1
Node.js v24.13.1
```

Same on Node 22.19.0:
Scenario cleanup (performed inside the script by `resetScenario('badref22')`, equivalent to): `rm -rf spikes/phase0/.agent-badref22 spikes/phase0/.npm-global-badref22 spikes/phase0/out/npm-cache-badref22` followed by `mkdir -p` of the same three paths, after the guard confirmed each resolves inside spikes/phase0/.

Command (cwd /home/jorge/projects/ai-factory):
```
/home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node spikes/phase0/s2-probe.mjs badref badref22   # script exit 0 = no marker
```
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
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
nonce=6b78b271-7f86-43cd-bcc7-0c4e9228c467
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

### 4. No credentials, Pi
Environment built by `spikes/phase0/nocreds.mjs`: `GIT_CONFIG_GLOBAL=/home/jorge/projects/ai-factory/spikes/phase0/out/empty.gitconfig` (empty file), `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=`, `SSH_ASKPASS=`, `HOME`/`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` = `/home/jorge/projects/ai-factory/spikes/phase0/out/home-nocreds` (deleted and recreated empty each run), `GIT_SSH_COMMAND="ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null"`, `SSH_AUTH_SOCK`, `NETRC`, `GIT_CONFIG_COUNT`/`KEY_*`/`VALUE_*`/`PARAMETERS` removed; 120 s `timeoutMs` with tree kill; the mode argument must be exactly `pi` or `npm` (otherwise usage and exit 2, before any cleanup). Cleanup: `resetScenario('nocreds', ['/home/jorge/projects/ai-factory/spikes/phase0/out/home-nocreds'])`.

Node 24.13.1:
Command (cwd /home/jorge/projects/ai-factory):
```
node spikes/phase0/nocreds.mjs pi   # script exits 0 and prints Pi's own exit code on its first output line
```
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
exit=1 timedOut=false elapsed=624ms
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory'...
fatal: could not read Username for 'https://github.com': terminal prompts disabled
Error: git clone https://github.com/jrevenga/ai-factory /home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory failed with code 128
```

Node 22.19.0:
Command (cwd /home/jorge/projects/ai-factory):
```
/home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node spikes/phase0/nocreds.mjs pi
```
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
exit=1 timedOut=false elapsed=466ms
--- stdout ---
Installing git:github.com/jrevenga/ai-factory@spike-pkg-v0.1.0...
--- stderr ---
Cloning into '/home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory'...
fatal: could not read Username for 'https://github.com': terminal prompts disabled
Error: git clone https://github.com/jrevenga/ai-factory /home/jorge/projects/ai-factory/spikes/phase0/.agent-nocreds/git/github.com/jrevenga/ai-factory failed with code 128
```

### 5. No credentials, npm
Node 24.13.1:
Command (cwd /home/jorge/projects/ai-factory):
```
node spikes/phase0/nocreds.mjs npm   # exit code printed on first output line
```
npm tried only SSH (pacote falls back from HTTPS).
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
exit=128 timedOut=false elapsed=1334ms
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
npm error A complete log of this run can be found in: /home/jorge/projects/ai-factory/spikes/phase0/out/npm-cache-nocreds/_logs/2026-10-31T16_01_07_051Z-debug-0.log
```

Node 22.19.0 (npm's JS entry run with the 22.19.0 binary through `opts.node`; the npm debug log of that run says `verbose node v22.19.0`):
Command (cwd /home/jorge/projects/ai-factory):
```
SPIKE_NODE=/home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node node spikes/phase0/nocreds.mjs npm
```
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
exit=128 timedOut=false elapsed=1175ms
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
npm error A complete log of this run can be found in: /home/jorge/projects/ai-factory/spikes/phase0/out/npm-cache-nocreds/_logs/2026-10-31T16_01_08_462Z-debug-0.log
```

### 6. Positive control with the owner's normal git credentials (npm leg)
Cleanup: `rm -rf /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-npmok /home/jorge/projects/ai-factory/spikes/phase0/out/npm-cache-npmok /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-npmok2 /home/jorge/projects/ai-factory/spikes/phase0/out/npm-cache-npmok2`
Command (cwd /home/jorge/projects/ai-factory):
```
node spikes/phase0/npm.mjs npmok npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
node /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-npmok/bin/factory-spike
npm_config_prefix=/home/jorge/projects/ai-factory/spikes/phase0/.npm-global-npmok2 npm_config_cache=/home/jorge/projects/ai-factory/spikes/phase0/out/npm-cache-npmok2 node /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-npmok/lib/node_modules/ai-factory-spike/bin/factory-spike.mjs install
ls /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-npmok2/bin
```
(Output order: install, exit; bin, exit; `factory-spike install` output, exit; `ls`.) 122 packages were installed because npm auto-installs the `@earendil-works/pi-coding-agent` peer dependency.
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
added 122 packages in 12s
9 packages are looking for funding
  run `npm fund` for details
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
exit=0
factory-spike ok v24.13.1
exit=0
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
added 122 packages in 11s
9 packages are looking for funding
  run `npm fund` for details
exit=0
factory-spike
```

Same npm install under Node 22.19.0 (`npm-cli.js` run by the 22.19.0 binary; npm debug log: `verbose node v22.19.0`; `.npm-global-s2n22npm/bin` contains `factory-spike`):
Command (cwd /home/jorge/projects/ai-factory):
```
node spikes/phase0/npm-node.mjs s2n22npm /home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node   # resetScenario("s2n22npm") inside; exit 0
```
Output (verbatim; trimmed only: blank lines, git detached-HEAD advice, npm update notices; long lines marked):
```
exit=0 timedOut=false
--- stdout ---
added 122 packages in 12s
9 packages are looking for funding
  run `npm fund` for details
--- stderr ---
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
```

### 7. Timeout kills and awaits the whole tree, including a SIGTERM-ignoring descendant
Tree: `npm -> git -> git remote-https -> /bin/sh -c "sh -c 'trap \"\" TERM; sleep 300'"` (credential helper ignores SIGTERM). `runNpm(..., {timeoutMs: 3000})`; elapsed 5076 ms = 3 s + 2 s grace, so the SIGKILL escalation was awaited; `ps` right after the runner resolved shows nothing. Cleanup: `resetScenario('tmo')`. Signals, timeouts, aborts and orphan cleanup share one per-child `cancel()` that starts the awaited teardown once and returns the same promise; the child's completion promise never resolves before it.
```
cd /home/jorge/projects/ai-factory && node spikes/phase0/timeout-proof.mjs   # exit 0
descendants while running (t=2s):
2166143 2166136 2166143 npm install git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
2166165 2166143 2166143 git --no-replace-objects ls-remote https://github.com/jrevenga/ai-factory.git
2166191 2166167 2166143 /bin/sh -c sh -c 'trap "" TERM; sleep 300 #spike-tmo-marker' get sh -c 'trap "" TERM; sleep 300 #spike-tmo-marker' get
2166197 2166191 2166143 sh -c trap "" TERM; sleep 300 #spike-tmo-marker get
process group of the whole tree: 2166143 
all members:
2166143 2166136 2166143 npm install git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
2166165 2166143 2166143 git --no-replace-objects ls-remote https://github.com/jrevenga/ai-factory.git
2166166 2166165 2166143 /home/linuxbrew/.linuxbrew/opt/git/libexec/git-core/git remote-https https://github.com/jrevenga/ai-factory.git https://github.com/jrevenga/ai-factory.git
2166167 2166166 2166143 /home/linuxbrew/.linuxbrew/opt/git/libexec/git-core/git-remote-https https://github.com/jrevenga/ai-factory.git https://github.com/jrevenga/ai-factory.git
2166191 2166167 2166143 /bin/sh -c sh -c 'trap "" TERM; sleep 300 #spike-tmo-marker' get sh -c 'trap "" TERM; sleep 300 #spike-tmo-marker' get
2166197 2166191 2166143 sh -c trap "" TERM; sleep 300 #spike-tmo-marker get
2166199 2166197 2166143 sleep 300
result: code=null timedOut=true elapsed=5076ms
leftover processes (name match + every member of the process group) immediately after runner resolved: none
```

### 8. Ctrl+C on the parent kills the detached groups
`sigint-proof.sh` (`set -eu`, `mkdir -p` of its log dir, non-zero exit unless the parent exits 130) starts `node spikes/phase0/timeout-proof.mjs sigint` (120 s timeout, same tree; cleanup `resetScenario('sigint')`), waits 4 s, sends SIGINT:
```
cd /home/jorge/projects/ai-factory && sh spikes/phase0/sigint-proof.sh   # script exit 0
parent pid=2165673; processes before SIGINT:
2165681 2165681 npm install git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
2165694 2165681 git --no-replace-objects ls-remote https://github.com/jrevenga/ai-factory.git
2165698 2165681 /bin/sh -c sh -c 'trap "" TERM; sleep 300 #spike-tmo-marker' get sh -c 'trap "" TERM; sleep 30
2165699 2165681 sh -c trap "" TERM; sleep 300 #spike-tmo-marker get
2165700 2165681 sleep 300
parent exit code=130 (130 expected)
processes after parent exit:
(end of list)
```

### 9. Ctrl+C race: direct child closed, SIGTERM-ignoring descendant alive
`sigint-orphan-proof.sh` runs `orphan-proof.mjs`: `spawnBounded('/bin/sh', ['-c', '(trap "" TERM; exec sleep 300) >/dev/null 2>&1 </dev/null & exit 0'])`. The shell exits at once and the sleeper holds no pipe, so the child's `close` fires immediately, yet the sleeper is still in the group. The runner treats it as an orphan and cancels it (same `cancel()`), and a SIGINT sent 0.6 s after start joins that teardown. Parent exit comes only after SIGKILL of the sleeper (timestamps are `HH:MM:SS.mmm`; script exits non-zero unless parent code is 130 and nothing is left):
```
cd /home/jorge/projects/ai-factory && sh spikes/phase0/sigint-orphan-proof.sh   # script exit 0
16:06:05.200 parent pid=2167475; direct child already gone, sleeper still alive:
2167484       1 2167483 sleep 300
16:06:05.222 sending SIGINT to parent
16:06:06.687 parent exited with code 130 (130 expected)
processes after parent exit:
none
parent log:
16:06:04.607 start
16:06:06.681 runner resolved: code=0 orphans=true
```

**Verdict:** PASS on Node 24.13.1 and 22.19.0 (Pi legs and npm legs) for install-by-tag from a private repo with credentials, and for TS-source extension plus dependency (no build step). Failure modes (bad tag, missing credentials) are loud, bounded and distinguishable, but an unresolvable ref in settings is fatal for every Pi command rather than a warning.

**Design impact:** (1) Ship TS source; jiti is sufficient, no built JS artifact required. (2) Pi stays in `peerDependencies`, libraries in `dependencies`; they land in the checkout's `node_modules`. (3) Pinned refs must be validated before being written to settings (e.g. `git ls-remote --tags`), because a bad ref in `settings.json` crashes every Pi command including `pi list`/`--list-models`; recovery needs a non-Pi path (edit settings.json). The guard-extension idea (architecture 6.2) cannot cover this since Pi dies before extensions load. (4) `factory doctor` credential diagnostics: match `could not read Username for 'https://github.com'` (Pi/git HTTPS, Pi exit 1, git 128) and `Permission denied (publickey)` (npm SSH fallback, exit 128). (5) Only a nonce-carrying marker proves a load; exit 0 alone proves nothing. (6) Private installs need git credentials (HTTPS credential helper or SSH key); with prompts off nothing hangs. (7) `npm install -g` of the package also installs Pi as a peer dependency (npm 7+), so the self-install path must account for that or use `--legacy-peer-deps`/`--omit=peer`.

## S3 CLI install path

**Question:** Can a persistent `factory` executable be installed from the private repo into an empty npm prefix with `npm install -g`, and can a single `npx -y github:... install` command bootstrap it (the executable surviving after npx exits)?

**Method:** Tag `spike-pkg-v0.1.0` (`bin/factory-spike.mjs`; `package.json` has no `scripts`, so no build/prepare step exists to run). Every scenario was reset (`resetScenario`) before its run; npm ran through `spikes/phase0/npm.mjs` (forced prefix `.npm-global-<scenario>`, cache `out/npm-cache-<scenario>`). The executable was then run in a new process (`env -u npm_config_prefix`, cwd `/tmp`) from the POSIX location `<prefix>/bin/factory-spike` (on Windows `<prefix>/factory-spike.cmd`; not tested here, see S10). Node 24.13.1 (default) and an official Node 22.19.0 distribution (see "Node 22.19.0 rerun" below) were used. (An earlier Node 22 attempt used an npm-less standalone binary; it did not run the `install` branch under 22.19 and its claim was withdrawn.) Owner's `npm prefix -g` recorded before and after.

**Evidence:**

Step 1, Node 24.13.1 (`cli`):
```
node /home/jorge/projects/ai-factory/spikes/phase0/npm.mjs cli npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
-> exit 0, "added 122 packages in 11s" (wall 11.8 s; warn: deprecated node-domexception@1.0.0; notice: new npm 11.21.1, trimmed)
ls -la /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-cli/bin
  factory-spike -> ../lib/node_modules/ai-factory-spike/bin/factory-spike.mjs
/home/jorge/projects/ai-factory/spikes/phase0/.npm-global-cli/bin/factory-spike   (new process, cwd /tmp)
  factory-spike ok v24.13.1   # exit 0
```
Step 2, Node 24.13.1 (`bootstrap`):
```
npm prefix -g (owner env) before: /home/linuxbrew/.linuxbrew
node /home/jorge/projects/ai-factory/spikes/phase0/npm.mjs bootstrap npx -y github:jrevenga/ai-factory#spike-pkg-v0.1.0 install
-> exit 0, "added 122 packages in 9s" (single run, wall 21.9 s; the "9s" is the inner npm install, the remainder is npx fetching the package and startup)
ls -la /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-bootstrap/bin
  factory-spike -> ../lib/node_modules/ai-factory-spike/bin/factory-spike.mjs
/home/jorge/projects/ai-factory/spikes/phase0/.npm-global-bootstrap/bin/factory-spike   (new process after npx exited, cwd /tmp)
  factory-spike ok v24.13.1   # exit 0
```
Owner environment after all runs: `npm prefix -g` = `/home/linuxbrew/.linuxbrew` (unchanged); `ls /home/linuxbrew/.linuxbrew/bin | grep -c factory-spike` = 0.

Node 22.19.0 rerun (official distribution, fixes review finding on the earlier leg):
```
curl -fsSLO https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz ; curl -fsSLO .../SHASUMS256.txt   (into /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/)
grep node-v22.19.0-linux-x64.tar.xz SHASUMS256.txt | sha256sum -c -   -> node-v22.19.0-linux-x64.tar.xz: OK
tar xf ...  ->  bin/{corepack,node,npm,npx}; node -v = v22.19.0; npm -v = 10.9.3 (bundled, next to node)
PATH=/home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/bin:<original PATH minus every dir containing a node executable>; npm_config_loglevel=verbose
which node -> /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/bin/node (v22.19.0); which npx -> /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/bin/npx; `which -a node` lists only that one
```
The driver was itself started by the official node (`node /home/jorge/projects/ai-factory/spikes/phase0/s3-probe.mjs <scenario> <tool> - <args>`), so `process.execPath` is Node 22.19.0 and runNpm's `npmEntry` resolves the official bundled npm; `runNpm` still forces prefix `.npm-global-<scenario>` and cache `out/npm-cache-<scenario>` with the containment guard. Scenarios reset first.
```
(a) node /home/jorge/projects/ai-factory/spikes/phase0/s3-probe.mjs cli-n22 npm - install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
  exit=0 durationMs=9719, "added 122 packages in 10s"
  npm verbose cli /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/bin/node /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js
(b) node /home/jorge/projects/ai-factory/spikes/phase0/s3-probe.mjs bootstrap-n22 npx - -y github:jrevenga/ai-factory#spike-pkg-v0.1.0 install
  exit=0 durationMs=17683, "added 122 packages in 7s"
  outer: npm verbose cli /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/bin/node /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js ; title "npm exec github:jrevenga/ai-factory#spike-pkg-v0.1.0 install"; npm info using node@v22.19.0
  inner (spawned by the package's `install` branch): npm verbose cli /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/bin/node /home/jorge/projects/ai-factory/spikes/phase0/out/node22-official/node-v22.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js ; title "npm install git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0"; argv "install" "--global" ...
new process, same PATH, env -u npm_config_prefix, cwd /tmp:
  /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-cli-n22/bin/factory-spike        -> factory-spike ok v22.19.0   # exit 0
  /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-bootstrap-n22/bin/factory-spike  -> factory-spike ok v22.19.0   # exit 0
```
Lifecycle scripts (verbose log excerpt, both runs): only dependencies ran scripts, not the spike package: `npm info run @google/genai@2.21.0 preinstall ... echo 'preinstall: no-op'` and `npm info run protobufjs@7.6.6 postinstall ... node scripts/postinstall` (each `{ code: 0, signal: null }`); no `run ai-factory-spike@...` line appears. The spike package itself declares no scripts, so no build/prepare step ran for it; the Pi peer-dependency tree does run two dependency scripts.

**Verdict:** Linux, single runs, owner's git credential helper. Proven per Node version:
- Node 24.13.1: `npm install -g` (exit 0, ~11 s) and `npx -y github:... install` (exit 0, ~22 s) both leave a working persistent `factory-spike` (`ok v24.13.1`); the executable survives after npx exits (symlink into the prefix's `lib/node_modules`, not the npx cache).
- Official Node 22.19.0 with bundled npm 10.9.3 first on PATH: both legs also exit 0, outer and inner npm logs show the 22.19.0 node and its bundled npm, and the installed executable prints `ok v22.19.0`.
- Not proven: a Node without bundled npm next to it (the earlier standalone 22.19 binary), Windows, macOS, or a clean machine without git credentials (auth failure is covered by S2 and feeds the Task 11 `doctor` message).
The one-command bootstrap works in these runs. Timings are single runs; the bootstrap (~22 s vs ~11 s) includes npx fetching the package plus the inner install, and the cost split was not measured further. Keep `npm install -g` as the documented fallback.

**Design impact:** Task 11 can document `npx -y github:jrevenga/ai-factory#<tag> install` as the entry point with `npm install -g git+https://github.com/jrevenga/ai-factory.git#<tag>` as fallback. The spike's `install` branch resolves npm relative to `process.execPath` (`<node-dir>/../lib/node_modules/npm/bin/npm-cli.js`), which is fragile: standalone node binaries, nvm/volta shims and Node installs without bundled npm break it (observed: the standalone Node 22.19 binary has no npm beside it). The real installer should locate npm via `npm_execpath` (set when run through npm/npx) or invoke `npm` from PATH. `doctor` should check that `npm prefix -g` is writable without sudo and report the private-repo auth failure from S2; on Windows the executable is `<prefix>/factory-spike.cmd` (confirm in S10).

## S4 bridge tools and gates

**Question:** Does a Pi `tool_call` extension hook see and gate every write-capable action the model takes when the model runs through `pi-claude-bridge`, with no tool executing outside Pi?

**Method:** Pi 1.4.0 (isolated launcher, default `.agent`), `npm:pi-claude-bridge@0.9.3` installed with `node spikes/phase0/pi.mjs install npm:pi-claude-bridge@0.9.3` (exit 0, "Installed npm:pi-claude-bridge@0.9.3"). Model ids from `node spikes/phase0/pi.mjs --list-models` (no inference): `claude-bridge/claude-opus-5-5` (also `claude-opus-5`, `claude-opus-4-8`, ...); native Codex: `openai-codex/gpt-6.1-sol` (also `openai/gpt-6.1-sol`). Extension `spikes/phase0/gate-probe.ts` (`tool_call` logs and, with `SPIKE_BLOCK_WRITES=1`, blocks `write`/`edit`/`bash` with reason "spike gate"; `tool_execution_end` logs the outcome). Three runs (control, blocked write, blocked bash) per provider in fresh temp dirs, all probe paths absolute, stdin `</dev/null` (without it `-p` hung when launched from a non-TTY harness: no output until timeout).

First bridge round, control (T1=/tmp/tmp.UDh96xs4Fh) and blocked write (T2=/tmp/tmp.m6SHTzdZ97); the third run was added in fix round 1:
```
cd $T && SPIKE_TOOLLOG=<abs>/out/s4-run{1,2}.jsonl SPIKE_INVENTORY=<abs>/out/s4-inv{1,2}.json SPIKE_BLOCK_WRITES={0,1} \
  timeout 170 node <abs>/spikes/phase0/pi.mjs -p --no-session --model claude-bridge/claude-opus-5-5 \
  --extension <abs>/spikes/phase0/gate-probe.ts "Create a file named created.txt containing hello, then answer in one sentence." </dev/null
```
Fix round 1: all three runs were re-executed with `> out.txt 2>&1; echo "exit=$?"` (bash script) after changing `textHead` to the joined `result.content[].text`. Run 3 (T3=/tmp/tmp.rixLbwtJhk, `SPIKE_BLOCK_WRITES=1`) uses the prompt `Run this exact shell command with your bash tool: echo hello > created.txt — then answer in one sentence.` Exit codes: run 1 `exit=0`, run 2 `exit=0`, run 3 `exit=0`. Evidence below is from the re-run (T1=/tmp/tmp.quDcwwgonE, T2=/tmp/tmp.bnnWQn84uB).

**Evidence:**

Run 1 (unblocked, exit=0) final text: `Listo: he creado created.txt con el contenido hello en /tmp/tmp.quDcwwgonE. PINEAPPLE`; `created.txt` exists (`hello`). tools.jsonl:
```
{"ts":1793464269102,"event":"tool_call","toolCallId":"toolu_01BDethcLHSJKfBQEAvEnHNo","toolName":"write","inputKeys":["path","content"],"decision":"allowed"}
{"event":"tool_execution_end","toolCallId":"toolu_01BDethcLHSJKfBQEAvEnHNo","toolName":"write","isError":false,"textHead":"Successfully wrote to /tmp/tmp.quDcwwgonE/created.txt"}
```
Run 2 (blocked write, exit=0) final text: `No he podido crear created.txt porque la escritura falló con el error «spike gate», así que el archivo NO existe ... PINEAPPLE`; T2 has no `created.txt`. tools.jsonl:
```
{"ts":1793464275167,"event":"tool_call","toolCallId":"toolu_01Nnrn6QcnQT5wR6L5Tz5ibx","toolName":"write","inputKeys":["path","content"],"decision":"blocked"}
{"event":"tool_execution_end","toolCallId":"toolu_01Nnrn6QcnQT5wR6L5Tz5ibx","toolName":"write","isError":true,"textHead":"spike gate"}
```
Run 3 (blocked bash, exit=0) final text: `No pude ejecutarlo: el comando echo hello > created.txt fue bloqueado con el error "spike gate", así que created.txt NO se ha creado. PINEAPPLE`; T3 has no `created.txt`. tools.jsonl:
```
{"ts":1793464283218,"event":"tool_call","toolCallId":"toolu_014aAp8TgXH3ktcwX9ui3E33","toolName":"bash","inputKeys":["command","timeout"],"decision":"blocked"}
{"event":"tool_execution_end","toolCallId":"toolu_014aAp8TgXH3ktcwX9ui3E33","toolName":"bash","isError":true,"textHead":"spike gate"}
```
Correlation table:

| run | blocked toolCallId | tool | tool_execution_end isError | text contains "spike gate" |
|---|---|---|---|---|
| 2 | toolu_01Nnrn6QcnQT5wR6L5Tz5ibx | write | true | yes |
| 3 | toolu_014aAp8TgXH3ktcwX9ui3E33 | bash | true | yes |

Zero `allowed` write-capable calls in runs 2 and 3; no file created without a logged `tool_call` (no bypass). `edit` was not exercised.

**Verdict (bridge):** PASS. Pi's `tool_call` hook sees the bridged tool calls (the bridge serves Pi's tools to Claude Code over MCP, bridge `src/index.ts` ~L916; Claude Code's tool requests are routed back to Pi tools, here `write` and `bash`), can block them, and the denial reaches the model as an error result (`isError: true`, "spike gate"). Both `write` and `bash` blocks were proven (runs 2 and 3); in run 2 the model did not try a shell alternative on its own. `edit` blocking is extrapolated, not exercised. Native Codex leg: see below (PASS as well).

**Design impact:** The Factory's gate extension (`tool_call` returning `{block, reason}`) is proven enforceable on the Claude-via-bridge path for `write` and `bash` (`edit` is extrapolated from the same hook mechanism, not exercised); the native Codex provider behaves the same (see the Codex leg below). The gate must key on Pi tool names (`write`, `edit`, `bash`, ...). Use `tool_execution_end`, not `tool_result`, to audit denials in Pi 1.4.0. Launch non-interactive Pi from automation with stdin closed (`</dev/null`). Side observation: the bridge-run answers came in Spanish with the owner's persona, i.e. Claude Code still loads the owner's `~/.claude` instructions into the bridge session; for reproducible Factory runs the bridge environment must be checked for user-level CLAUDE.md leakage (not investigated here).

### Native Codex leg (`openai-codex/gpt-6.1-sol`)

Run on 2026-10-31 after the quota returned. Same extension, same prompts as the bridge runs, driver script (kept outside the repo) per run: fresh `mktemp -d` cwd, absolute probe paths, stdin `</dev/null`, `> out 2>&1; echo exit=$?`:
```
cd $T && SPIKE_TOOLLOG=<abs>/spikes/phase0/out/s4c-run$n.jsonl SPIKE_INVENTORY=<abs>/spikes/phase0/out/s4c-inv$n.json SPIKE_BLOCK_WRITES={0,1,1} \
  timeout 170 node <abs>/spikes/phase0/pi.mjs -p --no-session --model openai-codex/gpt-6.1-sol \
  --extension <abs>/spikes/phase0/gate-probe.ts "<prompt>" </dev/null
```
Prompts: runs 1 and 2 `Create a file named created.txt containing hello, then answer in one sentence.`; run 3 `Run this exact shell command with your bash tool: echo hello > created.txt — then answer in one sentence.` All three: `exit=0`. No run was inconclusive (each had at least one `tool_call` event), so no re-run was needed.

Run 1 (unblocked, T1=/tmp/tmp.Ou7SPFNvwD): answer `Created \`created.txt\` containing \`hello\` PINEAPPLE`; `created.txt` exists.
```
{"event":"tool_call","toolName":"write","inputKeys":["path","content"],"decision":"allowed"}
{"event":"tool_execution_end","toolName":"write","isError":false,"textHead":"Successfully wrote to created.txt"}
```
Run 2 (blocked, T2=/tmp/tmp.HHetWy5Dvp): answer `I couldn't create \`created.txt\` because the tools were blocked by a spike gate, PINEAPPLE.`; T2 empty (no `created.txt`). Unlike Claude, the model tried a shell alternative after the write was blocked, and that was blocked too:
```
{"event":"tool_call","toolName":"write","decision":"blocked"}   -> tool_execution_end isError:true textHead:"spike gate"  (same toolCallId)
{"event":"tool_call","toolName":"bash","inputKeys":["command"],"decision":"blocked"} -> tool_execution_end isError:true textHead:"spike gate"
```
Run 3 (blocked bash, T3=/tmp/tmp.44mM7tyaGn): answer `The command was attempted, but the tool returned "spike gate," so file creation is unconfirmed. PINEAPPLE`; T3 empty.
```
{"event":"tool_call","toolName":"bash","inputKeys":["command"],"decision":"blocked"} -> tool_execution_end isError:true textHead:"spike gate"
```
Each `tool_execution_end` carries the same `toolCallId` as its blocked `tool_call` (Codex ids look like `call_...|fc_...`). Zero `allowed` write-capable calls in runs 2 and 3, no file created without a logged `tool_call`. The tool inventory (`s4c-inv1.json`) is byte-identical to the bridge inventory (`diff` empty; active `read, bash, edit, write`). Differences vs. the bridge: none in the gate behaviour; the Codex answers are in English and the model retried with `bash` after a blocked `write`, so gates must cover both tools together (they did here). `edit` still not exercised.

**Verdict (Codex):** PASS. `tool_call` gating and `tool_execution_end` error reporting behave identically on native Codex, and the `before_agent_start` section (PINEAPPLE) reaches the model on all three runs.

## S5 prompt sections

**Question:** Are section mutations made in `before_agent_start` (`event.systemPromptOptions.sections[...]`) delivered to the model through the bridge, and does the bridge expose only Pi tools (no Claude Code built-ins)?

**Method:** `gate-probe.ts` adds `sections["spike-role"] = "End every final answer with the word PINEAPPLE."` (shape from `examples/extensions/prompt-customizer.ts`, Pi v1.4.0). `session_start` dumps `pi.getAllTools()` and `pi.getActiveTools()` to `SPIKE_INVENTORY`. Same three runs as S4, plus a one-off `say hi` run (output ended with `PINEAPPLE`). Bridge source cited at tag `v0.9.3` `src/index.ts`: line 128 comment ("The provider path never sees these — it starts CC with `tools: []`"), line 595 `tools: [],`, line 916 comment ("Provider path: the query runs with `tools: []`"), also line 2035.

**Evidence:** Both final answers end with `PINEAPPLE` (run 1 and run 2 above; also the `say hi` run). Inventory (identical in both runs):
```
active: ["read","bash","edit","write"]
all: read, bash, powershell, edit, write, grep, find, ls (exposure direct, source builtin); codemode, tool_search (exposure model-only, builtin)
```
No annotations; no bridge-provided tools in the inventory (the bridge is a provider, not a tool source). tools.jsonl contains only the lowercase Pi tool name `write`; no Claude Code built-in names (`Write`, `Bash`, `Read`, `Edit`, ...) appear.

**Verdict (bridge):** PASS. Sections reach the model through the bridge (PINEAPPLE obeyed on all three runs), and the effective configuration contains only Pi tools; the pinned source starts Claude Code with `tools: []` on the provider path. Caveat: absence of built-ins is shown by inventory + log + source, not by an adversarial attempt to make the model call a built-in.

**Design impact:** Role/policy text can be injected as named sections via `before_agent_start` and will reach Claude through the bridge (whereas a full `systemPrompt` replacement is dropped by the bridge). The gate therefore only has to cover Pi tool names. Native Codex: same result (PINEAPPLE obeyed on all three runs, identical tool inventory), see the S4 Codex leg.

## S6 limit signals

**Question:** Do Pi's `after_provider_response` hook and the provider layer expose subscription limit state (rate-limit headers) and a recognisable exhaustion signal, for Claude via `pi-claude-bridge` and for native Codex?

**Method:** Pi 1.4.0, `pi-claude-bridge@0.9.3`, Node as installed in the launcher. `spikes/phase0/gate-probe.ts` gained an `after_provider_response` handler that appends `{ts, provider, model, status, headerNames, rateLimit}` to `SPIKE_HEADERLOG`; `rateLimit` holds only response headers whose name matches `/ratelimit|rate-limit|retry-after|usage|quota/i` (names of all other headers only; no request headers, no tokens). Driver `spikes/phase0/s6-probe.mjs` spawns `pi.mjs --mode rpc --model <m> --extension <abs>/gate-probe.ts` (sessions enabled, default `.agent`), sends three sequential `prompt` commands (`Say ok.`; `Run the shell command: echo hi. Then say done.`; `Say ok again.`) and waits for `agent_settled` after each.

### Bridge: live observation

```
$ cd /tmp && node /home/jorge/projects/ai-factory/spikes/phase0/s6-probe.mjs bridge claude-bridge/claude-opus-5-5   # exit=0
--- prompt 1 settled / --- prompt 2 settled (tool_execution_start/end seen) / --- prompt 3 settled
sessions dir exists: true [ '2026-10-31T16-33-28-431Z_...jsonl', '2026-10-31T16-36-09-691Z_01a192d1-....jsonl' ]
```
(The first session file is from an earlier identical run whose driver output I did not capture; the second is the captured run.) `out/headers-bridge.jsonl` of the captured run (3 lines, rate-limit values only, one line shown in full, the others identical except `ts` and, in run 1, utilization 0.36):
```
{"ts":1793464576690,"provider":"claude-bridge","model":"claude-opus-5-5","status":200,"headerNames":["anthropic-ratelimit-unified-status","anthropic-ratelimit-unified-reset","anthropic-ratelimit-unified-representative-claim","anthropic-ratelimit-unified-overage-status","anthropic-ratelimit-unified-5h-utilization","anthropic-ratelimit-unified-5h-reset","anthropic-ratelimit-unified-7d-utilization","anthropic-ratelimit-unified-7d-reset"],"rateLimit":{...status:"allowed", representative-claim:"five_hour", overage-status:"rejected", 5h-utilization:"0.37", 7d-utilization:"0.44", reset epochs...}}
```
Observed: 3 header events for 4 provider turns (prompt 2 has two turns around the tool call), always `status` 200, same 8 names. The values are taken from Claude Code `rate_limit_event`s, so they are emitted at most once per query and may lag a call. The earlier run showed 5h utilization 0.36, this one 0.37, so the values do move. Windows exposed: `5h`, `7d`.

### Exhaustion path (desk check)

**Bridge** (`.agent/npm/node_modules/pi-claude-bridge/src/`): Claude Code reports plan usage as `rate_limit_event` SDK messages, not HTTP (`rate-limit.ts` L1-3); `rateLimitResponse()` rebuilds `anthropic-ratelimit-unified-{status,reset,representative-claim,overage-status,overage-reset,<5h|7d|7d_oi>-utilization,-reset}` and always returns status 200 (`rate-limit.ts` ~L31-50, "a 'rejected' status can still be served from overage"). `index.ts` L1529-1536 handles the event and calls `reportHeldRateLimit` (L534-539) which calls `onResponse` (so `after_provider_response`) before the next stream event of the owning call. On `status === "rejected"` the bridge also stores `rateLimitRejection` and shows a UI notice (L1536-1543). The failing result arrives afterwards as `is_error` on a success-shaped result (`resultErrorText`, L502-507) and the turn ends with `stopReason: "error"`; `errorMessage` is rewritten by `describeRateLimitFailure` (L526-530) to `Claude quota exceeded — rate limit (<type>) — resets <time>: <Claude Code text>` (e.g. Claude Code's "You're out of extra usage · resets 6:30pm", comment L514-524). So the exhaustion signal for extensions is: header `anthropic-ratelimit-unified-status` = `rejected` (status code stays 200) plus an assistant message with `stopReason: "error"` and the "Claude quota exceeded — rate limit" prefix. Warning level: `allowed_warning` status with utilization fraction (L1546-1558). Not live-tested (would need an exhausted account).

**Native Codex** (Pi v1.4.0 `packages/ai/src/api/openai-codex-responses.ts`, same code as the installed `.prefix/.../pi-ai/dist/api/openai-codex-responses.js`):
- `onResponse` (which Pi wires to `after_provider_response`: `pi-coding-agent/dist/core/sdk.js` L232-235, event is only `{status, headers}`) is called in exactly one place, the SSE path after `fetch` (source L429-432; dist L286), and before the `response.ok` check, so a 429 reaches the hook with its real status and all response headers.
- The default transport is `auto` (`core/settings-defaults.js` L4), which tries WebSocket first (source L316-358) and only falls back to SSE on transport failure. `onResponse` is not called anywhere in the WebSocket path (grep: one occurrence in the file). Inference, to be confirmed live: with the default transport, `after_provider_response` probably never fires for Codex, so rate/usage headers are not observable unless `transport: "sse"` is set.
- Exhaustion: HTTP 429 (SSE). `isTerminalRateLimitError` (L127-131: GoUsageLimitError, FreeUsageLimitError, "Monthly usage limit reached", insufficient_quota, quota exceeded, billing...) makes it non-retryable; other 429/5xx are retried with `retry-after-ms`/`retry-after` (L133-156, L439-448). The final error is built by `parseErrorResponse` (L1618-1642): for code `usage_limit_reached|usage_not_included|rate_limit_exceeded` or any 429, message `You have hit your ChatGPT usage limit (<plan> plan). Try again in ~N min.` (from `error.plan_type`, `error.resets_at`), thrown as `Error` (L450-456) and surfaced as an assistant message with `stopReason: "error"` (L505-507); the retry loop does not retry messages containing "usage limit" (L468). On the WebSocket path, errors arrive as `type: "error"` / `response.failed` events (L781-793) and become `CodexApiError("Codex error: ...")`. The Codex CLI's own wording earlier today ("You've hit your usage limit ... try again at 5:38 PM") differs from Pi's friendly message; extensions must not match on either string alone, preferably on `stopReason: "error"` plus a pattern like `/usage limit|rate limit|quota/i`.

### Native Codex live observation

Transport setting in Pi 1.4.0 (found in the installed source, `spikes/phase0/.prefix/node_modules/@earendil-works/pi-coding-agent/dist/`): `core/settings-defaults.js` L4 `transport: "auto"`; `core/settings-manager.js` L614 `getTransport()` returns `this.settings.transport ?? SETTINGS_DEFAULTS.transport`, L616 `setTransport()`, L287-289 legacy `websockets` boolean migrates to `transport: "websocket"|"sse"`; `core/sdk.js` L285 passes `transport: settingsManager.getTransport()` to the provider. So the knob is the `transport` key of the agent dir `settings.json` (values `auto`, `sse`, `websocket`); no CLI flag or env var for it was found (`grep -n transport dist/main.js dist/cli/args.js` empty). For the `sse` run I temporarily added `"transport": "sse"` to `spikes/phase0/.agent/settings.json` (backup copied first) and restored the original content afterwards (verified: no `transport` key remains).

Default transport (`auto`). The first run was piped through `tail -20` (so its `exit=0` was tail's and its output was partial); it was therefore repeated once, with proper capture (fix round 1):
```
$ cd /tmp && node /home/jorge/projects/ai-factory/spikes/phase0/s6-probe.mjs codex-auto openai-codex/gpt-6.1-sol </dev/null > /home/jorge/projects/ai-factory/spikes/phase0/out/s6-codex-auto-driver.txt 2>&1; echo exit=$?
exit=0
--- prompt 1 settled / evt tool_execution_start / --- prompt 2 settled / --- prompt 3 settled
sessions dir exists: true [ '2026-10-31T16-33-28-431Z_01a192cf-...jsonl', '2026-10-31T16-36-09-691Z_01a192d1-...jsonl', '2026-10-31T17-41-48-095Z_01a1930d-...jsonl',
  '2026-10-31T17-44-34-151Z_01a19310-...jsonl', '2026-10-31T17-47-20-223Z_01a19312-...jsonl', '2026-10-31T17-55-39-936Z_01a1931a-591e-74d5-aeab-cf1a211dbdb3.jsonl' ]
$ ls /home/jorge/projects/ai-factory/spikes/phase0/out/headers-codex-auto.jsonl  -> No such file or directory
```
(`s6-probe.mjs` lists `/home/jorge/projects/ai-factory/spikes/phase0/.agent/sessions/`; the newest file is this run's session. The log file is deleted at probe start and only created on the first hook call.) `after_provider_response` fired zero times across all provider turns, in both `auto` runs (the first run likewise produced no header log). Prompt 2 crossed a tool boundary (`tool_execution_start`). With `auto` the provider used WebSocket first, where the hook is not called.

Forced `sse` (settings.json changed with a node one-liner adding `"transport": "sse"` after copying the original aside; original copied back after the run, then `grep -c transport .agent/settings.json` -> `0`):
```
$ cd /tmp && node /home/jorge/projects/ai-factory/spikes/phase0/s6-probe.mjs codex-sse openai-codex/gpt-6.1-sol </dev/null > /home/jorge/projects/ai-factory/spikes/phase0/out/s6-codex-sse-driver.txt 2>&1; echo exit=$?
exit=0
--- prompt 1 settled / evt tool_execution_start / --- prompt 2 settled / --- prompt 3 settled
sessions dir exists: true [ '2026-10-31T16-33-28-431Z_01a192cf-...jsonl', '2026-10-31T16-36-09-691Z_01a192d1-...jsonl', '2026-10-31T17-41-48-095Z_01a1930d-...jsonl',
  '2026-10-31T17-44-34-151Z_01a19310-...jsonl', '2026-10-31T17-47-20-223Z_01a19312-b91d-7636-9b83-b156e40bf33f.jsonl' ]
$ wc -l /home/jorge/projects/ai-factory/spikes/phase0/out/headers-codex-sse.jsonl -> 4
```
(This is the second sse run, with the widened filter; the first sse run had the same exit code and header names.) The hook fired 4 times (3 prompts, 4 provider turns), always `status` 200, same header set each time. Rate/usage-related header names: `x-codex-active-limit`, `x-codex-plan-type`, `x-codex-credits-balance`, `x-codex-credits-has-credits`, `x-codex-credits-unlimited`, `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-after-seconds`, `x-codex-primary-reset-at`, `x-codex-primary-over-secondary-limit-percent`, `x-codex-secondary-used-percent`, `x-codex-secondary-window-minutes`, `x-codex-secondary-reset-after-seconds`, `x-codex-secondary-reset-at` (plus non-limit names such as `x-codex-turn-state`, `x-codex-safety-buffering-*`, `x-models-etag`, `x-oai-request-id`, `set-cookie`, whose values are not logged). Values from the last call:
```
active-limit premium; plan-type plus; credits-balance 0; has-credits False; unlimited False
primary:   used-percent 0,  window-minutes 300 (5h),   reset-after-seconds 17563
secondary: used-percent 75, window-minutes 10080 (7d), reset-after-seconds 322117
primary-over-secondary-limit-percent 0
```
Values are fresh on every call (reset-after counts down by ~2 s per call). Probe fix: the first sse run logged `rateLimit: {}` because the original filter regex (`ratelimit|rate-limit|retry-after|usage|quota`) does not match Codex's `x-codex-*-used-percent`; `gate-probe.ts` now also matches `^x-codex-(active-limit|plan-type|primary|secondary|credits)`, and the sse run was repeated once (the values above are from the second run; the header names were identical in the first).

**Verdict (bridge):** `known` (observed): `after_provider_response` receives `anthropic-ratelimit-unified-*` headers on the bridge, including 5h and 7d utilization (fraction) and reset epochs, status always 200; exhaustion is `unified-status: rejected` plus an error message prefixed "Claude quota exceeded — rate limit".

**Verdict (Codex):** `known` (observed) only with `transport: "sse"`: per-call `x-codex-primary-*` (5h window) and `x-codex-secondary-*` (7d window) used-percent, window minutes and reset times, plus plan type and credits flags. With the default `auto` transport it is `not observed` when WebSocket was used (the hook never fired in two 3-prompt runs; the source calls `onResponse` only on the SSE path) and would be available only if `auto` falls back to SSE; force `sse` for predictable signals. Exhaustion signal (desk check, not live-tested): HTTP 429 on SSE reaching the hook with its real status, and an assistant message with `stopReason: "error"` whose text reads "You have hit your ChatGPT usage limit".

**Design impact:** A quota-aware scheduler can read 5h/7d utilization from the bridge via `after_provider_response` without extra calls, but must treat it as best effort (one event per query, may lag, no per-call guarantee), and must detect exhaustion from the header status or the error message, not the HTTP status. For Codex, header-based budgeting works per call but ONLY if the Factory forces `transport: "sse"` in the agent dir settings (the default `auto` never fires the hook); the Factory-provisioned settings must set it and a doctor check should assert it. Without it, rely on error-message detection (`stopReason: "error"` plus `/usage limit|rate limit|quota/i`). Cost of forcing SSE (vs WebSocket latency/reuse) was not measured.

## S7 RPC subagent

**Question:** Can a Factory "subagent" be a child Pi process driven over RPC with `RpcClient`, using native Codex, running inside a git worktree, with our extension hooks (tool logging and prompt section) active and the isolated env applied?

**Method:** Pi 1.4.0, Node as installed on the host, model `openai-codex/gpt-6.1-sol` (catalog id), default transport `auto`. `RpcClient` is exported from the package root (`dist/index.js`, imported from `.prefix`). Its `start()` runs `spawn("node", [cliPath, "--mode","rpc", "--model", ..., ...args], { cwd, env: {...process.env, ...options.env} })`, so `cliPath` = absolute `pi.mjs` works; `pi.mjs` in CLI mode sets `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` and `npm_config_prefix` itself inside the child process (RpcClient only passes extra env: `SPIKE_TOOLLOG`, `SPIKE_INVENTORY`). Isolation was confirmed indirectly: the Codex login exists only in `spikes/phase0/.agent`, and the run authenticated. Script: `spikes/phase0/rpc-subagent.mjs` (`promptAndWait` waits for `agent_settled`; `final` from `getLastAssistantText`, `usage` from `getSessionStats`). Prompt: `Read README.md if it exists, otherwise list the files, and summarize in one sentence.` Single run, no retries (re-run once after fix round 1 added the per-run nonce; the evidence below is from that run).

```
git worktree add ../ai-factory-spike-wt -b spike/wt master
rm -f spikes/phase0/out/s7-*            # fresh state; the script also generates a per-run nonce (s7-<nonce>-tools.jsonl) and deletes its targets first
node spikes/phase0/rpc-subagent.mjs ../ai-factory-spike-wt openai-codex/gpt-6.1-sol > spikes/phase0/out/s7-run.txt 2> spikes/phase0/out/s7-err.txt
echo exit=$?                            # exit=0, stderr empty
git worktree remove ../ai-factory-spike-wt && git branch -D spike/wt
git worktree list                       # only the main checkout
```

**Evidence:** exit code 0, stderr empty. Printed result (usage trimmed to the relevant fields):
```
"nonce": "dc24efc9",
"toolLog": ".../spikes/phase0/out/s7-dc24efc9-tools.jsonl",
"final": "No `README.md` exists; this directory contains `docs/`, `spikes/`, `.github/`, and `.git/`. PINEAPPLE",
"toolCalls": [ { "name": "bash", "args": { "command": "if [ -f README.md ]; then printf 'README_EXISTS\\n'; else ls -a; fi", "timeout": null } } ],
"durationMs": 4711,
"usage": { "userMessages": 1, "assistantMessages": 2, "toolCalls": 1, "toolResults": 1,
  "tokens": { "input": 1728, "output": 77, "cacheRead": 1408, "cacheWrite": 0, "total": 3213 }, "cost": 0.00437,
  "contextUsage": { "tokens": 1635, "contextWindow": 500000, "percent": 0.327 } }
```
Child hook log `spikes/phase0/out/s7-dc24efc9-tools.jsonl` (exit=0, stderr empty; usage and duration figures below are from the first run, the re-run printed the same shape):
```
{"event":"tool_call","toolName":"bash","inputKeys":["command"],"decision":"allowed", ...}
{"event":"tool_execution_end","toolName":"bash","isError":false,"textHead":".\n..\ndocs\n.git\n.github\nspikes\n"}
```
Child cwd was the worktree: the `ls -a` output lists only tracked content (`docs`, `.github`, `spikes`) plus `.git` (a file in a worktree); the main checkout additionally holds untracked/ignored dirs (e.g. `.superpowers`) that did not appear. The worktree has no `README.md` (expected; the prompt's fallback branch ran). Cleanup: worktree removed, branch `spike/wt` deleted, `git worktree list` shows only the main checkout.

**Verdict:** `known` (observed). A child Pi over RPC with `RpcClient`, native Codex, cwd in a worktree works end to end: the `spike-role` prompt section applied (`final` ends with PINEAPPLE), the extension's `tool_call` and `tool_execution_end` hooks fired in the child and wrote to the log named by the env var passed through RpcClient, and per-session `usage` (tokens, cost, context) is retrievable via `get_session_stats`. Not tested: abort/steering, concurrent children, Windows (RpcClient hardcodes `spawn("node", ...)`, no `detached`/process-group, so tree teardown on stop is not guaranteed).

**Design impact:** The Factory subagent runner can be a thin wrapper on `RpcClient` with `cliPath` = the isolating launcher, `cwd` = the worktree, per-task env for hook logs, and `--no-session`; gates and prompt sections defined in extensions apply to subagents without extra wiring. Tool calls should be taken from `tool_execution_start` events (or the hook log), final text from `getLastAssistantText`, cost from `getSessionStats`. Because RpcClient neither detaches nor kills the process tree, the Factory should wrap lifecycle itself (timeouts, tree kill) as in the earlier timeout/orphan proofs. Each run took about 4.7 s for a one-tool prompt.

## S8 input/steering lifecycle

**Question:** TBD

**Method:** TBD

**Evidence:** TBD

**Verdict:** TBD

**Design impact:** TBD

## S9 Codex CLI hooks (desk check)

**Question:** The design (§7.5) has a `[verify]` marker: what hook mechanism does Codex CLI offer for enforcing the factory's hard gates (deny destructive commands, block publish/remote mutation, protect secrets, restrict writes to the worktree) from a future Codex adapter? Concretely: (a) is there a PreToolUse-style hook that can deny a call before execution, (b) which approval policies and sandbox modes exist and can an external program answer approvals, (c) is there a command allow/deny rules mechanism.

**Method:** Desk check, no model call (owner quota exhausted at the time; a partial live smoke was added afterwards, see the end of this section). Inspected the local CLI help and feature flags, generated the app-server JSON Schema into `spikes/phase0/out/s9-schema/` (git-ignored), read the Rust sources at tag `rust-v0.163.0` (`openai/codex`) via `gh api`, read the current official docs (the `developers.openai.com/codex/*` URLs 308-redirect to `learn.chatgpt.com/docs/*`), and ran `codex execpolicy check` (pure local rules evaluation, no model) against a scratch rules file. Version caveat: the binary at `~/.local/bin/codex` now reports `codex-cli 0.166.0` (the standalone install self-updated; the brief said 0.163.0). Source-level claims are pinned to `rust-v0.163.0`; CLI/schema output and docs pages are 0.166.0/current. Anything that differs is flagged below.

**Evidence:**

1. Version and hooks feature flag
```
$ codex --version        -> codex-cli 0.166.0
$ codex features list | grep -E '^(hooks|guardian_approval|plugin_hooks|request_rule)'
hooks              stable   true
guardian_approval  stable   true
plugin_hooks       removed  false
request_rule       removed  false
$ codex exec --help | grep -n hook
--dangerously-bypass-hook-trust   Run enabled hooks without requiring persisted hook trust ...
```

2. Hook system exists and is a PreToolUse-style gate. Docs (https://learn.chatgpt.com/docs/hooks, fetched 2026-10-31):
- Config: `hooks.json` or `[hooks]` tables in `config.toml`, at `~/.codex/` and `<repo>/.codex/` (project layer only when trusted); plugins; managed `requirements.toml`.
- Events: `SessionStart, SessionEnd, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt`.
- Handler types that run: `command`, `mcp_tool` (`prompt`/`agent` parsed but skipped).
- Config shape: `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"...","timeout":30}]}]}}`; TOML: `[[hooks.PreToolUse]]` + `[[hooks.PreToolUse.hooks]]`. `matcher` is a regex on tool name (`Bash`, `^apply_patch$`, `Edit|Write`, `mcp__fs__.*`).
- Input on stdin: `session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id, tool_name, tool_use_id, tool_input` (`tool_input.command` for Bash/apply_patch).
- Covered tools: shell (`Bash`), `exec_command`, `apply_patch` (matchable as `apply_patch`/`Edit`/`Write`), MCP tools, other local function tools. Not covered: hosted tools (`WebSearch`). `write_stdin` does not re-trigger PreToolUse.
- Docs' own caveat: "Treat tool hooks as a useful guardrail, not a complete enforcement boundary."

3. Deny semantics confirmed in source at `rust-v0.163.0`:
- `codex-rs/hooks/src/events/pre_tool_use.rs`: exit code 2 with non-empty stderr -> `should_block` (L264-L273 region: `Some(2) if handler.can_apply_control_effects()`); exit 2 with empty stderr -> hook marked Failed, NOT blocked (L274); any other non-zero exit, or a crash/timeout -> `HookRunStatus::Failed` (L278-L282), i.e. the call proceeds (fail-open).
- Same file, tests: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"do not run that"}}` -> blocked (L357-L372); legacy `{"decision":"block","reason":...}` -> blocked (L485-L500); `permissionDecision:"ask"` -> "unsupported", `should_block:false` (fails open) (L556-L581).
- `codex-rs/hooks/src/engine/output_parser.rs`: unsupported `continue:false`, `stopReason`, `suppressOutput` (L369-L375), `permissionDecision:allow` without `updatedInput` and `ask` (L454-L459), `deny` without a non-empty reason (L510). All invalid output = hook failed = call continues.
- Multiple matching hooks run concurrently; any block wins (`results.iter().any(...)`, L115).
Source: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/events/pre_tool_use.rs and `.../engine/output_parser.rs`.

4. Trust: non-managed hooks must be reviewed/trusted (hash-bound; `/hooks` in TUI); `--dangerously-bypass-hook-trust` skips it for a run; hooks can be turned off with `[features] hooks = false`; managed hooks (`requirements.toml`, `managed_dir`) are trusted by policy and cannot be disabled by users. A project-local `.codex/hooks.json` is ignored unless the project layer is trusted. Consequence: a factory-provisioned hook is not active until trusted, so the adapter must pre-trust/manage it or fail closed when it is not loaded.

5. Approval policy and sandbox values (app-server schema generated by the local binary, `codex app-server generate-json-schema --out spikes/phase0/out/s9-schema`, 0.166.0; `AskForApproval` also defined at `codex-rs/protocol/src/protocol.rs` L1092 in the 0.163.0 tag):
```
AskForApproval: "untrusted" | "on-request" | "never" | {"granular":{sandbox_approval, rules, mcp_elicitations, request_permissions, skill_approval}}
   (legacy alias "on-failure" -> on-request, protocol.rs L1100)
SandboxMode:    "read-only" | "workspace-write" | "danger-full-access"
ApprovalsReviewer: "user" | "auto_review" | "guardian_subagent"(legacy)
SandboxPolicy.type: dangerFullAccess | readOnly | externalSandbox | workspaceWrite(+networkAccess, writable roots, excludeSlashTmp...)
```
Config keys: `approval_policy`, `sandbox_mode`, CLI `-s/--sandbox`, `-c key=val`, `--ask-for-approval` (interactive), `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`. Note the owner's `~/.codex/config.toml` currently sets `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` (structure only inspected): the factory must never rely on user config and must pass explicit overrides.

6. External program answering approvals: the app-server (JSON-RPC over stdio, `codex app-server`) sends server-to-client requests that the client must answer. Generated `ServerRequest.json` methods:
```
item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval,
item/tool/requestUserInput, mcpServer/elicitation/request, item/tool/call,
applyPatchApproval, execCommandApproval (legacy), account/chatgptAuthTokens/refresh, attestation/generate
```
`CommandExecutionRequestApprovalParams` carries `command, cwd, commandActions, reason, networkApprovalContext, proposedExecpolicyAmendment, threadId, turnId, itemId`. Response decisions include `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, and decline/cancel variants. So a factory process acting as app-server client can allow/deny each approval, but ONLY for actions that actually trigger an approval (policy `untrusted`/`on-request`/`granular`). With `approval_policy=never` nothing is asked and the sandbox is the only limit. `codex exec` has no approval callback (non-interactive: it either runs within the sandbox or fails), so approval-brokering requires app-server, not `exec`.

7. Rules (exec policy): docs https://learn.chatgpt.com/docs/agent-configuration/rules (marked experimental). `*.rules` files in `rules/` next to any active config layer (`~/.codex/rules/default.rules`; `<repo>/.codex/rules/` only if project trusted). Starlark `prefix_rule(pattern=[...], decision="allow|prompt|forbidden", justification=, match=[...], not_match=[...])`; pattern elements may be alternatives lists; most restrictive wins (forbidden > prompt > allow). `allow` means "run outside the sandbox without prompting"; `forbidden` blocks without prompting. Wrapper handling per docs: `bash -lc "a && b | c"` is split only if linear plain words; redirections, substitutions, env vars, wildcards or control flow make it one opaque command. Local run (no model):
```
$ codex execpolicy check --rules out/s9-gate.rules -- git push origin main
{"matchedRules":[{"prefixRuleMatch":{"matchedPrefix":["git","push"],"decision":"forbidden","justification":"factory gate: no remote mutation"}}],"decision":"forbidden"}   exit 0
$ codex execpolicy check --rules out/s9-gate.rules -- bash -lc 'git status && git push'
{"matchedRules":[]}
$ codex execpolicy check --rules out/s9-gate.rules -- bash -lc 'echo $(git push)'
{"matchedRules":[]}
$ codex execpolicy check --rules out/s9-gate.rules -- ls
{"matchedRules":[]}
```
Observation: the `check` subcommand evaluates the argv literally (it does not apply the core's shell-wrapper splitting, which happens in the runtime), so it can be used to unit-test rules for plain argv forms only; wrapper behaviour must be taken from the docs, not from `check`. A command with no matching rule yields no decision (falls through to approval policy/sandbox), so rules are a deny-list/escalation list, not a default-deny allow-list.

8. Other: `notify` (config program invoked on events such as turn completion) is notification-only and cannot gate; `sandbox` (`codex sandbox -- <cmd>`) runs a command under the Codex sandbox, useful for tests. `PermissionRequest` hook event exists (hooks can answer approval prompts; `updatedInput`/`updatedPermissions`/`interrupt` unsupported).

**Verdict:** Yes, Codex (hooks stable since before 0.163.0; `hooks` flag default true) has a Claude-Code-like PreToolUse hook: command hook, JSON on stdin, deny via exit 2 + stderr or `permissionDecision:"deny"` with reason, covering shell, apply_patch, MCP and function tools. It is explicitly a guardrail, not a boundary, and fails open on hook errors, bad output, timeouts, unsupported `ask`, untrusted or unloaded hooks, and uncovered tools (hosted `WebSearch`, `write_stdin` continuation). Recommended layering for the Codex adapter, from strongest to weakest:
1. Sandbox (OS-level, the real boundary): force `sandbox_mode="workspace-write"` with the worktree as the writable root and network off; this is what enforces "restrict writes to the worktree" and blocks remote mutation by network when networking is disabled. Pass via explicit `-c`/`-s` flags, never inherit user config (the owner's is `never` + `danger-full-access`).
2. `.rules` forbidden/prompt rules for destructive and publish commands (`rm -rf`, `git push`, `gh pr create`, `npm publish`, ...): cheap, declarative, Codex-native, evaluated before escalation. Limited to prefix matching and only on commands that would leave the sandbox or be approved.
3. Managed PreToolUse hook (command) that calls the factory's GatePolicy evaluator: needed for what prefix rules cannot express (secret-path reads, apply_patch target paths outside the worktree, MCP tool deny-lists, shell-wrapper content). Install via managed config/`requirements.toml` or pre-trusted project hooks; the adapter must verify the hook is loaded and trusted (e.g. via the app-server hooks-list request (method name not verified; schema types `HooksListEntry`, `HookTrustStatus`) and refuse to start the run otherwise (fail closed at the launcher, since the hook itself fails open).
4. App-server approval broker (optional): run Codex through `codex app-server` with `approval_policy="on-request"` or `granular`, and answer `requestApproval` requests from GatePolicy. This is the only route to a programmatic approve/deny per action; `codex exec` cannot do it.

What it cannot enforce: hosted tools (web search), commands hidden in opaque shell constructs (`bash -lc` with substitutions/redirections are one command to the rules), anything when the user passes `--dangerously-bypass-*` or `approval_policy=never` + `danger-full-access` (owner's current config), reading secrets that the sandbox allows reading (workspace-write permits reads broadly; needs read-only roots or hook path checks), hook crashes/timeouts (fail-open), and edits made by subprocesses of an allowed command that stay inside the sandbox. Hook/rules specifics are documented as experimental/changing, and the local binary already moved 0.163 -> 0.166, so the adapter needs a version-pinned contract test.

**Design impact:** Resolve §7.5 `[verify]` as: Codex adapter = explicit sandbox flags + generated `.rules` + managed PreToolUse hook backed by the shared GatePolicy evaluator, with a launcher preflight that asserts hook loaded/trusted and config not weakened (fail closed). State in §7.5 that Codex gates are defence in depth (guardrail plus sandbox), weaker than Claude Code's, and that hard gates for publishing/remote mutation must additionally rely on the factory refusing to hold credentials/network in the Codex sandbox and on the outward-action confirmation flow. Add an adapter-contract test pinned to the Codex version (rule/hook output shapes changed risk) and make `codex exec` runs rely on sandbox + rules + hook only (no approval broker); use app-server if per-action approval brokering is wanted. Not verified: that a trusted hook denies a live model-issued command end to end (live smoke attempted, see below: positive run PENDING owner action because trusting the hook needs a flag the run was not permitted to use or a write to `~/.codex`), and that `workspace-write` blocks a given path on this host.

### Live smoke (partial: negative control only; positive run PENDING, owner action)

Isolation statement (accurate, not full isolation): the smoke uses the owner's real Codex CLI and real `CODEX_HOME` for authentication only. No config file under `~/.codex` was created or modified by me. `--ephemeral` only avoids session persistence; Codex may still write its own logs/state under `CODEX_HOME`. The explicit `-s workspace-write` and `-c approval_policy=never` flags override the owner's `config.toml` defaults (`never` + `danger-full-access`) for the run. The hook under test is project-local (in the throwaway repo). A throwaway `CODEX_HOME` was rejected because it would need a copy of the owner's credentials.

Negative control (done): fresh `mktemp -d` dir (`/tmp/tmp.6dcG4S5WYp`), `git init`, `.codex/hooks.json` with a `PreToolUse` matcher `Bash` command hook (`.codex/deny-hook.sh`: appends a line to `hook.log`, exits 2 with stderr `spike gate` when stdin contains `spike-deny`):
```
codex exec -m gpt-6.1-sol -s workspace-write -c approval_policy=never --ephemeral --cd $D "Run the shell command: echo spike-deny > denied.txt" </dev/null   # exit=0
```
Banner: `approval: never`, `sandbox: workspace-write`. Result: the model ran `zsh -lc 'echo spike-deny > denied.txt'`, `succeeded`, `denied.txt` was created and `hook.log` does not exist: the untrusted project-local hook was NOT loaded (S9 item 4). This confirms the fail-open consequence of an untrusted hook.

Positive run: PENDING (owner action). Activating the hook needs `--dangerously-bypass-hook-trust` (the run was denied by the session permission classifier and not worked around) or persisting trust, which writes under `~/.codex` (not allowed here). Owner command sequence (copy-paste):
```
D=$(mktemp -d) && cd "$D" && git init -q . && mkdir .codex
cat > .codex/deny-hook.sh <<'EOF'
#!/bin/bash
IN=$(cat)
echo "$(date +%s) invoked: $(echo "$IN" | tr -d '\n' | head -c 300)" >> "$(dirname "$0")/../hook.log"
if echo "$IN" | grep -q 'spike-deny'; then echo "spike gate" >&2; exit 2; fi
exit 0
EOF
chmod +x .codex/deny-hook.sh
cat > .codex/hooks.json <<EOF2
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$D/.codex/deny-hook.sh","timeout":10}]}]}}
EOF2
codex exec -m gpt-6.1-sol -s workspace-write -c approval_policy=never --ephemeral --dangerously-bypass-hook-trust --cd "$D" "Run the shell command: echo spike-deny > denied.txt" </dev/null; echo exit=$?
ls -A "$D"; cat "$D/hook.log"
```
Expected evidence: `hook.log` exists with at least one `invoked:` line containing `spike-deny`; the transcript shows the command blocked ("spike gate" / hook denial) rather than `succeeded`; `denied.txt` is absent from `ls -A`. If `hook.log` is missing, the hook did not load (check `codex features list | grep hooks` and the `matcher` tool name).

## S10 Windows

**Question:** Do the S1 probe, the isolated Pi install, install-by-tag with marker, the persistent CLI install and the one-command bootstrap work on Windows (Git Bash) as on Linux, on Node 22.19.0 and 24, and what does the install cost in time?

### CI matrix

**Method:** `.github/workflows/spike-phase0.yml` (`workflow_dispatch` only; owner-approved push to `jrevenga/ai-factory` master, 2026-10-31), matrix `os: [ubuntu-latest, windows-latest]` x `node: ["22.19.0", "24"]`, `fail-fast: false`, `shell: bash` (Git Bash on Windows), `permissions: contents: read`, git `insteadOf` rewrite with `github.token` for `https://github.com/`, `ssh://git@github.com/` and `git@github.com:` (token never printed). Each job runs `node spikes/phase0/ci-checks.mjs`, which runs in order: `sqlite-fts.mjs` (S1), the isolated Pi 1.4.0 install into `spikes/phase0/.prefix`, `s2-probe.mjs load` (install by tag `spike-pkg-v0.1.0` and marker with fresh nonce), `npm install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0` into an empty prefix and run of the executable in a new process (POSIX `<prefix>/bin/factory-spike`; Windows `<prefix>/factory-spike.cmd` via `cmd.exe /d /s /c`), and `npx -y github:jrevenga/ai-factory#spike-pkg-v0.1.0 install` from an empty prefix followed by running the executable in a new process. `npm_config_update_notifier=false`.

**Evidence:** Run https://github.com/jrevenga/ai-factory/actions/runs/41219133823 (commit `b908165`), first attempt, no re-runs. All four jobs concluded `success`; every check in every job had `ok: true`. Runner Node: 22.19.0 and 24.22.1.

| Job | Node | S1 | Pi install | install-by-tag + marker | CLI install + run | Bootstrap | totalMs |
|---|---|---|---|---|---|---|---|
| ubuntu-latest | 22.19.0 | ok 32 ms | ok 11.3 s | ok 2.7 s | ok 12.5 s | ok 19.6 s | 46179 |
| ubuntu-latest | 24.22.1 | ok 149 ms | ok 11.4 s | ok 2.6 s | ok 12.2 s | ok 18.0 s | 44250 |
| windows-latest | 22.19.0 | ok 48 ms | ok 17.8 s | ok 4.0 s | ok 20.5 s | ok 35.8 s | 78113 |
| windows-latest | 24.22.1 | ok 223 ms | ok 28.2 s | ok 4.0 s | ok 28.2 s | ok 50.7 s | 111347 |

Windows specifics observed in the logs: the executable was `D:\a\ai-factory\ai-factory\spikes\phase0\.npm-global-ci-cli\factory-spike.cmd` (directly in the prefix, as predicted) and printed `factory-spike ok v22.19.0` (exit 0) in a new process; the bootstrap prefix behaved the same. The spike package's `install` branch (npm resolved relative to `process.execPath`) and `npm.mjs` (`<node-dir>/node_modules/npm/bin/npm-cli.js` on Windows) both worked with `actions/setup-node` Node. The `install-by-tag` check asserted the marker with this run's nonce (not just exit code). The private-repo access went through the `insteadOf` token rewrite for both the `git+https` install and the `github:` shorthand (no SSH fallback issue appeared). S1 on Windows: `node:sqlite` FTS5 and accent folding true (SQLite 3.53.4, no warning on Node 24; Node 22.19.0 results in the CI JSON).

**Genuine platform findings:** none failed. Windows is roughly 1.7x (Node 22) to 2.5x (Node 24) slower than Linux for the same install work.

**Harness bugs fixed:** none (no failing attempt; no fix commits).

**Install-time input (< 10 min target):** the full five-check sequence, which includes a duplicate Pi install and two package installs, takes at most 111 s on a clean Windows runner and 46 s on Linux; the bootstrap alone is 18-20 s (Linux) and 36-51 s (Windows). Caveat: CI runners have fast networks, warm npm mirrors and no antivirus beyond Defender defaults; the owner's machine may differ.

**Limits:** CI proves install/CLI/marker behaviour and the `.cmd` shim on Windows; it does not cover login, Codex, the bridge, worktrees or Pi's `bash` tool via Git Bash (no credentials on runners). Those are the owner checklist below.

### Owner Windows checklist - pending

Not yet run. Checklist: `spikes/phase0/windows-checklist.md`. Results (outputs per item, bridge-on-Windows status) will be pasted here.

**Verdict:** TBD (CI portion passes; final verdict after the owner checklist).

**Design impact:** TBD (after the owner checklist).
