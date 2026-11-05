# ai-factory

An AI software factory for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): a Pi package plus the `factory` command line tool that installs, checks, updates and rolls back a pinned setup.

## Requirements

The factory does not install or configure these:

- Node.js 22.19.0 or newer, with npm (`node:sqlite` with FTS5 must work; `factory doctor` checks it).
- Git 2.26 or newer (on Windows, Git for Windows, which provides Git Bash).
- Git access to this repository.
- A provider login, done by you: Claude Code `/login` for the Claude profile, or Pi `/login` with ChatGPT for Codex.
- An npm global prefix you can write to. No sudo or administrator rights are needed for anything the factory does.

Pi itself is not a requirement: `factory install` installs the exact Pi version the release pins, under `~/.factory/pi/<version>/`, without replacing a `pi` you already have.

## Install

One command (replace `vX.Y.Z` with a release tag):

```sh
npx -y git+https://github.com/jrevenga/ai-factory.git#vX.Y.Z install
```

It installs the `factory` CLI globally with npm and continues with `factory install`.

Fallback, in two steps:

```sh
npm install -g --legacy-peer-deps git+https://github.com/jrevenga/ai-factory.git#vX.Y.Z
factory install
```

`factory install [--yes] [--profile <name>]` checks the requirements, installs the pinned Pi, the factory Pi package and, when Claude is available, `pi-claude-bridge`, writes the managed Pi settings and a guard extension, creates `~/.factory/config.json` from a profile (`claude-codex` or `codex-only`, proposed from your logins) and runs `factory doctor`. In a terminal it shows the proposed profile and asks before using it, unless you pass `--yes` or choose one with `--profile`. It refuses to replace an installed factory that is newer than the release it installs; use `factory rollback <version>` for that.

## Usage

| Command | What it does |
| --- | --- |
| `factory` | Runs a fast offline check, then starts the pinned Pi with the factory. Options (and everything after `--`) are passed to Pi. |
| `factory doctor [--offline] [--json]` | Checks the installation and prints the exact fix for every problem. |
| `factory update [--to vX.Y.Z] [--yes]` | Shows the changelog, snapshots your state and moves to a newer release (default: the newest). |
| `factory rollback [X.Y.Z] [--yes]` | Returns to an earlier release (default: the previous one). Data written since is kept when the state schemas are compatible; otherwise the command lists what is lost and asks first. It also recovers an update that did not finish. |
| `factory init [--yes]` | Creates the `.factory/` skeleton in the current git repository; never overwrites a file. |
| `factory config explain <key>` | Shows a setting's effective value and which layer it comes from. |
| `factory version` | Prints the installed factory version. |

Update and rollback refuse to run while a factory-launched Pi session is open. Every update and rollback keeps an immutable snapshot under `~/.factory/backups/`.

### When the factory lock stays in use

