# Windows owner checklist (S10)

Prerequisites: a Windows machine with Git for Windows (Git Bash) and Node >= 22.19. Run everything in Git Bash. Paste each output into report S10 (`docs/superpowers/spikes/2026-10-31-phase0-report.md`). Do not paste tokens or `auth.json` contents.

1. Clone the repo (private; use your GitHub credentials) and install the isolated Pi:
   `npm install --prefix spikes/phase0/.prefix --ignore-scripts @earendil-works/pi-coding-agent@1.4.0`
   Clone into a path that contains a space (for example under your user profile, `C:\Users\<First Last>\...`, or a folder such as `ai factory`); CI only proves the space case if the owner-approved run with the updated workflow passes, so this local run is the real-machine check. Record the checkout path.
2. `node spikes/phase0/ci-checks.mjs` - record the JSON summary and exit code. In the `cli-install-run` and `bootstrap-empty-prefix` details, confirm the `factory-spike.cmd` path contains the space and the run printed `factory-spike ok v...`.
3. `node spikes/phase0/pi.mjs`, then `/login` with ChatGPT (Codex subscription).
4. Task 5 Steps 3-4 and 6 (Codex gate and prompt sections).
5. Task 6 Step 1 (Codex).
6. Task 7 Step 2 using a Windows temp worktree.
7. Confirm Pi's `bash` tool runs through Git Bash: in Pi send `!printf 'Bash is working\n'` and record the output.
8. Bridge on Windows: if Claude Code is installed and logged in on this machine, also run Task 5 Steps 3-5 and Task 6 Step 1 with the bridge. If not, record "not run - no Claude Code on the Windows machine" (Task 11 then marks bridge-on-Windows as unverified; the Windows team profile is codex-only).

Record for each item: command, relevant output, exit code, pass/fail.
