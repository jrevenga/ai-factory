# AI Factory — Methodology Design

- Date: 2026-10-31
- Status: draft, pending owner approval
- Companion to: `2026-10-31-ai-factory-design.md` (architecture). This document replaces that document's §9 detail; the architecture keeps the mechanisms (gates, runtimes, stores, evals) and this document defines how work is done.

Notation as in the architecture: **[owner]** decided by the owner, **[call]** architect's call open to review, **[builder]** left to the builder, **[verify]** check before relying on it.

---

## 1. Intent

The methodology is what determines the quality of the factory's output; the architecture only carries it **[owner]**.

The owner's experience with Superpowers **[owner]**: it works well for building projects and complex things, but when the request is simple, direct, or pure brainstorming with no intention to build, it produces specs, plans and tests "without sense or criteria". The root cause is **routing**, not the quality of its pieces: it applies the same pipeline without first deciding what kind of request it is.

So the methodology's first job is to decide **how much process a request deserves**, and only then to apply rigorous practices proportionate to that decision.

## 2. Principles

1. **Route by intent first, then by risk; never by size.** File count, line count, number of tests or a requested todo list never decide the process.
2. **No project changes by default.** Questions, investigation, explanation, comparison, review and brainstorming do not modify the project and create no artifacts unless the user explicitly asks for a change. They may still execute whatever investigation needs (§3.1) **[owner]**: "no project changes" is not "read-only".
3. **Proportionate rigor.** Rigor that pays off on a project is overhead on a one-line fix; every step must earn its place for the tier it runs in.
4. **Evidence over claims.** A checkbox is not proof; "done" requires an observed check.
5. **Relevant context, not minimal context.** Delegate noise (heavy exploration), keep signal (the details of the change at hand). In projects, the orchestrator coordinates and delegates implementation.
6. **Enforce in code what matters; instruct the rest in plain language.** Hypothesis: prose alone is often not followed (one observation: RSC-Harness E2E, five sessions with zero feature documents). Enforcement checks **observed state recorded by trusted code**, never declarations written by the model.
7. **Every rule is a hypothesis.** Each carries its source and the improvement it is expected to produce; thresholds are parameters the evals can tune.

## 3. Request routing

### 3.1 Intent
At every turn the orchestrator classifies the request before acting:

| Intent | Examples | Behavior |
|---|---|---|
| **Answer** (explore) | explain, investigate, compare, audit, review, propose, brainstorm | No project changes, no artifacts, but full investigative execution (below). |
| **Change** | the user authorizes a modification (implement, fix, add, refactor, configure, delete) | Proceed to risk classification (§5). Designing and planning a feature or project belong here, since they write the design, spec and plan. |
| **Ambiguous** | change intent unclear or conditional | Ask **one** clarifying question and stay on the answer route until answered. Ambiguity slows the lane, it never raises it. |

