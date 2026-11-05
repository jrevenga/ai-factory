# Changelog

## [0.2.0] - unreleased

- Hard gates in the Pi `tool_call` hook: command classification, secret and outside-root paths, destructive, remote-mutating and integration operations; ask with a timed human confirmation, deny without a UI.
- Route state with write roots per route, `.factory/` rules and machine-owned blocks; `set_route` and `task_progress` tools.
- Answer route that runs read tools, read-only commands and allowlisted runners, and reverts tracked-file changes that runners make (copies are kept in the run's `after/` directory).
- Per-run ledger of gate decisions, checks, checkpoints and reconciliations, with secret redaction.
- Task state and checkpoint commits on `factory/<taskId>`; an undo point for small changes.
- Evidence: `run_check` records check results, `record_decision` and `record_review` store decisions, and delivery validation rejects stale checks.
- Resume of interrupted runs: unfinished answer-route reconciliations are replayed at startup and the route is reclassified.

## [0.1.0] - 2026-11-05

- Toolchain, layer lint and CI for a TypeScript Pi package plus `factory` CLI.
- Platform adapter: bounded process runner, cmd quoting, npm resolution, paths, atomic JSON.
- Layered configuration with provenance, locked keys and profiles.
- Release manifest, changelog parsing and manifest check.
