# Startrips Long-Running Agent Operating Manual

## Effective control-plane protocol (2026-09-17)

This section is the shared operational contract for Orchestrator, Experience,
LOCAL Backend and Hourly Review. It supersedes conflicting historical procedure
below; feature acceptance and the latest explicit owner decisions remain intact.
Automation prompts carry roles and this entry point, never current PRs or SHAs.

- ONE remains `feature_list.json`; do not create another backlog, owner registry,
  routing table or feature lock system. Use the existing selector. Generic
  invocations MUST explicitly supply `STARTRIPS_LANE` in the executing shell;
  missing/unknown lane is an error, not Backend. Existing local Backend launch
  wrappers may explicitly declare their own lane. Never dispatch Backend from
  Orchestrator or Experience.
- Read current ONE/selector and exact GitHub heads, workflows and review state.
  Historical notes, PR prose and previous task snapshots cannot invalidate newer
  machine evidence. No implicit feature claim or product decision from a probe.
- A resolved review thread is resolved even without a prose reply. An outdated
  but unresolved thread still needs disposition. Use actual GraphQL thread state
  and effective current reviews, not unanswered REST comments or all historical
  CHANGES_REQUESTED reviews. API failure is UNKNOWN, never zero findings.
- Old base SHA alone NEVER requires rebase. Require a concrete merge conflict,
  semantic/dependency conflict, invalidated evidence or actual repository rule.
  Check current mergeability and semantic overlap; the final integration gate is
  exact-main push CI. Do not churn Source/review/ledger merely because main moved.
- CODE Source and final PR head are different identities. A verified single
  ledger-only commit after Source preserves that Source review. Derive Source
  from the actual ledger and commit relation, not an old prompt. Never add a
  duplicate seal. Freeze only after independent Maintainer review and real
  Source CI pass; external Codex review is supplementary, not a mandatory wait.
- Owner creates ledger and HANDOFF_REVIEW once. Hourly Review independently
  reviews/signs/merges; Orchestrator never does. A merged PR becomes `passed`
  only with its exact merge identity contained in a freshly verified exact-green
  main push. Pending/failed/unknown integration CI never unlocks dependencies.
- New logical-owner creation is different from integration reconciliation. A new
  owner/worktree must branch from the exact current GitHub `main` identity after
  fetching and verifying `origin/main`, but current-main push CI does NOT need to
  be green merely to start unrelated work. Exact-main green remains mandatory for
  terminal `passed` / dependency unlock only; a red current main is evidence to
  preserve and route, not a global development freeze.
- A logical owner outlives one session. Resume the same owner/worktree/branch after
  proving an old execution ended; preserve that owner's dirty work. Never borrow
  someone else's dirty tree, create a competing owner or widen permissions.
  Distinguish requested readOnly access from an actual denied inherit operation.
- Execution-carrier exclusion is lane-scoped, not workspace-global. A provably
  Backend carrier and a provably Experience carrier may run concurrently. Same-lane
  carriers still exclude duplicates; an unknown lane, unreadable carrier whose lane
  cannot be proven, or mismatched owner/worktree remains fail-closed. Carrier lane
  is observable process metadata (`--carrier-lane` / worker marker), never a second
  owner registry. ONE writes and intake state transitions remain globally serialized
  through `feature_store.py` transactions, so cross-lane execution does not weaken
  storage safety.
- STOP scope follows the same boundary. `AGENT_STOP` is the explicit global owner
  stop and blocks every lane. `SUPERVISOR_STOP` and `CANCEL_SCHEDULED_RESTART`
  belong only to the dedicated LOCAL Backend supervisor/restart lifecycle; Experience
  must preserve those files but must not treat them as its own stop condition. Never
  clear a Backend stop merely to run Experience.
- On transient transport/permission/runtime failure, leave product and ownership
  state unchanged, keep the existing scheduled observer enabled, and retry only
  bounded authorized idempotent probes. Do not disable an automation or require
  a prose acknowledgement to resume. User STOP still takes precedence.
- Use `lib/feature_store.py` for ONE updates: expected-state checks, field-scoped
  changes, storage-transaction serialization and byte-preserving atomic replace.
  Its storage mutex is not feature ownership. Never whole-file dump JSON or
  rewrite/re-encode historical `claude-progress.md`. No reset/stash/clean.
- Select feature first, then derive its next action. `ready_for_eval` goes to
  evaluation/handoff, not another implementation pass. Infrastructure waits do
  not spend feature attempts. No-change detection uses content/evidence identity,
  not merely the list of dirty filenames.
