#!/usr/bin/env bash
# Baseline, smoke and evidence commands for the Startrips loop workspace.
#
# Single managed clone (`startrips/`), so there is no FE/BE contract mode: the
# cross-repo artifact comparison the Aidrobe V3 skeleton carried has no analogue
# here. What survives from that skeleton is the part that earned its place —
# head-stamped evidence logs that refuse a dirty tree and always end in
# `EXIT=<code>`, plus the `evidence-check` half that goes red when a later commit
# moves the head out from under a recorded log.
set -euo pipefail

MODE="${1:-smoke}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${STARTRIPS_DIR:-$ROOT/startrips}"
GH_REPO="${STARTRIPS_GH_REPO:-U2SG/startrips}"
ART="$ROOT/.agent-artifacts"
mkdir -p "$ART"

fail() { echo "[st-init] ERROR: $*" >&2; exit 1; }
run() { echo "+ $*"; "$@"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }

need git
need python3
if [[ "$MODE" == "smoke" || "$MODE" == "bootstrap" || "$MODE" == "baseline-smoke" ]]; then
  need node; need pnpm
fi

[[ -d "$REPO/.git" || -f "$REPO/.git" ]] || fail "Startrips clone not found at $REPO"

# Issue intake, shared verbatim with `run-loop.sh`.
# shellcheck source=lib/intake.sh
source "$ROOT/lib/intake.sh"

status() {
  echo "== startrips status =="
  git -C "$REPO" status --short
  echo "== branch =="
  git -C "$REPO" rev-parse --abbrev-ref HEAD
  echo "== log =="
  git -C "$REPO" log --oneline -5
}

bootstrap() {
  echo "== bootstrap =="
  if [[ ! -d "$REPO/node_modules" ]]; then
    (cd "$REPO" && run pnpm install --frozen-lockfile)
  else
    echo "[st-init] node_modules present; skipping install"
  fi
}