**What the answer route may do [owner]** (investigation must not be crippled):
- Read, search, browse and fetch (read-only network).
- Run existing scripts, tests, builds and commands. Read-only commands and **allowlisted runners** (the project's test/build/lint commands, declared in project config or detected) run in the user's tree; outputs in git-ignored paths (build output, caches, dependencies) are fine. **Reconciliation**: before such a command, the extension records the state of tracked files, the index and the list of untracked files; afterwards, command-created changes (modified tracked files, index changes, new non-ignored untracked files) are reverted and the user is told. A file whose content changed in a way the command did not explain (e.g. a concurrent user edit) is never overwritten: it is reported as a conflict instead.
- Commands whose effects cannot be safely reconciled (not read-only, not an allowlisted runner) run in the **exploration worktree** by default, not in the user's tree.
- Prototypes, spikes and experiments go to a **disposable exploration worktree** (created on first need), where anything may be written. It is deleted at the end of the exploration unless the user wants to keep it, in which case it is promoted (§4).
- Still gated as everywhere: destructive operations, publishing or mutating remote state, secrets (architecture §8.1).

"I may stop and resume later" is not a request to stop; it is a hint to keep resumable state.

### 3.2 Announcement
When change work starts, when the route changes, or when the user might expect a change that will not happen, the response begins with one line in the user's language naming the route and why, e.g. `Route: small change — typo in a log message, no risk items.` or `Route: answer — you asked for a comparison, nothing will be modified.` Plain answers on an unchanged answer route need no announcement. The user corrects the route with a message or with `/route <answer|small|feature|project>`; the correction is honored immediately and recorded as an eval signal.

### 3.3 Re-injection **[call]**
"Turn" here means **user request**. The routing rule is injected for every new run via `before_agent_start` → `systemPromptOptions.sections` (not only at session start, because a single injection loses salience over long sessions — RSC-Harness per-turn gate). Within a run, the `context` event adds a one-line reminder of the current route and task to each model call. Steering and queued follow-ups enter an existing run **without** rerunning `before_agent_start` (verified by the final review against Pi v1.4.0 `agent-session.ts`); they are handled by §3.4.

### 3.4 Route state **[call]**
- The route is state held by the extension, declared by the orchestrator with the `set_route` tool (route, tier, task id, reason) and persisted in the Pi session (`appendEntry`), so it survives resume.
- **Unset route = answer.** The project cannot be modified until a change route is declared.
- A route persists across user messages until changed or until its task is delivered. A side question during a feature does not change the route; answering it simply modifies nothing.
- **Every user input is tracked through Pi's `input` event**, including steering and queued follow-ups. When a new user input is consumed by the running loop, the route enters `needs_reclassification`: read-only and answer-route actions continue, but **modifying tool calls are denied until the orchestrator re-declares the route** with `set_route` for that input. A request to stop modifying therefore takes effect immediately, and change permissions never silently survive a new request. **Detection**, from Phase 0 ([S8](../spikes/2026-10-31-phase0-report.md#s8-inputsteering-lifecycle)): steering and follow-ups fire `input` at submission with `streamingBehavior` `"steer"`/`"followUp"` but never `before_agent_start`; consumption is the `message_start` of a `user` message inside the running run (steer: after the current tool result, before the next model call; follow-up: after the model stops, before `agent_end`). Mechanism: (1) the primary trigger is any user `message_start` that is not the first message of the run; the state is set there, not at `input` time, because in-flight tool calls were requested under the old route; (2) the audit record of what was consumed comes from the consumed user message itself (its content at `message_start`/`message_end` with role `user`), persisted with `appendEntry`; an `input`-time FIFO of steer/follow-up submissions is at most a hint (e.g. for showing pending inputs), never the audit source, because another handler can drop a provisionally recorded input and a FIFO pop would then attribute the consumed message to the wrong request; (3) any such hint list is cleared at `agent_settled` (not `agent_end`) and on `clear_queue`; (4) the state is checked per run, not reset on `agent_start`. An `input` handler can transform or drop a queued input, not hold it. Only the RPC input source was exercised (the TUI shares the queueing code but was not run), and the `handled`/`clear_queue` edge cases are desk-checked only.
- The extension rejects inconsistent transitions (e.g. `set_route feature` with a task id whose file belongs to another task).

## 4. Exploration (Answer intent)

- The conversation itself is the artifact; Pi persists sessions and they can be resumed.
- Research uses the investigative capabilities of §3.1 and, when exploration is heavy, an explorer subagent with the same answer-route permissions (§9).
- A kept prototype from the exploration worktree is promoted into a change route like any other exploration outcome.
- **At the end, nothing is written by default.** If durable conclusions emerged, the orchestrator **offers in one line** to save them, never does it on its own. When the user accepts, the extension grants a **one-shot write** to exactly that target (one file or one memory entry) without changing the route or starting any implementation pipeline:
  - a decision about a project → `decisions/` (options → choice → why);
  - a discovery or user preference → operational memory;
  - an idea likely to be built → a short idea note in `ideas/`, the seed of a future design.
- **Promotion, not restart:** when the user later says "build it", the exploration's conclusions (session reference, idea note, decisions) are the input to design; questions already answered are not asked again.

## 5. Change classification

### 5.0 Provisional investigation
Classification happens after a **bounded investigation** with answer-route permissions (the inline read batch, §17). If that batch is not enough to understand the change, the agent maps the code (inline or with an explorer, §9) and then classifies; needing more reading alone never makes a change a feature.

### 5.1 The small-change test (all three must hold)
1. **Understood**: after investigation the agent knows what to change and where, and no product or design decision is open.
2. **Contained risk**: the change triggers none of the six risk items (§5.2).
3. **Resumable from the diff**: if the session stopped now, someone could finish it from the original request plus `git diff` alone.

### 5.2 Risk items — judged by consequence, not by location
1. Irreversible data or persisted-format changes (migrations, file formats, stored state).
2. Security, authentication, authorization, permissions, secrets handling.
3. **Changing a contract** others consume (public API, signatures or observable behavior of shared modules, CLI flags, schemas, events). Editing the implementation of shared code without changing its contract is not item 3, provided existing tests or checks cover its callers.
4. Concurrency (locks, async ordering, parallel access).
5. Delivery or environment semantics (CI pipeline behavior, deploy, infrastructure, release/build outputs). Cosmetic or local tooling config (formatter, editor settings) is not item 5.
6. A regression would matter and no test or check would catch it. Docs and comment changes are handled by the declared testing exception (§8), not by this item.

### 5.3 Risk line
Every code change closes with `Risk: none` or `Risk: item N (reason)`. Before writing `none`, the agent checks whether the change alters any contract consumed elsewhere. Risk may be **lowered only with recorded evidence** (e.g. "item 3 dropped: signature unchanged, 14 callers covered by passing tests — check c-12"), logged as a decision; risk identified by the user can only be lowered by the user.

### 5.4 Tiers

| Tier | When |
|---|---|
| **Small** | Passes all three parts of §5.1. |
| **Feature** | Fails §5.1 because a design decision is open, or the work is not resumable from the diff, or it touches a risk item; and it is one deliverable. |
| **Project** | Several deliverables or sessions, decisions that depend on each other, or requirements too long to survive compaction. |

**Promotion**: a task moves up a tier only because of unresolved decisions, risk or resumability discovered during work, never because it turned out to be bigger. It is promoted, not restarted: the task file seeds the spec.

## 6. Flows per tier

Gates referenced here are the architecture's (§8 there): hard gates always apply; soft gates follow the autonomy level.

### 6.1 Small — in place, in the user's working tree **[owner]**
1. Announce route.
2. Snapshot the tracked files about to be touched (undo point). If a file to edit already has uncommitted user changes, ask before touching it.
3. If the testing policy applies (§8): write the failing test, observe RED.
4. Implement inline, in the user's working tree.
5. Run checks per §11 (affected first; full suite when cheap).
6. Deliver: summary, check record ids, risk line. Changes are left **uncommitted** for the user to review; the undo point stays available until the next task. Gate: delivery.
If the task is promoted mid-work, its edits are moved into the new integration worktree as a patch and the user's tree is restored to the snapshot.
No task file, no plan, no subagents, no worktree, no review unless a risk item appears (then it is no longer small).

### 6.2 Feature
1. Announce route.
2. **Short design in chat**: intent, approach, acceptance criteria, risks. Soft gate: design approval (default stops; high autonomy may proceed when the request is unambiguous and logs the decision).
3. **Integration worktree** from a committed base (architecture §7.4), then the **task file** inside it (§7.1), including the approved design and acceptance criteria, before the first source write. Enforced in code.
4. Implement inline by default (delegation only on a trigger, §9), following the testing policy.
5. Verify (§11): acceptance criteria with evidence.
6. **Independent review** of the frozen candidate (§10). Mandatory.
7. Deliver: delivery report (§13). Gate: delivery and integration.

### 6.3 Project
1. Announce route.
2. **Living spec** (§7.2), built through a short design conversation. Before asking for approval, a **buildability check**: a fresh-context reviewer reads the spec as if it had to plan from it and returns only consequential unanswered questions (Superpowers 7 builder check); answerable ones are folded in, the rest go to the owner in one message. Then owner approval.
3. **Plan** (§7.3), phased; owner approval at plan level.
4. **Orchestrator as coordinator** **[owner]**: the orchestrator does not implement; plan work is implemented by writer subagents by reference to the spec and task (§9). The plan groups tasks into **work units**: a cohesive sequence of dependent tasks is owned by one writer; independent units get separate writers (in parallel when files are disjoint). The orchestrator integrates, verifies, decides.
5. One feature per session where practical; a progress file updated by code at each step (architecture §10.5).
6. Per phase: combined-candidate verification + independent review; soft gate at the end of each phase.
7. Deliver: delivery report per phase and at the end.

## 7. Artifacts

Location: `.factory/knowledge/` in the product repo (architecture §9.2/§10.1), Markdown + YAML frontmatter with a required `type` and a `schema` version, relative links. Shared only through normal PRs.

### 7.0 Ownership and revisions **[call]**
- **Canonical location while work is in progress**: the task's integration worktree (branch `factory/<task>`). Task file, spec and plan are created there and committed with each checkpoint; they reach the user's branch with the integration.
- **Single writer**: only the orchestrator, through the extension, writes the task file and progress state. Writers and reviewers never edit it; they return structured results and the orchestrator records them.
- **Handoffs carry a revision**: `Spec: .factory/knowledge/tasks/<slug>.md@<sha>, T2, S3–S4`. Worker worktrees branch from the integration head, so the referenced revision is present; the worker reads that revision, never a live copy.
- **Requirement revision**: the task file (feature) or spec (project) carries `rev: N` in frontmatter, the single authoritative requirement revision. Every change increments it.
- **Candidate identity vs operational metadata**: evidence and review are bound to a **content fingerprint** of the candidate, not to a commit SHA alone. The fingerprint is the git tree hash of the candidate **excluding operational metadata paths** (`.factory/knowledge/tasks/**`, progress files), plus, for uncommitted work, a hash of tracked changes and task-created untracked files. Updating checklists, evidence references, status or the Log therefore does not change the candidate and does not invalidate checks or review; any change to code, tests, spec, plan or design does. Post-freeze status transitions (review recorded, delivered, closed) are written to the run ledger and mirrored into the task file in a final metadata commit that is allowed only if the fingerprint is unchanged.

### 7.1 Task file — `tasks/<slug>.md` (feature and project tasks)
Order is fixed: stable content first, growing log last.
```markdown
---
type: task
schema: 1
status: in-progress | blocked | done
tier: feature | project
author: <git user.name>
branch: factory/<slug>
spec: ../specs/<slug>.md   # project tasks only
---
<!-- machine: written by code only -->
phase: implement · base: <sha> · checkpoint: <sha> · worktree: <path> · run: <id>
<!-- /machine -->

Objective: one sentence. Test runner: <command>.

## Specs
S1. "<the user's exact words, error messages and examples, verbatim>" — provenance
    → Interpretation: <actionable reading of S1, approved with the design>
S2. ...
(Assumptions are marked "Assumption:".)

## Design (approved <date>)
Approach; acceptance criteria (each linked to S#); rejected alternatives and why; approved assumptions; risk items.

## Tasks
- [ ] T1 (S1) route: inline — evidence: check c-7 / commit <sha>
- [ ] T2 (S2, S3) route: delegated (writer, reason) — depends on: T1 — ...

## Next
<single next step>

## Log
L1 (date) <the original request, verbatim>
L2 (date) <correction or decision, verbatim; evidence; skipped checks and why>
```
Rules:
- A task is checked only when it references a **passing check record** (§11) on the current candidate; failed, skipped or unavailable checks are recorded as such. Never invent RED/GREEN evidence.
- A requirement change appends a verbatim Log entry, rewrites the affected `S#`, increments `rev`, and triggers an **impact assessment** recorded in the Log: directly linked tasks, tasks that depend on them (`depends on`), affected tests, the approved design, and existing review dispositions. Affected items are reopened and their check records and review dispositions invalidated; unaffected completed work is preserved.
- Review findings never expand scope; out-of-scope findings become Log notes or new task proposals.
- The machine section is written only by the extension; the model writes the rest.
- Closed (`status: done`, merge info) by the delivery step.

### 7.2 Spec — `specs/<slug>.md` (projects)
Intent and why; goals, non-goals; requirements as numbered `S#` with acceptance criteria; design notes; open questions. After approval, changes are recorded as dated deltas at the end, never silent edits.

### 7.3 Plan — `plans/<slug>.md` (projects)
- Phases → tasks. A task is the smallest unit with its own test cycle and worth an independent check.
- Each task: files to touch, interfaces consumed/produced (signatures), linked `S#`, steps with an `Expected:` line.
- Tests are written in full in the plan when they define behavior; implementation appears only as signatures, plus a body only where tests and signature don't determine it. "A plan longer than the code it describes has written the code."
- Self-check before approval: every `S#` covered, no orphan task, proportion (a plan several times longer than the spec is a smell).

### 7.4 Decision — `decisions/<date>-<slug>.md`
Context, options considered, choice, why, consequences. Append-only; a superseding decision links back.

### 7.5 Idea note — `ideas/<slug>.md`
A few lines: the idea, why it matters, conclusions reached, link to the session. Created only when the user accepts the offer (§4).

## 8. Testing policy

- **Test first only when** a relevant, runnable, deterministic test is possible **and** the expected outcome is clear.
- **Scope [owner]**: the cases justified by the observable behavior requested and by the identified risks (boundaries, failure paths, interactions that the change actually affects), plus a regression test per touched existing behavior. **Nothing speculative**: no cases "just in case", no coverage padding. One rule may need several cases; ten cases for a one-line change need a reason.
- **Bug fixes always get a reproduction**: an automated regression test when one is runnable; otherwise a documented reproduction (steps or script and observed result) recorded as a check.
- Tests assert observable effects (output, exit code, persisted data) through the public interface, not mocks of internals.
- For changes to existing commands/options, a **differential check** against the base commit (same inputs, compare output and exit code in a scratch directory, never committed) catches unrequested behavior changes.
- **Declared exceptions**: documentation, configuration, throwaway spikes, or no reasonable runnable test. The agent states in one line why there is no test and which check replaces it.
- A failing existing test is never edited to make it pass without stating why the test was wrong and logging the decision.

## 9. Delegation policy

Default: **work inline**. Delegation costs tokens (Anthropic measured its multi-agent *research* system at ≈ 15× the tokens of a chat; the cost of coding delegation vs inline coding is not measured and is experiment 2), loses information at the handoff, and Anthropic states that most coding tasks are poorly suited to multi-agent setups because of shared context. It is used only for a named trigger:

| Trigger | When | Subagent |
|---|---|---|
| **Mapping** | Understanding needs more than the inline read batch (> 3 calls / ≈ 10k tokens) or > 5 sequential lookups | Explorer with answer-route permissions (no project changes); returns ≤ ~2k tokens with `path:line` evidence; the orchestrator spot-checks one claim |
| **Parallel writers** | ≥ 2 independent behavior units with disjoint files, each substantial (≈ 100+ changed lines) | One writer per unit, launched together, integration per architecture §7.4 |
| **Review** | Feature and project tiers, and any risk item | Fresh-context reviewer (§10) |
| **Context backstop** | Orchestrator context above the backstop threshold (default ≈ 150k tokens) | Next bounded unit delegated |
| **Project tier** | Every plan work unit | One writer per work unit (a cohesive sequence of dependent tasks); orchestrator coordinates |

Rules:
- Never split one behavior into separate test, docs and code writers. Units of ≈ 100 lines or less run inline.
- **Handoff by reference**: `Spec: .factory/knowledge/tasks/<slug>.md, T2, S3–S4`; the subagent reads the file and reports which `S#` it covered. Without a task file, the user's request is passed verbatim. Never a paraphrase.
- Brief contents: objective, file scope, constraints, expected output, return contract.
- **Return contract**: a structured result — status (`done | done_with_concerns | blocked | needs_context`), summary ≤ 15 lines, check record ids, files changed, `S#` covered, open questions. Subagents write nothing for reporting purposes; the **runner** persists the full transcript and result in the run ledger (`~/.factory/runs/`), outside project artifacts. Read-only subagents therefore stay read-only.
- Subagents never spawn subagents. Workers return gaps to the parent instead of assuming choices.
- Each delegated task records its route and trigger in the task file.
- The model per role is set explicitly by the profile (cheapest adequate for exploration, strongest for review).

## 10. Review policy

- The candidate is **frozen** (commit SHA; for parallel work, the combined candidate).
- The reviewer has a **fresh context**, read-only tools, and, when the profile allows, a **different provider** from the implementer (owner's profile: GPT Sol reviews Claude's work). Rationale: a model reviewing its own work tends to find issues and then talk itself into approving (Anthropic harness design).
- Input: task file / spec references (as intent, not as audit target), the diff for the SHA, verification evidence.
- **Lenses chosen by what changed**, not all every time: Risk (security, privilege, data exposure, dependencies), Reliability (behavior tests, edge cases, determinism, contracts), Readability (naming, complexity, duplication, dead code), Resilience (fallbacks, retries, rollback, observability). Default: Reliability; add Risk for items 1–3; Resilience for items 4–5.
- **Precision gate**: "when in doubt, stay silent". No style findings unless they hide a defect.
- Output: `No findings.` or findings with severity (`blocker | critical | warning | suggestion`), location, claim, evidence, suggested fix — JSON schema in core.
- The implementer evaluates each finding with technical rigor: verify, then fix or rebut with evidence. No performative agreement.
- Only candidate-caused blocker/critical findings block. Max **3 rounds**; then escalate to the user, or at high autonomy resolve and log the decision.
- Findings never expand scope.
- The review outcome is stored by the extension as a **review disposition** bound to the reviewed content fingerprint (`approved | approved_with_rulings | escalated`). Any change to the candidate's content invalidates it; operational metadata updates do not (§7.0). Delivery requires a valid disposition for the fingerprint being delivered.

## 11. Verification and evidence

- **Checks are run through the `run_check` tool**, executed by the extension, which records a **check record** in the run ledger: id, command, exit code, working directory, candidate **content fingerprint** (§7.0; for small changes, covering uncommitted tracked changes and task-created untracked files), duration, and full log path. The model sees the exit code and the relevant part of the output; the full log is kept. Evidence in task files and delivery reports references check ids; it is never free text.
- **No completion claim without a fresh passing check record** for the current candidate fingerprint. `deliver` recomputes the fingerprint and rejects records taken on any other content, including further uncommitted edits after the check.
- **Proportionate checks**: run the checks affected by the change first; run the full suite when it is cheap (below a configurable duration, default 2 minutes) or when a risk item applies, and always on the final candidate of feature and project work.
- Agent and subagent reports are claims; the orchestrator checks the diff and the evidence.
- Acceptance criteria are verified one by one against `S#`; user-reported failures are reproduced before deciding something "already works".
- Mutating examples run against isolated state.
- **Terminal state**: when proof is partial, blocked or exhausted, the result is one **"Needs your decision"** message (what is proven, what is not, options), never an endless verification loop.

## 12. Debugging

1. Root cause first: read the error fully, reproduce, check recent changes.
2. Form one hypothesis; test it minimally.
3. Write a reproducing test, then a single fix.
4. **After 3 failed fixes, stop** and question the approach with the user.
Deeper instrumentation (component boundaries, data-flow tracing) only when the cause is not evident.

## 13. Delivery report

Route and risk line; summary; what changed (files, commits); acceptance criteria with evidence; tests added and why (or declared exception); review findings and resolutions; decisions taken autonomously (incl. skipped soft gates); usage per provider; the integration action awaiting approval.

## 14. Enforcement in code (Pi extension)

| Invariant | Mechanism |
|---|---|
| Routing rule present for every user request | `before_agent_start` → `systemPromptOptions.sections`; per-model-call reminder via `context` (never replacing the system prompt; bridge-compatible) |
| Answer route (and unset route) does not change the project | Applied **through the architecture's tool and command policy** (architecture §8.1.1), not only to write/edit tools: write/edit tools are denied in the user's tree but allowed in the exploration worktree; commands may run (§3.1) with the tracked-file snapshot and automatic restore; hard gates apply as everywhere. One-shot grants (§4) are the only way to write a project artifact from this route |
| Feature/project: no source write before the task file exists | `tool_call` denies writes outside the current task's authorized paths until the task file for the declared task id exists in its integration worktree; authorized paths = the worktree minus `.factory/` |
| `.factory/` is not a free-write zone | Writes under `.factory/` are limited to the current task's artifacts (task file, spec, plan, decisions it creates); policy, config and other tasks' files are denied |
| Machine-owned state is protected | The machine section, run ledger, check records and review dispositions are written only by extension code; model writes touching the machine markers are rejected |
| No task closed without evidence | `deliver` recomputes the candidate fingerprint and verifies: every checked task references passing check records on that fingerprint; feature/project work has a valid review disposition for it; the risk line is present |
| Reminder hooks | Fire at most once per session; fail open |

The route is declared by the orchestrator through `set_route` (route, tier, task id, reason) and held as extension state (§3.4); the announcement line is rendered from it **[call]**. These guards are guardrails with the limits stated in the architecture (§8, §11): they constrain the model's tool calls, not every effect of an arbitrary process.

## 15. Skills

Agent Skills format; only descriptions are always loaded; bodies load on demand. Written fresh for the factory (ideas from Superpowers under MIT are credited).

| Skill | Loaded when | Produces |
|---|---|---|
| `route` | Every turn (its rule is re-injected) | Route + tier + reason via `set_route` |
| `explore` | Answer route needing research | Answer; optional offer to save (§4) |
| `design` | Feature design / project spec | Chat design or spec |
| `plan` | Project tier after spec approval | Plan |
| `implement` | Any change | Code + tests per testing policy; task file updates |
| `debug` | A failure to investigate | Root cause, regression test, fix |
| `delegate` | A delegation trigger fires | Subagent brief by reference; route recorded |
| `review` | Reviewer role | Findings or `No findings.` |
| `receive-review` | Implementer receives findings | Fix or rebuttal per finding |
| `verify` | Before any completion claim | Evidence per `S#` or "Needs your decision" |
| `deliver` | End of a change | Delivery report; task closed |
| `memory` | Saving or recalling knowledge | Memory/knowledge entries per architecture §10 |
| `evolve` | Maintainer mode only | Experiment, eval report, PR proposal |

## 16. Writing style for skills and prompts **[call]**

- Plain, direct language. **Avoid capitals for emphasis, rationalization tables and threats by default**: Anthropic's guidance for current models is that plainly worded instructions are followed and aggressive emphasis tends to cause over-application. Whether this contributes to Superpowers' over-zealousness is a hypothesis, not established; emphasis may be reintroduced for a specific rule if evals show it is needed.
- **Harness-neutral text** **[call]**: the body of each skill describes the method in harness-neutral terms; Pi-specific tool usage (`set_route`, `run_check`, `deliver`) sits in a short, clearly marked section, so the Claude Code and Codex adapters (architecture §7.5) replace only that section.
- Middle altitude: neither brittle if/else scripts nor vague advice.
- A few diverse canonical examples instead of long edge-case lists.
- Short always-on instructions; detail in skill bodies loaded on demand.
- Skills are scored on the eval suite like any other change.

## 17. Parameters (core data, versioned)

| Parameter | Default | Source |
|---|---|---|
| Inline read batch | 3 calls / ≈ 10k tokens | Gentle-AI capability manifest |
| Sequential lookups before mapping | 5 | Gentle-AI |
| Explorer return budget | ≈ 2k tokens | Gentle-AI; Anthropic (1–2k summaries) |
| Parallel writer unit size | ≈ 100 changed lines | Gentle-AI |
| Context backstop | ≈ 150k tokens | Gentle-AI (advisory there) |
| Review rounds | 3 | architecture §9.4 |
| Failed fixes before stopping | 3 | Superpowers systematic-debugging |
| Session-start context injection | ≤ 4 KB | architecture §10.4 |
| Subagent return summary | ≤ 15 lines + report file | Superpowers implementer contract |

## 18. Hypotheses and first experiments

Each rule is a hypothesis to be tested by the eval system (architecture §12.1). First experiments, in order:
1. **Routing accuracy**: does the classifier pick the route the owner would pick? Two parts: a cheap one-call classification check on a labeled set of real requests (incl. brainstorming and simple ones) — **source [owner]**: requests extracted from the owner's local Claude Code session history (`~/.claude/projects/`), about 50 labeled by the owner with the route they would have wanted; the set stays local and is never published — and **multi-turn cases** — steering mid-task, side questions, promotion, changing requirements, resume after interruption. Hypothesis: the largest efficiency lever. Competing explanation to test: over-ceremony comes from the heavy phases themselves rather than from routing (compare routing-only vs routing + lighter phases).
2. **Inline-default vs delegate-default** per tier (feature, project).
3. **Reviewer precision gate** on/off: escaped defects vs noise findings.
4. **Testing scope limit** vs broader test generation: escaped defects vs usage.
5. **Re-injection every turn** vs session start only: route compliance over long sessions.

Delivery of the methodology (architecture Phase 4) does not wait for these experiments; it requires the Phase 4 acceptance criteria. Experiments run afterwards and drive changes through the evolution flow.

Known evidence today is thin: most rules come from practitioner experience; the few measurements are n=1 (Gentle-AI) or qualitative (RSC E2E). Source versions used: Superpowers 7.0.0, Gentle-AI `main` as of 2026-10-31, RSC-Harness `main` as of 2026-10-31, Pi docs v1.4.0. The methodology ships as a reasoned hypothesis and is pruned or tightened by measurement — including removing components that stop paying off as models improve (Anthropic: prune the harness one component at a time and measure).

## 19. Sources

| Element | Source |
|---|---|
| Read-only default (adapted here to "no project changes"), ambiguity → one question, small-change test, risk items, risk line, delegation triggers, handoff by reference, task-file structure (verbatim `S#`, `L1`), testing scope limit, differential check, "Needs your decision", lenses, precision gate | Gentle-AI ODD/RDD (`internal/components/agentguidance/routing.go`, `docs/trigger-rules.md`, review agents) |
| Route announced in one line, per-turn re-injection, "the checkbox is not the proof", `Next`, promotion not restart, hooks over prose | RSC-Harness (`targets/hook-once.mjs`, `skills/ftd/SKILL.md`) |
| TDD discipline, evidence before claims, systematic debugging (root cause, 3 failed fixes), receiving review with rigor, plan format and "plan longer than code", subagent return contract | Superpowers 7.0.0 |
| Context rot, relevant context, multi-agent cost and fit for coding, skeptical separate evaluator, one feature per session, progress file, plain-language prompts, prune the harness | Anthropic engineering posts and Claude Code best practices |
| Intent-first routing as the fix for over-ceremony; orchestrator-as-coordinator only in projects; exploration offers; enforcement of route invariants in code; parameters as data | This design |

## 20. Mapping to the build order **[call]**
- Architecture Phase 2 provides the guard mechanisms this methodology relies on (tool/command policy, run ledger, incremental state); `set_route`, route state and `run_check` are built there.
- Architecture Phase 4 delivers this methodology inline and **pulls forward from Phase 5 the minimum it needs**: a reviewer subagent runner (fresh context, other provider) and the integration worktree. Parallel writers and project-tier delegation stay in Phase 5.
- Until Phase 6 (memory), exploration offers save to project knowledge (`decisions/`, `ideas/`) only; the memory option appears when the store exists.
- The §18 experiments require the Phase 3 eval harness.

## 21. Decisions recap

**[owner]**: methodology designed before Phase 0 as its own document; exploration leaves nothing written by default but may execute scripts, tests and prototypes (no project changes ≠ read-only); small changes in place in the user's tree with undo snapshot; tests scoped by behavior and risk, nothing speculative; routing set from the owner's own session history; testing policy as in §8; change classification and tiers as in §5–6; delegation inline by default with orchestrator-as-coordinator in projects (refined from the owner's "keep the orchestrator's context clean" view); enforcement, writing style and evolution as in §14–18.

**[call]**: `set_route` tool; blocking writes on the answer route; lens defaults per risk item; parameter defaults; experiment order; artifact templates' exact fields.

**[builder]**: exact skill wording; JSON schemas for findings and return contracts; how the extension detects "source write" paths per project.