- GitHub Conversation is exception-only. No routine progress replies. Fix and
  resolve valid findings without narration; post only disputed product intent,
  explicit human decisions, or concrete safety/security/data/migration concerns.
  Known same-SHA reruns remain bounded; recurring failure fingerprints require
  root-cause work, never timeout inflation or weakened assertions.


## Source review receipt

The executable next-action reader is `run-loop.sh --plan`, after setting the lane
inside the target bash. `--next` is the only selector; `--next-action` is only an
offline status hint. No new status, owner registry, queue or feature lease is used.

Hourly Review independently inspects every changed file on the exact CODE Source,
including draft PRs that are awaiting Source review. After its own inspection it
records `.agent-artifacts/evaluations/<ST>-<SOURCE>-source-review.json` through:

```text
STARTRIPS_ROLE=hourly-review python -B lib/action_plan.py feature_list.json <ST> --record-review <result.json>
```

The result is an evidence document, not a claim: `feature`, `pr`, `source_sha`,
`verdict` (CLEAR or CHANGES_REQUESTED), `findings`, `reviewed_paths`, `evidence`.
CLEAR requires no findings, the full changed-file set and actual review evidence.
The helper verifies live Source and adds `reviewer_role` and `completed_at`.
Builder/Experience/Backend must never manufacture this receipt. Absence of an
external comment, a requested review, or zero unresolved threads is not approval.
A valid one-commit ledger final preserves its reviewed CODE Source. Local activation
of harness code is not sign/merge approval. Unmapped PRs retain their existing owner;
Hourly Review records its normal independent PR review without inventing an ST.

The owner consumes live plans: IMPLEMENT, REPAIR_REVIEW, REPAIR_CONFLICT, REPAIR_CI,
REPAIR_CI_FAMILY, WAIT_SOURCE_CI, WAIT_SOURCE_REVIEW, SEAL, WAIT_FINAL_CI,
HANDOFF_REVIEW, WAIT_REVIEW, WAIT_MAIN_CI, RECONCILE or OBSERVE. Waits preserve
attempts/ownership. Owner creates only the one permitted ledger on SEAL; the
validated handoff transaction records ready_for_eval once per exact final.
Hourly Review owns subsequent evaluation, sign, merge and exact-main proof.

LOCAL Backend restart observes the actual process provider and git worktree list.
An old CLI execution must have ended before a fresh session resumes the same
owner/worktree/branch, including dirty or unpushed work. Existing execution or
unreadable provider means no duplicate launch. External Codexless sessions are
checked with their actual `agent_show` receipt before continuation; do not infer
termination from a readOnly request or a disconnected chat. Session approvals and
permissions remain with the original execution provider, never a broader fallback.

Experience external-provider occupancy is provider-receipt state, not merely local
process occupancy. `lib/execution.py occupied --lane experience` observes the bounded
launcher/carrier transition; after `launch-experience.sh` prepares an external owner
and exits it may report zero local carriers while formal Codex Experience owners are
still running. The scheduler MUST reconcile `.agent-artifacts/external-execution/`
receipts with fresh `agent_show`, count each proven `running`/`awaitingApproval` exact
feature/worktree as one of the two Experience slots, fail closed on unknown provider
state, and narrow selector probing with those active feature ids so no duplicate owner
is prepared. ONE remains the only logical owner registry; receipts are execution
evidence only.

A formal Experience receipt keeps both the provider `agent_ref` and exact `task_ref`.
`agent_show(agent_ref)` is the primary lifecycle probe. If it returns exact `unknown
agentRef`, that is not proof the owner ended: query the receipt's exact `task_ref`
read-only and accept it only when taskRef/requestId plus agentRef/turnId when present
match the same receipt generation. A matching terminal task card may terminalize the
receipt; a matching active card keeps the slot occupied. Missing/mismatched/unreadable
task evidence, including provider schema failure while rendering an active task, stays
UNKNOWN and fail-closed. Never create a new generation merely because agentRef lookup
was lost.

Experience pre-scope failures must preserve invocation identity, not only pid/lane.
`launch-experience.sh` publishes its non-secret `EXPERIENCE_CARRIER_TOKEN`, and
execution-provider conflict evidence preserves any parsed peer token. Equal exact
tokens prove same-invocation self evidence; different non-null tokens prove a real
concurrent peer claim; an absent/unreadable token remains UNKNOWN. This classification
must not add sleeps/retries, kill carriers, or weaken same-lane exclusion.

