# Harness radar for ai-factory (2026-11-04)

Method: metadata and file contents read from each repo through `gh api` (GitHub API); nothing cloned or executed. Fetched text was treated as data. Stars and sizes are approximate. WebFetch was not loaded; the GitHub API gave the same primary content.

Spec references: "Design" = `2026-10-31-ai-factory-design.md`, "Method" = `2026-10-31-factory-methodology-design.md`.

## 1. obra/superpowers
**What.** Jesse Vincent / Prime Radiant; MIT; ~312k stars; last push 2026-11-03; v-bumped plugin for ~16 harnesses, including a `.pi/` extension. Skills: 15 (`skills/`).
**Techniques.**
- Skills are tested like code: "Writing skills IS TDD" with pressure scenarios against subagents, baseline-fail then pass, "no skill without a failing test first" ([writing-skills/SKILL.md](https://github.com/obra/superpowers/blob/main/skills/writing-skills/SKILL.md)). Directly reusable as the acceptance rule for evolution PRs.
- Session forensics: `diagnosing-superpowers` reads transcripts and reports findings only with `path:line` citations ("no citation, no finding"), then packages a scrubbed bug-report bundle ([SKILL.md](https://github.com/obra/superpowers/blob/main/skills/diagnosing-superpowers/SKILL.md)). Good model for a run-ledger-driven "why did this run go wrong" tool.
- Release hygiene: `.version-bump.json` lists every manifest field that must carry the version plus an audit that greps for stray copies ([file](https://github.com/obra/superpowers/blob/main/.version-bump.json), `scripts/bump-version.sh`); structural tests `tests/skill-layout`, `tests/skill-size`, `tests/version-bump`.
- Portability: `docs/porting-to-a-new-harness.md`, per-harness test dirs.
- Updating is delegated to each harness ("somewhat coding-agent dependent") and there is no pin or rollback of its own ([README, Updating](https://github.com/obra/superpowers#updating)). It also sends an optional version ping (opt out by env var).
**Verdict: ADAPT.** Take the skill-TDD rule and the citation-only diagnosis pattern for Phase 4 (skills) and Phase 8 (evolution); their update story is weaker than ours, so skip it.

## 2. Gentleman-Programming/gentle-ai
**What.** Alan Buscaglia ("Gentleman"); MIT; ~8.3k stars; pushed 2026-11-03; Go binary, ~95 MB repo, v4.0.0; configures 17 agents including Pi.
**Techniques.**
- Update safety: snapshot before every install/sync/upgrade, checksum dedup, keep 5, pin-able, `existed=false` tracking for new paths ([docs/rollback.md](https://github.com/Gentleman-Programming/gentle-ai/blob/main/docs/rollback.md)). Closest prior art to our `factory update/rollback` state backup.
- Signed releases: the updater refuses to run unless the checksum file's Minisign signature verifies against trust anchors embedded in the binary and a signed identity `repo=...;tag=...`; the key is published through a channel independent of the release page ([docs/release-signing.md](https://github.com/Gentleman-Programming/gentle-ai/blob/main/docs/release-signing.md)). Also `internal/releaseprovenance`, `releasepolicy`, `consentenvelope`, `managedownership`, `recoverytrace`.
- Benchmark harness with hidden acceptance suites, single-run cells (n=1, admitted in README), "proportional routing" derived from measurements ([`bench/`](https://github.com/Gentleman-Programming/gentle-ai/tree/main/bench), README "Measured"). Their own n=1 shows why our n>=5 rule (Design 12.1) is right.
- Methodology close to ours: ODD sizes work by understanding, risk and resumability, not file count; delegate "for a reason" (exploration, parallel writers, context backstop, independent verifier) ([docs/trigger-rules.md](https://github.com/Gentleman-Programming/gentle-ai/blob/main/docs/trigger-rules.md)).
- RDD review: candidate frozen to lineage/revision/target before review, risk picks depth, binary returns the only valid next transition ([docs/review-integration.md](https://github.com/Gentleman-Programming/gentle-ai/blob/main/docs/review-integration.md)); `docs/review-authority-threat-model.md`.
- Security deny-list for `~/.ssh`, `.env`; `doctor` read-only.
**Verdict: ADAPT.** Strong for Phase 1 (signed/verified releases, snapshot semantics) and Phase 3/4 (hidden-check bench, frozen-candidate review). Heavy and fast-moving; copy ideas, not code.

## 3. ericrisco/rsc-harness
**What.** Eric Risco; MIT; ~477 stars; created recently, 30+ releases, v4.0.5, pushed 2026-11-04 (several releases per day); npm `@ericrisco/rsc`; 274 skills, 34 agents; Node.
**Techniques.**
- Pinned, git-carried harness: `.rsc.json` records `catalogVersion`; a clone runs `npx @ericrisco/rsc@<catalogVersion> sync`; a bootstrap hook notices an unbuilt clone and asks, never installs on its own; `doctor` after pull, `repair` with `--dry-run`, `restore latest` ([README, Sharing the harness through git](https://github.com/ericrisco/rsc-harness#sharing-the-harness-through-git)). Very close to our reproducible-distribution pain.
- Auto-update policy: same-major installs in background and takes effect next session, new major asks, opt-out file; every sync snapshots first ([README, Update](https://github.com/ericrisco/rsc-harness#update); `scripts/auto-update.mjs`, `tests/update-preserves-work.test.js`). Note this conflicts with our "users opt in" rule.
- The most complete self-improvement machinery found: `skill-harden.workflow.js` = behavioural eval (with-skill vs without), diagnose fault as skill/eval/capability, edit with three mandatory anti-gaming guards (diff judge, hold-out, generalization gate), max 2 rounds, commit on pass ([scripts/skill-harden-rubric.md](https://github.com/ericrisco/rsc-harness/blob/main/scripts/skill-harden-rubric.md)); `lib/eval-integrity.js` blocks scores if the control arm read the skill or the rubric; a test asserts each documented guard is actually implemented. Matches our held-out set and withheld-checks design.
- `continuous-learning` skill routes a lesson from a mistake to the durable surface that fires next time ([SKILL.md](https://github.com/ericrisco/rsc-harness/blob/main/skills/continuous-learning/SKILL.md)); `skill-scoreboard.workflow.js`, `routing-audit.js`, `drift-check.js`.
- Enforcement by hooks (lane decisor per turn, danger/ship/branch guards); README states plainly that outside Claude Code the rules are advisory. Already cited in Design 8.5.
**Verdict: ADAPT (highest value).** Feeds Phase 3 (eval integrity, hold-out), Phase 8 (fix loop with guards) and Phase 1 (pin, repair, restore). Very young and fast-churning, so read, do not depend.

## 4. mattpocock/skills
**What.** Matt Pocock; MIT; ~313k stars; pushed 2026-11-04; ~2 MB; plugin for Claude Code, Codex, Copilot; buckets `engineering/ productivity/ in-progress/ misc/ deprecated/`.
**Techniques.**
- `retro` skill: reads session logs and proposes improvements to the agent's environment, classified (navigation, automated checks, coding standards, AGENTS.md bloat, tool economy, no-ops, information access); rule: mechanical violations get a deterministic check, not prose ([skills/engineering/retro/SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md)). Ready-made taxonomy for factory learnings (Design 10.3).
- Governance: `SCOPE.md` bar = an observed failure in a real session plus fits philosophy; `.out-of-scope/*.md` records one rejected concept with reason and prior requests ([SCOPE.md](https://github.com/mattpocock/skills/blob/main/SCOPE.md)). This is the same as our "ignore, never re-proposed" radar archive.
- Changesets for semver of a skills package (`.changeset/`, `scripts/sync-plugin-version.mjs`); `implement-spec` uses a fresh implementer per ticket; `in-progress/software-factory` reference skill.
**Verdict: ADAPT.** Take the retro taxonomy and the observed-failure admission bar for Phase 8; changeset-style release notes for Phase 1. No eval system, no rollback.

## 5. affaan-m/ecc (repo is now `affaan-m/ECC`)
**What.** Affaan Mustafa; MIT; ~297k stars; v2.2.3, last push 2026-11-02; ~60 MB; 71 agents, 314 skills, adapters for ~15 harnesses incl. a `pi/` dir and `manifests/pi-core.json`; npm `ecc-universal`, `ecc-agentshield`.
**Techniques.**
- Instinct learning: hooks observe every tool call, a background Haiku agent writes atomic "instincts" with confidence 0.3-0.9, project-scoped storage, promotion to global when seen in 2+ projects, clustering into skills ([skills/continuous-learning-v2/SKILL.md](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md)). Useful for scoping (project vs global), but there is no evidence gate on promotion.
- Lifecycle tooling: install plan, modules and profiles in `manifests/*.json`, install-state store, `doctor`, `repair`, `uninstall`, `list-installed`, `harness-audit` (`scripts/`, `scripts/lib/install-state.js`). Shows what a full distribution lifecycle needs.
- README admits "a version pin is not a security audit or integrity check" and warns about official channels (impersonation exists).
- Large `gateguard-*` library (read-only shell detection, search evidence).
**Verdict: WATCH.** Mine the instinct scope/promotion idea for Phase 6/8 and the install-state schema for Phase 1; the surface is huge and mixed quality. Hook-observed learning is not needed since we own the run ledger.

## 6. multica-ai/andrej-karpathy-skills
**What.** multica-ai; **no licence** (API returns null, no LICENSE file); ~229k stars; one `CLAUDE.md` (4 principles: think before coding, simplicity, surgical changes, goal-driven execution) plus one skill; last push 2026-04-20; 28 commits.
**Techniques.** [CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md) is a compact behavioural prompt; "every changed line traces to the request" is a testable rule for review. Nothing on update or evolution.
**Verdict: SKIP** as a dependency (unlicensed, stale); the four ideas are already inside our methodology principles and can be reworded independently.

## 7. revfactory/harness
**What.** revfactory (Korean-language skills); Apache-2.0; ~9.3k stars; pushed 2026-09-28; ~30 MB; v2; 2 skills (`harness` meta-skill designs agent teams and generates skills; `evolve`).
**Techniques.**
- `evolve` skill: collect deltas via git log of harness files and `_workspace/` traces; observation signals trigger proposals without user feedback (same fix requested twice, repeated retries, user bypassing the orchestrator = trigger failure); map feedback type to target file; **generalize rather than overfit**; record the "why"; one change at a time; **regression guard** (warn when a change reverses an earlier logged change); change-history table ([skills/evolve/SKILL.md](https://github.com/revfactory/harness/blob/main/skills/evolve/SKILL.md)).
- Verification list includes trigger evals and with/without-skill A/B. README's +60% (49.5 to 79.3, n=15, 15/15 wins) is author-run and self-labelled as such; v1 relied on an experimental API that was later removed.
**Verdict: ADAPT** (evolve's signal list and regression guard for Phase 8). Do not use the generator; treat numbers as unverified.

## 8. alirezarezvani/claude-skills
**What.** Alireza Rezvani; MIT; ~29k stars; v2.14.8, pushed 2026-11-03; ~410 skills across business domains plus 12 CI workflows.
**Techniques.**
- CI as skill QA: nightly `skill-evals.yml` runs trigger and with/without behaviour evals on a rotating slice, budget capped (`SKILL_EVALS_BUDGET_USD`), off by default; `skill-security-audit.yml` on PRs; `virustotal-scan.yml`; `sync-codex-skills.yml` ([workflows](https://github.com/alirezarezvani/claude-skills/tree/main/.github/workflows)). We keep model evals off CI (Design 12.1), but the rotation slice and budget cap map to our systemd timer.
- [SKILL-AUTHORING-STANDARD.md](https://github.com/alirezarezvani/claude-skills/blob/main/SKILL-AUTHORING-STANDARD.md): rule never to name a skill like a harness built-in (shadowing, issue #885); [SKILL_PIPELINE.md](https://github.com/alirezarezvani/claude-skills/blob/main/SKILL_PIPELINE.md): intent, research, draft, eval, iterate (max 5), compliance, package, deploy, verify, rollback-ready.
**Verdict: WATCH.** Take the shadowing lint and the nightly rotation idea; breadth over depth, depends on external tools (Tessl, ClawHub).

## 9. walkinglabs/learn-harness-engineering
**What.** walkinglabs; MIT; ~23k stars; pushed 2026-10-22; ~30 MB; a 14-lecture course in 15 languages, 6 projects, `harness-creator` skill with `evals/evals.json`, `tools/audit-harness.sh`.
**Techniques.** Five-subsystem model (instructions, state, verification, scope, lifecycle); `audit-harness.sh` is a zero-dependency checklist with CRITICAL pass/fail exit code ([tools/audit-harness.sh](https://github.com/walkinglabs/learn-harness-engineering/blob/main/tools/audit-harness.sh)); includes a breakdown of Pi's own harness design ([docs/en/harness-designs/pi](https://github.com/walkinglabs/learn-harness-engineering/blob/main/docs/en/harness-designs/pi/index.md)), useful as a second reading of Pi's extension seams. Educational, not a mechanism.
**Verdict: WATCH.** Use the audit checklist as a cheap input to `factory doctor`/project-init checks; no update or evolution mechanism.

---

## Synthesis

### Top 5 ideas (ranked for self-improvement and update goals)
1. **Anti-gaming fix loop: diagnose skill-fault vs eval-fault vs capability, then edit under diff-judge + hold-out + generalization gate, with a test proving each guard is implemented** (rsc-harness `scripts/skill-harden-rubric.md`, `harden-generalization-gate.test.js`).
2. **Eval integrity check: void the score if the control arm read the skill or the grader rubric** (rsc-harness `scripts/lib/eval-integrity.js`; reinforces Design 12.1 withheld checks).
3. **Pinned harness version carried in git plus bootstrap notice, `doctor`/`repair --dry-run`/`restore`, snapshot-before-sync with dedup and retention** (rsc-harness README; gentle-ai `docs/rollback.md`).
4. **Signed release verification: signature over checksums that names repo and tag, trust anchor distributed out of band** (gentle-ai `docs/release-signing.md`).
5. **Evolution intake discipline: observed-failure admission bar, retro taxonomy ("mechanical rule becomes a deterministic check"), evolve's regression guard against reversing past changes, and skill-TDD (baseline fail first)** (mattpocock `SCOPE.md` and `retro`; revfactory `evolve`; superpowers `writing-skills`).

### Overlaps and conflicts with decisions already made
- Overlap: held-out vs dev split, withheld checks, paired n>=5 statistics (Design 12.1) already exceed most repos; gentle-ai's n=1 benchmark and revfactory's author-run n=15 confirm the need.
- Overlap: radar triage with archived "ignore" (Design 12.2) equals mattpocock `.out-of-scope/`; evolution via PR with eval report (Design 12.3) is stricter than anything surveyed (rsc commits on pass; ECC promotes by confidence only).
- Overlap: methodology routing (Method 3, 5) is near gentle-ODD's size-by-risk and delegate-for-a-reason; invariants-in-code (Design 8.5) is the rsc lesson already adopted.
- Conflict: rsc auto-updates in the background on session start; ours is explicit `factory update` with changelog, confirmation and no active runs (Design 6.2, "users opt in", 12.3 step 6). Keep ours; at most notify.
- Conflict: ECC/rsc learn automatically from hook observation and write directly; ours restricts self-evolution to maintainer mode and PRs (Design 12.3, 10.3). Keep ours; use their capture ideas only to feed radar/learnings.
- Gap we may fill: signature verification of releases (Design 6.1 relies on git tags and credentials; no signing or checksum verification is specified); worth a decision for Phase 1 or the public-npm switch.
- Neutral: all surveyed repos are Claude-Code-first; none enforces gates under Pi, so there is no competing design for our `tool_call` hook.

### Risks
- Licences: 8 of 9 are MIT or Apache-2.0 (revfactory); **andrej-karpathy-skills has no licence**, so copying text is not permitted; reword ideas only.
- Immaturity and churn: rsc-harness (young, several releases a day, 477 stars), gentle-ai (v4.0.0 with Pi support in a separate package, Windows install marked "open checkpoint"), ECC (huge surface, impersonation warnings) and revfactory (v1 API removed) can change shape in weeks. Depend on none; record ideas with the commit date.
- Supply chain: skill and plugin repos are executable prompts plus scripts and hooks; rsc's own README tells users to review its bootstrap hook as they would a CI workflow. ECC states a version pin is not an integrity check. Never auto-install from these; scan any imported text before use (claude-skills runs a skill security audit and VirusTotal in CI as a data point).
- Claims: star counts are inflated by hype (three repos above 200k); benchmark numbers are author-run (revfactory +60%, gentle-ai n=1). Do not import numbers as evidence.
- Not verified: I did not read private issue trackers or the remainder of each large tree (ECC, claude-skills); statements are limited to the files cited.
