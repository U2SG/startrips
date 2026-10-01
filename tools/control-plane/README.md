# Startrips Agentic Loop Workspace

A long-running, evidence-gated builder/evaluator loop over one managed clone of
`U2SG/startrips`. `CLAUDE.md` is the operating manual; this file is the runbook.

## The five core files

1. `CLAUDE.md` — operating manual and policy.
2. `feature_list.json` — the default-fail implementation contract.
3. `init.sh` — baseline, smoke, evidence and CI-capture commands.
4. `run-loop.sh` — issue intake -> builder -> evaluator -> record, with merge-state reconcile.
5. `claude-progress.md` — persistent handoff log.

`.claude/agents/startrips-evaluator.md` is the fresh-context, read-only evaluator;
`.claude/agents/startrips-triage.md` is the read-only intake reasoning rubric used by the recurring
Orchestrator (never a child-agent launch); `lib/intake.sh` plus `lib/intake_json.py` are the canonical
verdict-validation/apply boundary both
`run-loop.sh` and `init.sh` call.
`loop-supervisor.sh` / `launch-supervisor.sh` / `scheduled-restart.sh` run it unattended.

## Setup

The managed clone lives at `startrips/` (already cloned, base branch `main`); override with
`STARTRIPS_DIR`. Logs go to `D:/startrips/loop-logs/`; override with `LOOP_LOG_DIR`.

```bash
cd /d/startrips/loop-workspace
./init.sh status
./init.sh bootstrap    # pnpm install --frozen-lockfile, only if node_modules is missing
./init.sh smoke        # typecheck + git diff --check + ledger validation
./init.sh baseline-smoke   # the same, captured to a stamped .agent-artifacts/smoke-<ts>.log
```

## Launch

Windows: **only** through the wrapper, and hand `Start-Process` nothing but the script path —
reassembly eats a `bash -c "... > log 2>&1"` redirection and the supervisor exits with an empty log.

```bash
cd /d/startrips/loop-workspace
# PowerShell: .\start-local-worker.ps1 -Mode Check
# Explicit user Resume: .\start-local-worker.ps1 -Mode Resume
# Scheduled launchers never remove human STOP markers.
```

Foreground, one bounded run:

```bash
STARTRIPS_LANE=backend MAX_ITERATIONS=5 ./run-loop.sh
```

Re-evaluate an already-built feature without re-running the builder (use after an evaluator
platform error, so a new builder push cannot invalidate the head the evidence pins):

```bash
STARTRIPS_LANE=backend EVAL_ONLY=1 ./run-loop.sh
```

## Stop

A sentinel only takes effect at the next iteration boundary; it does **not** interrupt a builder
that is already running.

1. `touch AGENT_STOP SUPERVISOR_STOP`
2. Walk the process tree and check the full command line of each candidate
   (`Get-CimInstance Win32_Process`) — confirm the innermost `claude -p ...` really is the loop's
   builder and not your own interactive session.
3. `taskkill /PID <n> /T /F` each one, then re-check for zero residue. MSYS bash's `exec` does not
   reuse the native Windows PID, so a `/T` cascade can break mid-chain.
4. Verify the scene: `feature_list.json` not left dirty, `git -C startrips status --porcelain`
   clean and on `main`.
5. Record what you found in `claude-progress.md` and commit it.

## Inspect

Never repeat the builder's own claim. Cross-check:

```bash
python3 -c "import json;d=json.load(open('feature_list.json',encoding='utf-8'));print(sum(1 for f in d['features'] if f['status']=='passed'),'/',len(d['features']))"
gh pr list --repo U2SG/startrips --state open
gh pr checks <N> --repo U2SG/startrips
tail -f /d/startrips/loop-logs/run-*.log
```

For every PR in a feature's `pr_links`, check the real CI state and that every review thread has
been resolved, and verify effective reviews on the observed head. Use
`lib/github_evidence.py review`; independent review is not inferred from an empty backlog.

## Issue intake

Every iteration, right after merge-state reconcile and **before** feature selection,
`run-loop.sh` performs bounded candidate discovery and mapped-issue reconciliation. The control-plane
shell never starts a model/provider process for intake.

The recurring Development Orchestrator owns the read-only reasoning turn in its **current session**.
It uses Codexless to read the full issue, relevant code/Git history and a compact projection of the
sole ONE, following `.claude/agents/startrips-triage.md` as a rubric only. It then supplies one
ephemeral verdict envelope to the canonical intake boundary:

```json
{"issue":86,"mode":"new","issue_snapshot_at":"<updatedAt>","issue_snapshot_comments":0,"verdict":{...}}
{"issue":86,"mode":"amend","feature":"ST-123","feature_row_token":"<64-hex row token>","issue_snapshot_at":"<updatedAt>","issue_snapshot_comments":0,"verdict":{...}}
{"issue":86,"mode":"followup","feature":"ST-123","feature_row_token":"<64-hex row token>","issue_snapshot_at":"<updatedAt>","issue_snapshot_comments":0,"verdict":{...}}
```