Every formal Experience start is authority-gated twice: fresh `project_context` for
the exact canonical owner worktree MUST be `:workspace` / `workspaceWrite`, and the
formal `agent_start` task card MUST bind `permissionProfile=:workspace`. A read-only,
missing, ambiguous, or mismatched formal authority is a #399 / PR #461 provider
failure: no product implementation, no launch storm, no Desktop Commander fallback,
and no permission widening. The installed provider contract supports two concurrent
Codex formal Experience owners; a backend formal-agent concurrency limit of one is a
provider-capacity regression, not a Startrips one-slot policy.

`lib/ci_observer.py` records failure evidence by lane, assertion, fixture,
viewport/DPR and stage, keyed by run/attempt/job. Repeated families require root
cause and sibling-assumption review through an existing issue, not timeout/retry
inflation. Only established infrastructure signatures permit one exact-owner,
exact-SHA targeted job rerun; an uncertain POST is never replayed. A rerun passing
is evidence for that attempt, not proof that a recurring failure is harmless.
Capture CI with `init.sh ci`; validate only currently listed evidence, not every
historical file in an artifacts folder. Source and final evidence stay distinct.

Run `python -B lib/policy_audit.py .` before local startup. New recurring prompts
contain only role/authority/entrypoint, never a current PR/SHA/next-action snapshot.
The existing LOCAL Backend startup entry is `start-local-worker.ps1 -Mode Check`
(read-only) or `-Mode Resume` (explicitly clears the user's two Backend STOP markers
and starts the existing Backend launcher). Experience has no resident supervisor:
its scheduled worker starts exactly one bounded execution through `launch-experience.sh`,
which publishes lane/token identity and directly execs the shared run-loop. Do not
wrap a real Experience run in `bash -c "... run-loop.sh"`; that wrapper is not an
execution carrier. Scheduled, outage and boundary restarters never clear a user-owned
STOP; failed recovery keeps scheduled observation enabled.


This workspace runs Startrips as an evidence-gated, one-feature-per-loop workflow.
The goal is not maximum code output. The goal is durable progress without product drift.

## Workspace

```text
D:/startrips/loop-workspace/
├── CLAUDE.md                       this file
├── README.md
├── init.sh                         baseline, smoke and evidence commands
├── run-loop.sh                     builder -> evaluator -> record loop
├── loop-supervisor.sh              quota-aware supervisor
├── launch-supervisor.sh            detached launch wrapper
├── scheduled-restart.sh            one-shot delayed restart
├── restart-at-boundary.sh          stop at the next iteration boundary, then relaunch
├── feature_list.json               the implementation contract
├── claude-progress.md              persistent handoff log
├── lib/intake.sh                   issue intake, shared by run-loop.sh and init.sh
├── .claude/agents/startrips-evaluator.md
├── .claude/agents/startrips-triage.md
└── startrips/                      managed clone of U2SG/startrips, base branch main
```

Override the clone path with `STARTRIPS_DIR`. Loop logs live at `D:/startrips/loop-logs/`
(`LOOP_LOG_DIR`), deliberately **outside** this repo so a builder's git operations cannot clobber
them.

`D:/startrips/startrips` and everything under `D:/startrips/worktrees` belong to the human
maintainer. This loop never touches them.

## Authority order

1. The GitHub issue referenced by the active feature — the product source.
2. `feature_list.json` — the ordered implementation contract and its acceptance evidence.
3. `D:/startrips/CLAUDE.md` and `startrips/CONTEXT.md` — repository conventions and the domain language.
4. This file — loop procedure.
5. Existing code, tests and Git history.

Do not reinterpret a lower source to override a higher one.

## Domain language

`startrips/CONTEXT.md` is required reading before naming anything. Atlas, Journey, Route,
Route Point, Route Segment, Stop, Route Point Media and Place Label are the vocabulary.
**Never** introduce "memory", "city visit", "location" or "gallery" into product code, identifiers,
tests or user-facing copy.

## Start every loop

Before changing code:

1. Run `pwd`.
2. Read the selected feature, its dependencies and the latest relevant progress; do not ingest all history.
3. Read `feature_list.json` and take exactly the one feature `run-loop.sh` selected:
   - `passes` is false;
   - status is eligible under the existing selector; `ready_for_eval` means evaluation, not implementation;
   - every dependency has `status == "passed"` (i.e. merged into `main`);
   - `human_gate` is null.
4. Read the referenced issue in full: `gh issue view <n> --repo U2SG/startrips --comments`.
   A later comment often supersedes the body — #16, #38 and #65 all do. Comments newer than the
   feature's `issue_snapshot_at` are this round's clarifications: apply them, or block on the
   conflict, and then advance the snapshot — see *Issue update tracking*.
