# ai-factory

An AI software factory for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): a Pi package plus the `factory` command line tool that installs, checks, updates and rolls back a pinned, reproducible setup.

## Requirements

The factory does not install or configure these:

- Node.js 22.19.0 or newer, with npm (`node:sqlite` with FTS5 must work; `factory doctor` checks it).
- Git (on Windows, Git for Windows, which provides Git Bash).
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

`factory install [--yes] [--profile <name>]` checks the requirements, installs the pinned Pi, the factory Pi package and, when Claude is available, `pi-claude-bridge`, writes the managed Pi settings and a guard extension, creates `~/.factory/config.json` from a profile (`claude-codex` or `codex-only`, proposed from your logins) and runs `factory doctor`.

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

## Development

```sh
npm ci
npm run lint
npm test
npm run test:e2e
npx vitest run test/e2e/roundtrip.e2e.test.ts
```

The last command is the install and update/rollback round-trip (CI workflow `e2e`). It builds its releases from the committed `HEAD`, so commit your changes before running it.