`lib/intake.sh` binds every envelope to the exact issue revision/comment count the Orchestrator
reasoned over; amend/follow-up also bind the exact mapped ONE row token. It re-reads both immediately
before apply, and follow-up rechecks the row token again inside the append transaction. Known drift
discards the verdict without mutating ONE; unreadable evidence remains UNKNOWN. Only then does intake
materialize the existing `<<<INTAKE ... INTAKE>>>` input consumed by `intake_json.py`. The existing
safe-store transaction still assigns the ST id/priority, validates placement/dependencies/acceptance
and performs the only ONE write. A missing verdict is a normal defer: it spends no intake budget,
writes no skip, changes no ONE bytes and does not abort the loop. A mismatched/invalid envelope fails
closed.

Candidates remain open issues that no feature already references and that are not in
`.agent-artifacts/intake/skipped.json`, with `[P0]` then `[P1]` titles first and otherwise oldest
first, bounded by `rules.intake.max_per_iteration` (3). `no-loop` remains the durable human
exclusion.

Mapped issue movement is still status-aware: backfill missing snapshots, consume an external amend
verdict only for pending auto-intake entries, preserve curated/in-flight owner state, or consume one
external follow-up verdict after a passed feature when a genuine residual gap exists. New/amend/
follow-up applications share the same bounded intake budget; candidates without verdicts do not
consume it.

Manual/control-plane entry points:

```bash
./init.sh intake-candidates
./init.sh intake 86 --verdict-file .agent-artifacts/intake/verdict-86.json
./init.sh intake 86 --verdict-file .agent-artifacts/intake/verdict-86.json --dry-run
./init.sh intake-check --dry-run
./init.sh intake-check --verdict-dir .agent-artifacts/intake/verdicts-current
```

Verdict files/directories are caller-owned ephemeral evidence for one invocation, not another queue,
owner registry or routing table. Every envelope binds `issue`, `mode`, `issue_snapshot_at` and
`issue_snapshot_comments` to the exact GitHub evidence used for reasoning; `amend` and `followup`
also bind `feature` and the exact `feature_row_token` from ONE. Intake rejects a missing/mismatched
binding as stale, re-reads the issue and mapped row immediately before apply, and keeps the existing
in-transaction row guard for the final write. A raw intake candidate without such a verdict is
Orchestrator work, not a LOCAL Backend wake condition; only a resulting registered Backend feature
can wake the dedicated Backend hook.

Audit state remains `.agent-artifacts/intake/decisions.log`, the validated per-invocation triage log
and `skipped.json`. Use the `no-loop` label when exclusion must survive artifact cleanup.

### Concurrent amendment deferral

A readable row that changed after its exact pre-model snapshot rejects the model
result with internal intake code 10. The amend caller records `amend-deferred`,
adds only that feature to the existing invocation-local `FEATURE_SKIP`, and lets
the same canonical selector consider other work. No ONE status, attempt, gate,
issue snapshot or product decision is changed by the rejected result. There is
no immediate model replay; a fresh invocation re-reads ONE and the live issue.
The same rule covers row drift before the later unchanged/moot snapshot write.
Result artifacts are invocation-specific, so a peer cannot supply the verdict.

Missing/malformed snapshot identity, unreadable ONE, write failures, unknown
process/provider evidence and API failures are not known row drift: they remain
fail-closed and retain the existing transient-failure path. This is not a blanket
StoreConflict catch, a shorter supervisor retry, or permission to reuse old data.

## Delivery packages

Ordinary ST rows remain fully supported. A coherent multi-issue unit is registered only after the
package-aware runtime is exact-byte activated and verified; it is never represented by another
backlog. The lead ST is the single selector/owner/PR identity and every member row remains in ONE.

```bash
# Read-only runtime verification; packages stay disabled if this fails.
python -B lib/delivery_runtime.py verify . --repo U2SG/startrips

# Guarded registration of a fresh same-lane set. The first id is the lead.
python -B lib/delivery_package.py register feature_list.json ST-150 ST-151 ST-152 \
  --lane experience --root . --repository startrips --repo U2SG/startrips

# Observe exact membership/contract and execution token.
python -B lib/delivery_package.py show feature_list.json ST-150

# A material issue/scope change is one atomic package revision. Optional JSON files
# map member ids to acceptance/description/dependency/gate patches and exact comment ids.
python -B lib/delivery_package.py revise feature_list.json ST-150 \
  --scope-json scope.json --decisions-json decisions.json --repo U2SG/startrips
```