5. `git -C startrips log --oneline -10` and `git -C startrips status --short`.
6. Run `./init.sh baseline-smoke` and keep the log. It writes a stamped,
   `EXIT=`-terminated log straight under `.agent-artifacts/`, deliberately outside any feature
   directory — a baseline pins the **pre-feature** head, so `evidence-check` must never grade it.
7. If the baseline is broken, fix only the baseline regression or record a blocker.
   Never stack a feature on a broken baseline.

## Issue intake

The queue is not hand-maintained. At the start of every iteration, right after
`reconcile_merge_state` and **before** `next_feature` selects anything, `run-loop.sh` runs
`intake_new_issues` (`lib/intake.sh`).

**Candidates.** Open issues in `U2SG/startrips` whose number appears in no feature's `issue`
field and in no `.agent-artifacts/intake/skipped.json` entry, `[P0]`- then `[P1]`-titled first and
otherwise oldest first, at most `rules.intake.max_per_iteration` (3) per iteration. An issue labelled
`no-loop` (`rules.intake.skip_label`) is never a candidate — that label is how a human keeps an issue
out of the queue permanently without arguing with the harness.

**Triage.** One headless `startrips-triage` session per candidate. That agent is read-only. It
reads this manual, `startrips/CLAUDE.md`, `startrips/CONTEXT.md`, the issue in full and a compact
direct projection of the authoritative `feature_list.json` (identity/placement/gate fields only),
then expands only the proposed anchor/dependency/sibling rows it actually needs. Never dump the
whole raw ONE into model context; the projection is ephemeral evidence, not a second backlog. It
verifies the claimed gap against the real code and returns one JSON object between `<<<INTAKE` and
`INTAKE>>>`. It never comments, creates or writes; the parent applies the decision.

**Placement.** The triage output carries a `placement` block — an existing feature as `anchor`,
`before` or `after`, and a rationale. Placement follows the problem area and the code the feature
builds on:

