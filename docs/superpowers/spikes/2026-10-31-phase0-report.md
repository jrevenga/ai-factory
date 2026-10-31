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

**Method:** Tag `spike-pkg-v0.1.0` (`bin/factory-spike.mjs`; `package.json` has no `scripts`, so no build/prepare step exists to run). Every scenario was reset (`resetScenario`) before its run; npm ran through `spikes/phase0/npm.mjs` (forced prefix `.npm-global-<scenario>`, cache `out/npm-cache-<scenario>`). The executable was then run in a new process (`env -u npm_config_prefix`, cwd `/tmp`) from the POSIX location `<prefix>/bin/factory-spike` (on Windows it would be `<prefix>/factory-spike.cmd`; not tested here, see S10). Node 24.13.1 and the Node 22.19.0 binary (`/home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node`) were both used; under 22.19 the same npm/npx JS entries run with that binary via `spikes/phase0/s3-probe.mjs <scenario> <npm|npx> <node> <args>` (scenarios `cli-n22`, `bootstrap-n22`). Owner's `npm prefix -g` recorded before and after.

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
Step 1, Node 22.19.0 (`cli-n22`):
```
node /home/jorge/projects/ai-factory/spikes/phase0/s3-probe.mjs cli-n22 npm /home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node install -g git+https://github.com/jrevenga/ai-factory.git#spike-pkg-v0.1.0
-> exit=0 durationMs=11015, "added 122 packages in 11s", same warnings
PATH=<node22 dir>:$PATH /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-cli-n22/bin/factory-spike
  factory-spike ok v22.19.0   # exit 0
```
Step 2, Node 24.13.1 (`bootstrap`):
```
npm prefix -g (owner env) before: /home/linuxbrew/.linuxbrew
node /home/jorge/projects/ai-factory/spikes/phase0/npm.mjs bootstrap npx -y github:jrevenga/ai-factory#spike-pkg-v0.1.0 install
-> exit 0, "added 122 packages in 9s" (wall 21.9 s, includes npx's own fetch/install of the package into its cache before running `install`)
ls -la /home/jorge/projects/ai-factory/spikes/phase0/.npm-global-bootstrap/bin
  factory-spike -> ../lib/node_modules/ai-factory-spike/bin/factory-spike.mjs
/home/jorge/projects/ai-factory/spikes/phase0/.npm-global-bootstrap/bin/factory-spike   (new process after npx exited, cwd /tmp)
  factory-spike ok v24.13.1   # exit 0
```
Step 2, Node 22.19.0 (`bootstrap-n22`, npx-cli.js run with the 22.19 binary):
```
node /home/jorge/projects/ai-factory/spikes/phase0/s3-probe.mjs bootstrap-n22 npx /home/jorge/projects/ai-factory/spikes/phase0/out/node22/node_modules/node/bin/node -y github:jrevenga/ai-factory#spike-pkg-v0.1.0 install
-> exit=0 durationMs=21395, "added 122 packages in 9s"
/home/jorge/projects/ai-factory/spikes/phase0/.npm-global-bootstrap-n22/bin/factory-spike -> factory-spike ok v22.19.0   # exit 0
```
Owner environment after all runs: `npm prefix -g` = `/home/linuxbrew/.linuxbrew` (unchanged); `ls /home/linuxbrew/.linuxbrew/bin | grep -c factory-spike` = 0.

**Verdict:** Both paths work on Linux with Node 24.13.1 and 22.19.0 using the owner's git credential helper. The one-command bootstrap works reliably in this run: the persistent executable exists after npx exits (it is a symlink into the global prefix's `lib/node_modules`, not into the npx cache) and runs. Cost: ~22 s versus ~11 s for the direct install, because npx first installs the package into its cache and then the `install` subcommand does a second `npm install -g` (including the ~122 packages for Pi as a peer dependency). No build/prepare step ran (none declared). Caveat: a single run per Node version, Linux only, and the self-install depends on `install` inheriting `npm_config_prefix`; on a real machine it uses the user's configured global prefix, which must be writable without sudo.

**Design impact:** Task 11 can offer the one-command bootstrap (`npx -y github:jrevenga/ai-factory#<tag> install`) as the documented entry point, with `npm install -g git+https://github.com/jrevenga/ai-factory.git#<tag>` as the equivalent two-step fallback (and `factory install` when the CLI already exists). Keep the fallback because npx bootstrap doubles the install time and hides npm errors behind npx; `doctor` should print the `npm prefix -g` writability check and the Windows location (`<prefix>/factory.cmd` style, to be confirmed in S10).

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
