# Phase 0 feasibility spikes

Throwaway probes run against an isolated Pi 1.4.0. They never touch `~/.pi/agent`, the global npm prefix or a user working tree.

## Setup (once)

```bash
npm install --prefix spikes/phase0/.prefix --ignore-scripts @earendil-works/pi-coding-agent@1.4.0
```

This is the only npm command run outside `npm.mjs`.

## Launchers

- `node spikes/phase0/pi.mjs <pi args...>` runs Pi inside the launcher process itself (env hygiene and guards applied, then Pi's JavaScript bin entry is imported; no child process), so killing the launcher kills Pi on every OS. Exit code is passed through. Also usable as `RpcClient`'s `cliPath`.
- `node spikes/phase0/npm.mjs <scenario> <npm|npx> <args...>` runs npm/npx with `npm_config_prefix=.npm-global-<scenario>` and `npm_config_cache=out/npm-cache-<scenario>`.
- Programmatic: `runPi(args, { cwd, env, input, scenario })`, `runNpm(tool, args, { scenario, env })`, and `SPIKE = { root, launcher, agentDir, out }`.

## Isolation rules

- `pi.mjs` forces `PI_CODING_AGENT_DIR=spikes/phase0/.agent[-<scenario>]`, `PI_CODING_AGENT_SESSION_DIR=<agent dir>/sessions` and `npm_config_prefix=spikes/phase0/.npm-global[-<scenario>]`, resolved from the launcher location, and exits 2 if any path is outside `spikes/phase0/` or equals `~/.pi/agent`.
- `ANTHROPIC_*` variables are removed from child environments.
- `.agent*/`, `.prefix/`, `.npm-global*/` and `out/` are git-ignored.
- Never read, print or write any `auth.json`, and never write under `~/.pi`.
- Non-inference probes pass `--model openai-codex/gpt-6.1-sol` and send only `get_state`.
- Use a fresh scenario (own agent dir and prefix) for each failure scenario.

## Owner actions

Outward-facing steps (creating the GitHub repo, pushing, tags, CI runs) are hard gates: ask the owner first. Results are recorded in `docs/superpowers/spikes/2026-10-31-phase0-report.md`.