# The complete set of checks this workspace is allowed to run locally.
#
# Product-owner rule: EVERY test runs in GitHub Actions and nowhere else. That
# is not a capability limit that smoke works around — no `pnpm test`, no
# `pnpm vitest`, not even the DB-free `src/` subset. Smoke is therefore static
# only: it proves the tree compiles, carries no whitespace damage and has a
# valid ledger set. The `core` and three `browser-qa` CI lanes are the sole
# authority on whether the code works, and every feature's evidence has to say
# so explicitly rather than substitute a local run.
smoke() {
  (cd "$REPO" && run pnpm typecheck)
  (cd "$REPO" && run git diff --check)
  # CLAUDE.md defines local validation as including `node --check` on any script
  # touched this round. Parsing every harness script is cheap and needs no
  # argument plumbing, so smoke covers the clause for whichever files changed.
  (cd "$REPO" && shopt -s nullglob && for script in scripts/*.mjs *.mjs; do
    run node --check "$script"
  done)
  (cd "$REPO" && run node scripts/pr-history.mjs validate-all)
}

#: Written by `evidence-run`, read back by `evidence-check`. The branch is a
#: parsed key rather than a comment on purpose: right after branching, a feature
#: branch and `main` share a HEAD sha, so a SHA-only check would accept a log
#: captured on the wrong branch.
EVIDENCE_KEY="EVIDENCE_HEAD"
EVIDENCE_BRANCH_KEY="EVIDENCE_BRANCH"

evidence_stamp() {
  local out="$1"
  {
    echo "# captured by: ./init.sh ${EVIDENCE_MODE:-evidence-run} (feature ${FEATURE_ID:-?})"
    echo "# at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "$EVIDENCE_KEY=$(git -C "$REPO" rev-parse HEAD)"
    echo "$EVIDENCE_BRANCH_KEY=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  } >> "$out"
}

#: A dirty tree is the whole defect in miniature: the log would name a commit
#: that does not contain what was measured. Refuse rather than annotate.
evidence_require_clean() {
  local dirty
  dirty="$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
  [[ "$dirty" == "0" ]] || fail "startrips tree is dirty ($dirty paths) — commit first, then capture"
}

# Run ANY command into a head-stamped log ending in its own EXIT= line. Use it
# for every artifact a feature submits as evidence, so `evidence-check` can see
# all of them. Do NOT use it for a pre-feature baseline capture: that one is
# supposed to pin the baseline head, and stamping it with the submitted head
# would be a lie evidence-check would rightly fail.
evidence_run() {
  local feature="${1:-}" logname="${2:-}"
  [[ -n "$feature" && -n "$logname" ]] ||
    fail "usage: ./init.sh evidence-run <feature-id> <log-name> <command...>"
  shift 2
  [[ $# -gt 0 ]] || fail "usage: ./init.sh evidence-run <feature-id> <log-name> <command...>"
  FEATURE_ID="$feature"
  EVIDENCE_MODE="evidence-run $feature $logname"
  evidence_require_clean
  local dir="$ART/${feature,,}"
  mkdir -p "$dir"
  local log="$dir/$logname"
  : > "$log"
  evidence_stamp "$log"
  echo "# command: $*" >> "$log"
  local rc=0
  "$@" >> "$log" 2>&1 || rc=$?
  # Its OWN exit code on its own last line. `$?` after the `||` would read 0.
  echo "EXIT=$rc" >> "$log"
  echo "[st-init] evidence: $log (EXIT=$rc)"
  return $rc
}

evidence_check() {
  python3 -B "$ROOT/lib/evidence_capture.py" check "$ROOT" "$REPO" "$1" --repo "$GH_REPO"
}

# CI is the only browser/integration verification this program has, so its
# verdict has to become a file like any other piece of evidence. `gh pr checks`
# exits non-zero while checks fail or are still pending, hence the explicit rc
# capture: under `set -e` the footer would never be written.
ci_evidence() {
  [[ -n "${1:-}" && -n "${2:-}" ]] || fail "usage: ./init.sh ci <feature> <PR>"
  python3 -B "$ROOT/lib/evidence_capture.py" capture "$ROOT" "$REPO" "$1" --pr "$2" --repo "$GH_REPO"
}

# A baseline capture pins the PRE-feature head on purpose, so it must never land
# in a feature's evidence directory: `evidence-check` compares every log there
# against the CURRENT head and would go red the moment the builder commits. This
# writes a timestamped log directly under `.agent-artifacts/`, stamped and with
# the same `EXIT=` footer, but outside `evidence-check`'s reach by construction.
baseline_smoke() {
  local ts log rc=0
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  log="$ART/smoke-$ts.log"
  : > "$log"
  FEATURE_ID="baseline"
  EVIDENCE_MODE="baseline-smoke"
  evidence_stamp "$log"
  echo "# command: ./init.sh smoke" >> "$log"
  {
    bootstrap
    status
    smoke
  } >> "$log" 2>&1 || rc=$?
  echo "EXIT=$rc" >> "$log"
  echo "[st-init] baseline smoke: $log (EXIT=$rc)"
  return $rc
}

# Manual entry point for the intake step `run-loop.sh` runs every iteration.
#
#   ./init.sh intake                     triage the eligible open issues (up to
#                                        rules.intake.max_per_iteration)
#   ./init.sh intake 86                  triage exactly issue #86
#   ./init.sh intake 86 --dry-run        run the triage session and print the parsed
#                                        decision and the computed id/priority, writing
#                                        nothing and posting nothing
#
#   ./init.sh intake-check               NOT read-only despite the name: reconcile the issues
#                                        already mapped to a
#                                        feature: backfill a missing snapshot, amend
#                                        an auto-intake pending entry whose issue
#                                        moved, note a curated one, queue a follow-up
#                                        for a reopened issue
#   ./init.sh intake-check --dry-run     list every mapped issue and what would happen
#                                        to it, writing nothing and posting nothing
#
# The dry run is enforced inside `intake_comment_issue` and inside the python
# apply step, not at the call site, so no path can leak a comment or a queue
# write out of it.
intake_cmd() {
  local num="" arg known
  for arg in "$@"; do
    case "$arg" in
      --dry-run) INTAKE_DRY_RUN=1 ;;
      [0-9]*) num="$arg" ;;
      *) fail "usage: ./init.sh intake [issue-number] [--dry-run]" ;;
    esac
  done
  need gh
  if [[ -z "$num" ]]; then
    intake_new_issues
    return 0
  fi
  known="$(intake_known_state "$num" | tr -d '
')"
  if [[ -n "$known" ]]; then
    echo "[st-init] issue #$num is $known; nothing to triage"
    return 0
  fi
  intake_issue "$num"
}

case "$MODE" in
  status) status ;;
  bootstrap) bootstrap ;;
  smoke)
    bootstrap
    status
    smoke
    ;;
  baseline-smoke) baseline_smoke ;;
  evidence-run) shift; evidence_run "$@" ;;
  evidence-check) shift; evidence_check "$@" ;;
  ci) shift; ci_evidence "$@" ;;
  intake) shift; intake_cmd "$@" ;;
  intake-check) shift; intake_check "$@" ;;
  *) fail "usage: ./init.sh {status|bootstrap|smoke|baseline-smoke|evidence-run <id> <log> <cmd...>|evidence-check <id>|ci <id> <PR>|intake [issue] [--dry-run]|intake-check [--dry-run]}" ;;
esac