Do not register an active/dirty/open-PR member. Internal dependencies stay in the original rows and
are implemented in topological order inside the Source; external dependencies must already be
complete. Intake never amends a registered member independently. Selector/provider accounting
counts the lead once and suppresses non-lead claims. One independent Source review covers the
complete changed-file set and carries per-member acceptance evidence; one ledger-only final records
the delivery contract. Exact green resulting main promotes every member together or none.

Package source activation is a separate safe-boundary operation. `delivery_runtime.py plan` records
expected installed hashes, exact Source CI must be green, and `activate` refuses live owners,
external execution, human STOP or drifted runtime bytes. A valid activation receipt is installation
evidence only, never an owner or queue.

## Merge policy

**This loop never merges.** The repo's `merge-readiness` workflow is a human sign-off gate: the
maintainer applies the `merge-ready` label as the final action after review and green CI
(`startrips/CONTRIBUTING.md`).

After an evaluator PASS the feature becomes `ready_to_merge` with its PR recorded, and the loop
moves to the next eligible feature. At the start of every iteration `run-loop.sh` asks GitHub what
actually happened: only exact merge containment in freshly green main push CI becomes `passed`;
closed-unmerged returns to its owner with the reason.
A dependent feature waits for `passed`, never for `ready_to_merge`.

When nothing is eligible but something is `ready_to_merge`, `run-loop.sh` exits **7** rather than 0.
The supervisor treats 7 as "sleep `MERGE_WAIT_S` (default 30 min) and re-reconcile", so a maintainer
merge is picked up without a relaunch. Exit 0 means the queue is genuinely finished.

## Boundary

The loop can prepare code, tests, evidence and PRs. It must not merge, deploy, change repository
settings, decide product pacing values, or choose a visual direction. Those are human gates; see
`CLAUDE.md`.

## Control-plane reliability entrypoints

The single operational definition is `Effective control-plane protocol (2026-09-17)`
in `CLAUDE.md`; other manuals reference it rather than storing current PR/SHA state.
Set `STARTRIPS_LANE` inside the executing bash. `run-loop.sh --next` remains the sole
selector; `--next-action` derives EVALUATE/IMPLEMENT/OBSERVE without claiming work.
`lib/github_evidence.py source --repo U2SG/startrips --pr <N>` binds CODE Source to
its actual one-commit ledger final. API errors exit 6 and never mean a clean gate.
All ONE writes must use `lib/feature_store.py`; the transaction mutex is storage-only.
A writer still executing the legacy code must drain before installing this version.

The code-only distribution and synthetic Windows/Linux CI regressions live in the
product repository under `tools/control-plane/`. It contains no ONE, owner registry,
progress history or dispatch queue. Runtime activation uses exact expected-input
hashes and a safe iteration boundary, never a forced process kill. Preserve any
user STOP and only remove a temporary stop marker whose exact content is yours.

## Local Worker startup after a harness upgrade

From PowerShell in this directory, run `./start-local-worker.ps1 -Mode Check`.
This checks the provider, canonical protocol and target-shell Backend selector but
preserves all STOP markers and starts no worker. Only the local user's explicit
`./start-local-worker.ps1 -Mode Resume` clears AGENT_STOP/SUPERVISOR_STOP, never a
CANCEL_SCHEDULED_RESTART marker, and invokes the existing LOCAL Backend launcher.

Read `run-loop.sh --plan` for live evidence-derived next action. The offline
`--next-action` hint is not an instruction to implement. Source-review evidence is
produced by Hourly Review according to CLAUDE.md, not by an owner acknowledging a
comment. All code/behavior regressions execute in GitHub CI; local startup checks
are static and non-destructive provider/evidence probes.


## Windows native execution snapshots

The existing `lib/execution.py occupied/check/identity` provider now reads the
native process table and query-only process handles instead of the intermittently
stalled Win32_Process CIM service. Toolhelp supplies candidate name/parent/PID;
GetProcessTimes and bounded ProcessCommandLineInformation reads bind the same
handle to creation time and actual command line. No PEB offsets, debug privileges,
process termination, extra dependencies, cached empty occupancy or WMI fallback.
The read-only child has the same 25-second maximum. Access denied, incomplete
native ABI/buffer, PID birth/reuse during observation and provider failure remain
UNKNOWN. Handles close even on failed reads. Only an exact signalled handle or a
fresh complete table proving a vanished PID permits dropping an exited candidate.
CIM-compatible pid@creation publication (microseconds plus .NET trailing zero and
local UTC offset) preserves existing owner identity during a safe rollout. The
pre-install compatibility probe compares old/new identities; CI exercises a real
native own-PID roundtrip plus synthetic failure boundaries without calling CIM.
No owner/capacity/STOP/selector authorization changes. Runtime installation must
still bind exact source bytes and a safe process boundary; merging is not installing.