| Problem area | Anchor |
| --- | --- |
| Sharing, share grants, guest viewer (#200 family) | after the latest sharing feature it depends on, ST-001..ST-005, with that feature as a dependency |
| Journey Playback, Quick Recap, narrative timing, prefetch, AutoEdit validator | ST-009..ST-011; no dependency unless it touches the trim contract, then ST-009 |
| Globe rendering, high zoom, anchors, labels, coastline | ST-006 / ST-007 / ST-013 / ST-014 |
| Story viewer, mobile mode, media compositor | ST-008 / ST-012 |
| Media placement, EXIF, uploads | ST-015 / ST-016 |
| Server routes, auth, logging | ST-017, or ST-001 when share-related |
| Process, repository policy, CI | ST-000 / ST-018 |

A P0/P1-titled regression against code already on `main` outranks new features: it anchors
`before` the lowest-priority-number `pending` feature that is not `in_progress`, i.e. the entry
`next_feature` would otherwise pick, and because intake runs before selection it is built in the
same iteration. A question, design proposal or product decision becomes a feature with a
`human_gate` naming exactly what the owner must decide. An issue already fixed on `main`, or a
duplicate, becomes a skip citing the PR or the issue.

**What the loop assigns.** `id` (`ST-` plus the zero-padded next number), `target`, `issue`,
`status=pending`, `passes=false`, `attempts=0`, empty `evidence`/`pr_links`, a
`notes` line beginning `auto-intake <UTC timestamp>:`, and `priority` = anchor priority -0.5 for
`before` / +0.5 for `after`. Fractional priorities are intentional: `next_feature` sorts
numerically. A collision is nudged 0.01 at a time **toward the anchor**, so the requested
before/after relation survives every nudge. This step only ever appends: it asserts that every
pre-existing feature object is byte-identical before it writes. Rewriting an existing entry is
the separate, narrower amend path in *Issue update tracking* below, which applies to an
`auto-intake` entry that is still `pending` and to nothing else.

**Rejected output.** An anchor or a dependency that does not exist, fewer than three acceptance
items, or a missing marker block makes the whole output invalid: the issue is recorded in
`skipped.json` with the exact reason `triage output invalid` and **no comment is posted**, because
a malformed harness turn must not speak for the product. That one reason is a harness failure a
human clears by deleting the entry; the product reasons (duplicate, already fixed, not actionable,
needs the owner) are permanent by design.

**Overriding a placement.** A human may edit `priority` and `dependencies` of an **auto-intake**
feature before it starts, and must extend its `notes` to say so. This is the only exception to the
immutable-field rule and applies to auto-intake entries only — never to a hand-written feature, and
never once the feature is `in_progress` or later.

**Manual entry point.**

```bash
./init.sh intake                  # the same step the loop runs
./init.sh intake 86               # exactly one issue
./init.sh intake 86 --dry-run     # triage and print the decision; writes nothing, posts nothing
```

**Durability caveat.** `skipped.json` and `decisions.log` live under the gitignored
`.agent-artifacts/intake/`. A re-clone or a cleaned artifacts directory loses them, so previously
skipped issues get re-triaged and commented a second time. Apply the `no-loop` label instead when
the exclusion has to survive that.

## Issue update tracking

An issue keeps moving after it is queued, so a feature is a snapshot with a date on it. Every entry
that carries an `issue` also carries two **mutable** fields — `issue_snapshot_at` (the issue's
`updatedAt` at the last reconcile) and `issue_snapshot_comments` (its comment count then) — and
`run-loop.sh` runs `intake_reconcile_issues` (`lib/intake.sh`) right after `intake_new_issues`,
before `next_feature`. Both halves share ONE per-iteration session budget
(`rules.intake.max_per_iteration`, 3), and new issues spend it first: a fresh P0/P1 regression
being built in the iteration it was triaged outranks an amend, which loses nothing by waiting one
iteration. A backfill, a curated note and plain snapshot bookkeeping cost no session at all.

What a move means depends on the **status** of the mapped feature:

| Feature state | What intake does |
| --- | --- |
| No snapshot yet (every hand-written ST-000..ST-020) | Backfill both fields from the live issue on the first run, **without** re-triaging — they are the owner's curated contract. Recorded in `decisions.log`. |
| `pending`, `notes` start with `auto-intake` | One `startrips-triage` session in **amend** mode; it may replace `acceptance`, `dependencies`, `human_gate`, `description` and the placement, or answer `unchanged`, or report the issue moot. One comment on the issue when it amends. |
| `pending`, curated | Never rewritten. The update goes to `decisions.log`, a note is appended to the feature's `notes`, and a line lands in `claude-progress.md` under `### Needs owner attention`. Nothing is posted to GitHub. |
| `in_progress`, `needs_work`, `ready_for_eval` | Nothing at all, **including the snapshot** — see the builder rule below. |
| `passed`, issue OPEN and moved again | One follow-up feature through the normal triage path, placed `after` the passed feature with it as a dependency, `notes` starting `auto-intake follow-up of <id> (issue reopened)`, and one comment naming the new id. |
| `blocked` | Snapshot bookkeeping plus a `### Needs owner attention` line. A builder blocks a feature and posts ONE question on the issue when a comment contradicts the acceptance, so activity on a blocked entry's issue is usually the answer — and only a human unblocks it. |
| `ready_to_merge`, `cancelled_by_product_decision`, closed issues | Snapshot bookkeeping only. |

**A follow-up is decided per ISSUE, not per feature.** #200 alone maps to ST-001..ST-005, so the
follow-up would otherwise fire when the first of them merged, for work the other four already
cover. It fires only when **every** feature mapping that issue is terminal (`passed`, `blocked`,
`cancelled_by_product_decision`) and none of them already carries `reopen_handled_at`, and then only
for the lowest-priority `passed` one; the rest get bookkeeping. When it fires, `reopen_handled_at`
is written to every feature on that issue, so no sibling can trigger a second one. The follow-up
entry itself maps to the same issue, so while it is unfinished it suppresses further follow-ups by
the same rule.

The snapshot advances on `unchanged` and on the curated-note path too. An `updatedAt` bump from a
label, an assignee or a title edit is a move; if it did not advance the mark, that issue would
re-triage every iteration forever and eat the whole budget.

**The builder owns the in-flight window.** When the selected feature carries an `issue`, the
builder runs `gh issue view <n> --repo U2SG/startrips --comments` at the **start** of its round and
treats every comment newer than `issue_snapshot_at` as a clarification:

- it applies the ones that do not contradict the immutable `acceptance`;
- if one **does** contradict the acceptance, it sets the feature `blocked` with the conflict in
  `notes`, posts exactly ONE comment on the issue asking the owner to confirm which reading holds,
  and stops the round there — it does not pick a reading itself;
- once it has read that window, it advances `issue_snapshot_at` and `issue_snapshot_comments` to
  the issue's current values in the same feature-state write.

Intake deliberately does not advance those fields for an in-flight feature. The mark moves only
when someone has actually consumed the comments, so the window is exactly one round, a crashed or
quota-stopped round re-reads the same comments, and an iteration in which that feature is not the
one selected cannot silently swallow a whole batch of owner clarifications.

**Amend limits.** An amend applies only to a `pending` auto-intake entry. It must carry a
`rationale`, may touch only `description` / `dependencies` / `acceptance` / `human_gate` /
`placement`, must keep at least three checkable acceptance items, and must not widen scope beyond
the issue; the write is guarded so every other feature stays byte-identical and the amended entry
changes only within that key set. A malformed amend turn changes nothing, posts nothing and does
**not** advance the snapshot, so the next iteration retries it. An amend session reporting the
issue as moot does **not** cancel the entry: the loop records it, notes it and flags it for the
owner, because deleting queued work is never automatic.

**Manual entry point.**

```bash
./init.sh intake-check --dry-run    # list every mapped issue and what would happen to it;
                                    # writes nothing, posts nothing, starts no session
./init.sh intake-check              # NOT read-only: this RUNS the reconcile — it can start triage
                                    # sessions, write feature_list.json and comment on issues
```

## One feature only

Allowed narrow supporting work: a missing test helper the feature needs, or a small refactor
strictly necessary to implement it safely.

Not allowed: opportunistic redesign, unrelated cleanup, dependency upgrades, changing product
requirements to match the implementation, or editing another feature's immutable fields.

## Cross-Feature Assumption Audit (#198)

Every feature change carries a CFAA. It answers two questions:

> What did this change make **variable** that older code assumed was **fixed**?
> Which previously-correct subsystem now receives inputs it was never designed for?

The high-risk dimensions, from the repo's own regression history: scale/zoom/projection;
layout mode and safe area; time/tempo/playback rate; media type and content topology;
focus/ownership/async revision; semantic reveal and data coverage; rendering layers and occlusion.

The audit goes in the PR body as a `Cross-feature assumption audit` block naming the changed
dimension, the invalidated assumption, and the sibling subsystems actually checked. Restating
the feature is not an audit.

**Regression-family search (P0/P1 regressions).** When the feature fixes a P0 or P1 regression,
fixing the reported symptom does not close it. Before the PR is considered complete, enumerate the
sibling subsystems that share the failed assumption (the #193 -> #196 pattern), check each one, and
record the result in the PR body under `Regression-family search:`. A confirmed sibling defect of the
same class that is trivially in scope is fixed in the same PR; any other confirmed sibling becomes a
normal actionable issue — `gh issue create --repo U2SG/startrips` with a `[P1]` or `[P2]` title prefix,
the failed assumption, the affected subsystem and the evidence, at most two new issues per feature — or
a comment on the existing issue when one already covers it. A finding that lives only in
`claude-progress.md` or a PR paragraph does not count; #198 requires it to become an issue.

## Branch and PR policy

- Base branch is `main`. Never push to it.
- Branch names: `fix/issueNNN-<slug>-YYYYMMDD`, `feat/issueNNN-<slug>-YYYYMMDD`, `chore/` for pure
  cleanups. One branch and one PR per feature.
- The moment `gh pr create` returns, write the PR URL into the feature's `pr_links` in a
  feature-state write of its own — before `./init.sh ci`, the ledger commit or any review wait. A
  round that dies later still leaves the PR mapped, and the next round takes the existing-PR path
  instead of opening a duplicate (ST-010 / PR 256 and ST-042 / PR 257 were both left unmapped by
  interrupted rounds on 2026-09-07).
- Commits: imperative headline, **no** issue number in the headline, **no** `Co-Authored-By` or any
  other trailer. Code commits contain only production code and tests — no plans, no findings, no
  artifacts.
- PR body:
  1. first line `Fixes #N.` or `Addresses #N.`;
  2. 2-4 sentences of what and why;
  3. the `Cross-feature assumption audit` block;
  4. a `Local validation:` line stating exactly what ran here and what is delegated to CI.
- **The loop never merges and never applies the `merge-ready` label.** The repo's `merge-readiness`
  workflow is an explicit human sign-off gate (`CONTRIBUTING.md`): the maintainer applies
  `merge-ready` as the final action after review and CI. After an evaluator PASS the feature
  becomes `ready_to_merge` and the loop moves on. `run-loop.sh` reconciles the real GitHub state at
  the start of every iteration — only exact merge containment in freshly green main push CI becomes `passed`;
  closed-unmerged returns for owner disposition.
- A dependent feature waits for its parent to be **merged**, not merely `ready_to_merge`. Branching
  a dependent off `main` before the parent lands cuts it from a baseline that lacks the parent's code.
- Rebase and Source/final decisions follow the Effective control-plane protocol in `CLAUDE.md`.
  An old base SHA by itself is not a blocker. Never discard the owner's changes.

## The PR ledger

Read `startrips/docs/pr-history/README.md`; it is the contract. In short:

- once the PR number is known, add `docs/pr-history/<PR>.md` with each required field present
  exactly once: `Source head`, `Scope`, `User-visible change`, `Review fixes`, `Follow-up`, `Validation`;
- `Source head` is the full SHA of the final **code** commit;
- the ledger commit is the **LAST** commit and adds no other file — CI checks that
  `Source head..PR head` contains nothing else;
- if code lands after the ledger, add a **new** ledger commit with the updated `Source head`;
- valid UTF-8, no mojibake, and — this is Windows — never let a carriage return end up inside a
  field line;
- validate before pushing:
  `node scripts/pr-history.mjs validate-all` and
  `node scripts/pr-history.mjs validate-pr --pr <N> --base <merge-base with origin/main> --head <HEAD>`.

## Verification

**Every test runs in GitHub Actions and nowhere else.** This is a product-owner rule, not a
capability limit: do not run `pnpm test`, `pnpm vitest`, a dev server, a browser, Playwright,
docker or PostgreSQL locally, and never present a local run as evidence.

Local validation is exactly:

- `pnpm typecheck`
- `git diff --check`
- `node --check` on any script you touched
- `node scripts/pr-history.mjs validate-all` / `validate-pr`

i.e. `./init.sh smoke`.

CI is the authority. `.github/workflows/ci.yml` runs `ledger`, `core` (PostgreSQL 17, migrations,
typecheck, the full test suite, build) and three `browser-qa` lanes, all gated by `verify`.
Evidence for behaviour is `./init.sh ci <feature-id> <PR>`, which captures `gh pr checks` plus the
run URLs into a head-stamped log ending in `EXIT=<code>`.

Rules that exist because they were learned the hard way:

- **Capture every submitted-head artifact with `./init.sh evidence-run <id> <log-name> <cmd...>`.**
  It refuses a dirty tree, stamps `EVIDENCE_HEAD` and the branch into the log, and appends the log's
  own `EXIT=`. Then run **`./init.sh evidence-check <id>`**, which goes red if a later commit moved
  the head out from under a recorded log. If it is red, re-capture; do not explain the gap in prose.
  Do **not** use `evidence-run` for a baseline capture — use `./init.sh baseline-smoke`, which pins
  the pre-feature head on purpose and stays outside `evidence-check`'s reach.
- `evidence-check` compares the stamped **branch** as well as the stamped SHA. Right after
  branching, a feature branch and `main` share a HEAD, so a SHA-only check would accept a log
  captured on the wrong branch.
- **Never record an in-flight log as evidence.** A log with no `EXIT=` line is not evidence.
- **Capture CI evidence as the LAST step**, after every review-fix commit, not before.
- **Distinguish a CI outage from a code failure before touching code.** Jobs cancelled with zero
  executed steps, every job failing at an identical duration, or
  `Failed to resolve action download info` / `Service Unavailable` in the logs is GitHub
  infrastructure. Re-run with `gh run rerun <id> --failed` and wait. Do not "fix" code for it.

Save evidence under `.agent-artifacts/` and record the exact paths in `feature_list.json`.
A code diff, a unit test alone, or a builder summary is not sufficient evidence for user-visible
behaviour.

## Review threads

Use the Effective control-plane protocol in `CLAUDE.md` and the read-only
`lib/github_evidence.py review` command. Thread resolution, effective review and
API uncertainty have one definition there. A reply-count proxy is forbidden.
Review silence does not prove independent Maintainer approval. A wait for external
review/CI is not a feature failure and does not consume implementation attempts.

## Headless session discipline

The builder and evaluator run as non-interactive `claude -p` sessions: the session ends when your turn ends,
and nothing you left in the background survives it. Never delegate waiting to a background task, monitor or
watch. Wait synchronously and bounded instead: `gh pr checks <PR> --repo U2SG/startrips --watch --interval 30`
(cap it at about 15 minutes), then capture `./init.sh ci <id> <PR>` only once every lane has a terminal state.
Before your final message the feature object must already carry `pr_links`, every `evidence` path and the new
`status`, and `claude-progress.md` must have your entry; an evaluator that finds them missing returns NEEDS_WORK
no matter how good the code is.

## Repository hard constraints

These break the build or the product:

1. `server/db/auth-schema.ts` is **generated**. CI runs `pnpm auth:schema` then
   `git diff --exit-code` on it. Any change to `server/auth.ts` must be followed by regenerating
   and committing that file.
2. Migrations are **drizzle-kit generated**: edit `server/db/app-schema.ts`, run `pnpm db:generate`,
   commit the new `server/db/migrations/NNNN_*.sql` and its `meta/` snapshot. Not hand-written SQL.
3. `src/main.tsx` fronts two unrelated applications. The product is `LivingAtlasApp`
   (`src/journey/*`, `src/scene/*`, `server/*`). The `?qaState=` art-archive experience
   (`src/App.tsx`, `src/components/Archive*`, `src/experience/*`) is legacy. "Fix the timeline"
   means `JourneyTimeline.tsx`, not `ArchiveTimeline.tsx`.
4. `STORAGE_DRIVER=disabled` and `LOCATION_SEARCH_DRIVER=disabled` must degrade **truthfully** —
   no mock search results, no fake persistence.
5. Atlas access is derived from `session.session.activeOrganizationId` through
   `server/authorization/atlas-access.ts`, never from a client-supplied ID.
6. The Vite proxy uses `changeOrigin: false` on purpose so browser and API share one origin and
   session cookies stay first-party. Do not "fix" it.

## Feature state writes

The builder may change only mutable fields: `status` (`pending` -> `in_progress` ->
`ready_for_eval`, or `blocked`), `attempts`, `evidence`, `pr_links`, `notes`, timestamps, and
`issue_snapshot_at` / `issue_snapshot_comments` once it has read the issue's new comments.

The builder MUST NOT set `passes=true`. Independent Hourly Review owns evaluation and
`ready_to_merge`; only the exact-main merge-state reconcile promotes
`ready_to_merge` to `passed`. The same reconcile also promotes a feature the builder still owns
(`pending`, `in_progress`, `needs_work`, `ready_for_eval`) to `passed` only after exact merge/main-push-CI proof for its
`pr_links` PR: the owner may merge ahead of the evaluator, and delivered work must never
be selected again.

Adding a feature is a `run-loop.sh` action, not a builder action: only the intake step appends
entries, and only to the end of the array. A builder never adds, removes or reorders a feature.

Never delete a failing feature or weaken its acceptance criteria to make it pass.

## End every builder loop

1. Leave `startrips/` runnable and reviewable.
2. Preserve `in_progress` for a submitted Source awaiting CI/review; use the evidence-derived SEAL/HANDOFF steps. Only validated final handoff becomes `ready_for_eval`.
3. Append to `claude-progress.md`: feature ID; factual changes; commands actually run and their
   results; evidence paths; PR/commit links; unresolved risks; the exact next action.
4. Commit the workspace state (feature file + progress log) with a descriptive message including
   the feature ID. No trailers.
5. Do not declare the feature done. It still needs independent evaluation.

## Human gates

Do not autonomously decide:

- product pacing values and over-budget behaviour (ST-010, ST-011);
- repository settings — branch protection and rulesets are the owner's (ST-018);
- visual direction for a new globe-wide visual system (ST-020);
- applying `merge-ready`, merging, or deploying anything.

Complete the reversible preparation, mark the feature `blocked` with the exact question, and
continue with another eligible feature.

## Safety

- Never commit secrets, production data or deployment configuration.
- Never log a share token, a signed URL or an access token.
- Cap automatic retries; reuse cached artifacts by stable key.
- Stop at the next iteration boundary if `AGENT_STOP` exists at the workspace root. A sentinel does
  not interrupt a builder that is already running; that needs a real process kill.

## Definition of done

A feature is done only when: every acceptance criterion is implemented and evidenced; CI is green
on the submitted head; the ledger is present and valid; all review threads are resolved and effective reviews are clear; the
fresh-context evaluator returns PASS; and the maintainer's `merge-ready` sign-off has merged the PR,
whose exact merge is contained in a verified exact-green main push before reconciliation records `passed`.

### Bounded no-progress execution

`lib/progress_budget.py` records model-execution evidence under the existing
`.agent-artifacts/evaluations/` directory. After `MAX_NO_CHANGE` successful model
turns with identical content/evidence input and no progress, the loop returns
`WAIT_PROGRESS` without starting another model. Existing scheduled observation
continues. A real Source/content, current CI attempt, review or action change
unlocks a fresh budget; restarting the supervisor or rewriting prose does not.
This is not feature status, ownership, a dispatch queue or a second lock.
Intake amend results carry their pre-model row token through application; user
changes during the model round invalidate the entire old result, including
unchanged/moot snapshot bookkeeping. Handoff capture and final revalidation bind
Source, final head and exact CI run/attempt to one independent-review decision.

Urgent discovery is not bulk replenishment: when legitimate registered work exists,
intake only considers unqueued P0/P1-titled candidates within the existing per-round
budget. It does not preempt a live owner or bypass dependencies/gates. A failed API,
missing response or invalid candidate document returns UNKNOWN, never an empty
queue verdict; that error propagates through the supervisor and wake hook.