`install`, `update` and `rollback` start npm and Pi in their own process groups and record each group under `~/.factory/factory.lock.writers/`. If a factory command was killed while one of them ran, the lock stays unavailable while that group lives, and the next command refuses with a message that names the group and its record. The factory stops such a group by itself only when it can verify that the group is its own (on Linux, through an identity token in the group's environment; on other POSIX systems it assumes a recorded group is its own). Otherwise recovery is manual:

1. Inspect the group: `ps -o pid,pgid,args -g <group>`.
2. If it is a factory npm or Pi process, let it finish or stop it with `kill -TERM -- -<group>`.
3. If it is not (its id was reused by another program), remove its record `~/.factory/factory.lock.writers/<group>`.

Then run the command again.

## Guardrails

Without containers there is no real sandbox. The factory has guardrails that protect against agent mistakes, not against a determined malicious payload (design spec §11). This section lists what is enforced and, as completely as we know it, what is not.

### What is enforced

Enforcement happens in the factory's Pi extension, in the `tool_call` hook of every tool call (nested calls included), and every decision is written to the run ledger.

- **Command classes.** Every shell command is parsed conservatively and classified (read-only, local write, allowlisted runner, unknown, and so on). Anything the parser rejects or does not recognise is `unknown`.
- **Hard gates.** These ask for a human decision whatever the autonomy level or project config, and are never relaxed by a layer: reading or writing secrets, writing outside the project root or task worktree, destructive operations, mutating remote state, and integrating into your branch. Secret paths include `.env*`, `.npmrc`, `~/.ssh`, `~/.aws`, `~/.pi/agent/auth.json`, `~/.codex/auth.json` and other credential stores.
- **Ask and deny.** An `ask` shows a confirm dialog with a fixed 120 s timeout; an unanswered dialog denies. Without a UI (print mode, unattended runs) an `ask` is a deny.
- **Routes.** Each task has a route that sets the write roots. `.factory/` rules and machine-owned blocks (written only by the factory's tools) are protected from direct edits, and a failed handshake blocks work in a session where the gates are not loaded.
- **Answer route (temporary narrowing, until Phase 4).** On the answer route only read tools, read-only commands and allowlisted runners (tests, builds, linters) run. `write`/`edit` are denied, and every other command is denied. Allowlisted runners run with tracked-file reconciliation: before the call the factory snapshots the work tree, and afterwards it reverts changed tracked files and pre-existing untracked files, moves new untracked files aside and restores the index. This includes edits you made yourself to those files while the runner was running. Every replaced file is kept under `~/.factory/runs/<projectId>/<runId>/reconcile/<toolCallId>/after/` and named in the tool result, so nothing is lost but you must recover your edit from there. Git-ignored outputs (such as `dist/`) are kept. A phase-4 exploration worktree will remove this limitation; until then, investigation commands that cannot be reconciled need a change route.
- **Task checkpoints.** `task_progress` commits the task's work to `factory/<taskId>` (and takes a stash-based undo point for small changes), with git hooks and `core.fsmonitor` disabled and changed secret files never staged.
- **Run ledger and resume.** Each run has a redacted ledger under `~/.factory/runs/`. After a hard kill, the next Pi start reports the interrupted run, replays its unfinished answer-route reconciliations and requires a fresh `set_route` before changes.
- **Evidence.** `run_check` runs project commands (declared in `.factory/config.json` or allowlisted) with a redacted, capped log and a working-tree fingerprint; delivery validation rejects checks taken on stale content.

### What is not enforced (known residual risks)

These are accepted limits of the current release. Where it says "asks", the command is not run silently: you can see it and approve or reject it.

#### Command classification

- Anything the conservative parser does not recognise asks. This costs prompts for some legitimate commands: arguments containing `!`, `~`, globs or `{}` (for example `git log --grep='fix!'`), options valid only in BSD/macOS tools, path-like words that are not files (sed scripts, refs such as `origin/main`), and a later write target that does not exist yet after a mutating segment (`mkdir -p dist && cp a dist/a`).
- Options that name files to read are conservatively `unknown` (`--files0-from`, `date -f`, `file -m`, `git blame --contents`, `git diff --no-index`), and git options honoured anywhere in the argv (`--no-index`, `--end-of-options`, global pathspec options) make a command `unknown` even when git would read them as a plain argument (for example a commit message spelled `--no-index`). A bare `git fetch <name>` is taken by git as a local path when `<name>` is not a remote, and the classifier only notices a directory of that name, not a bundle file, a gitfile or a `<name>.git` directory.
- Recursive `cp` of a directory, `eslint --fix <dir>` and `prettier --write <dir>` ask. Recursive `grep -r` and `rg` ask on change routes and are denied on the answer route.
- Metadata-only dereference and recursion flags (`ls -R/-L/-H`, `find -L`, `du -L`, `stat -L`, `file -L`, `fd -L`, `tree -l`) are allowed: they can disclose names, sizes, types and link targets outside the project, not contents.
- `git config --get-regexp` and `--list` can print credentials embedded in remote URLs; `.git/config` is not a secret path.
- `curl` and `wget` still read their user config (`~/.curlrc`, `~/.wgetrc`, and `~/.netrc` for wget); those files are trusted.
- Allowlisted runners and declared project commands execute project code and project config, so their arguments are not path-checked: `tsc --outDir ../x`, `eslint -c ../evil.js`, `vitest --config`, `tsc -p`/`-b` writing where the config says, `pytest <dir outside the root>` writing `.pytest_cache` there, and a postinstall script of an allowlisted package manager. They stay subject to the hard gates.
- Git staging is allowlisted only for explicit files. `git add -A/-u/.`, directories, `git commit -a` and `git stash -u` ask. `git commit -m` still commits whatever you had already staged, and `git stash push` without `-u` stores modified tracked files, secret ones included, in git objects.
- `integration` has no classifier in this release: `git merge`, `git cherry-pick` and similar are unclassified and ask, without the hard-gate label.
- On Windows, a path with a short 8.3 TEMP or home directory containing `~` (such as `C:/Users/RUNNER~1/...`) cannot be classified, so commands that use it ask. Git Bash `/tmp/...` arguments also fail closed.

#### Secret and path gate

- The grep tool can reach a project-level `.env` that is not gitignored. Recursive searches over your home directory or its secret ancestors (`~`, `~/.config`, `~/.pi`, ...) ask; the `ls` and `find` tools only list names and are exempt.
- The tracked-secret check looks at the current git index only. `git log -p` or `git show <old revision>` can print a secret that was committed earlier and later untracked, unless the command names its path. A secret committed under a neutral name that the repository no longer tracks is not detected, and neither is `git -C ~/.dotfiles show HEAD:.aws/credentials` (another repository holding secrets), nor a symlinked pathspec in `git diff`.
- A `git apply <patch> && cat <existing file>` chain asks rather than denies, because a patch can turn a path into a symlink before the next segment reads it; the dialog shows the full command and unattended runs deny it. `cp -P` of a relative symlink is allowed on its own, and a later read through the copy is gated as a read of its new target.
- After a failed handshake the read tools are not secret-checked.
- Another Pi extension loaded after the factory's can change a tool call's input after the gate allowed it (Pi passes one mutable object to every handler). Another extension can also append a `factory-route` entry that is restored at the next start; it cannot widen the write roots but can drop a stored flag. The factory's own tools are identified by name, not by origin.
- In Pi's default parallel mode a batch containing a mutating call admits only that call, and the model has to re-issue the rest.
- The ledger and check-log redactor knows a fixed set of secret formats; an unknown format is not masked, a key/value pair split across lines can escape, and a long value that starts before a cut can be only partly masked (512-character overlap).

#### Answer-route reconciliation

- Cost: every runner call hashes the tracked files and copies dirty and untracked files. Reconciliation refuses (and the runner is denied) outside a git work tree, beyond 2000 untracked files or 50 MiB of untracked content, or if the snapshot fails.
- Not reverted: writes the runner makes inside `.git` (objects, refs, config, hooks), writes outside the project (temp and others), and anything a background process writes after the call. Symlinks are never followed; submodules, nested repositories and files below a symlink are named in the result but not reconciled. The split index (`sharedindex.*`) is not handled specially.
- Backups under `reconcile/` are never cleaned up automatically. Executable bits are not kept in backups, and on Windows backup permissions are best effort. A backup whose original mode could not be applied (an unreadable file with other hard links) is reported as incomplete.
- Windows `run_check` starts only `.exe`/`.com` programs. `npm`, `npx`, `pnpm`, `yarn` and `.bin` shims are `.cmd` files and are refused; declare the underlying program, for example `node node_modules/vitest/vitest.mjs run`. Programs resolve through PATH only, never the current directory.

#### Checkpoints and evidence

- Checkpoint commits are local undo points, not deliveries: they are unsigned and run with hooks disabled, so a repository that requires signed commits needs re-signing at delivery.
- Changed secret-path files are never committed by checkpoints; they stay uncommitted in the worktree. The small undo point leaves out untracked files. Tracked paths replaced by a directory, and hard-linked task files, are refused or excluded; a tracked `.env` turned into a directory leaves its non-secret children out of checkpoints (fails safe).
- Git filter drivers selected by `.gitattributes` (for example git-lfs) still run during checkpoint staging and the working-tree fingerprint, because only hooks and `core.fsmonitor` are neutralised. Factory git commands resolve `git` only from absolute PATH entries outside the project and fail closed otherwise, but filter drivers inherit a PATH with relative entries; the `bash` tool uses the inherited PATH.
- Checkpoints fail closed while a file with a non-UTF-8 name exists, and `--pathspec-from-file` needs git 2.26 or newer. A narrow check-then-rename race remains and needs a concurrent process to exploit.
- Changed secret-path files in the fingerprint count by content hash only: their blobs are not written to git objects, but tree objects that reference them are, and stay dangling until `git gc`. An already-staged secret blob is not detected.
- A timed-out or cancelled `run_check` kills its process tree, but a process that starts its own session or process group escapes on every OS, and on Windows so do descendants that outlive a normally exited leader. Each check log is capped at 64 MiB.
- Declared commands (`commands.test|build|lint|typecheck`) must be one simple command allowlisted on an exact argv match; an invalid project config disables them and any softened gates for the session.

#### Interrupted runs and replay

- Only a hard kill leaves a run interrupted; a graceful SIGTERM ends the run cleanly. Unfinished reconciliations are retried at later startups, innermost call first, once the session that owns the run's replay is gone (other sessions print "replay in progress elsewhere"; two sessions starting at the same moment may both defer).
- A replay stops at the first manifest that fails. An unreadable manifest, copies without a manifest, an unreadable `reconcile/` directory or an unreadable entry in `replay.owners/` blocks that run's replay until you remove or fix it by hand, after confirming no Pi session is replaying the run. A replay whose work tree is gone is reported once and left as it is.
- A stale `.git/index.lock` is reported ("index not checked") and never removed; remove it only when no git command is running. Stale-lock and pid reuse: on Linux the owner's start time is checked, elsewhere a reused pid blocks a retry until that process exits.
- The resume notice reaches only the next agent run of the continuing session. Interrupted runs of other sessions are reported, and their reconciles replayed, by whichever session of the project starts first.
- A restored route written by an interrupted run is flagged and stays owing a successful `set_route`, across sessions and `/tree` navigation. A run claimed by a factory killed between the claim and `run_interrupted` is never reported.

#### Platform

- Windows has not been exercised on every guardrail path (hard-kill with `taskkill`, session `--continue`, symlink and mode tests); CI is the check.
- The context reminder is sent on every provider call; some providers see consecutive user messages.
- The factory needs git 2.26 or newer.

## Known limitations

- The global `factory` CLI pins its direct dependencies exactly, but npm does not apply a git dependency's lockfile (or `npm-shrinkwrap.json`) on `npm install -g`, so the CLI's transitive dependencies may resolve to newer versions within their declared ranges. Pi and `pi-claude-bridge` are pinned to exact versions, but their transitive dependencies are also resolved at install time; only the factory's Pi package install (in Pi's checkout) follows `package-lock.json`.

## Development

```sh
npm ci
npm run lint
npm test
npm run test:e2e
npx vitest run test/e2e/roundtrip.e2e.test.ts
```

The last command is the install and update/rollback round-trip (CI workflow `e2e`). It builds its releases from the committed `HEAD`, so commit your changes before running it.
