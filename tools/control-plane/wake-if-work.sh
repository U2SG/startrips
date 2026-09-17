#!/usr/bin/env bash
# Idle hook for the Startrips loop: decides whether there is work, and nothing else.
#
# The backend lane runs dry for long stretches - the 2026-09-09 relaunch cost a
# supervisor plus a run-loop start and exited rc=0 in 75 seconds because
# `next_feature` had nothing to serve. Keeping the loop resident for that is
# pure burn, so the loop stays down between spells of work and this hook says
# when a spell has started.
#
# It only DECIDES. Exit 10 means "launch the supervisor" and exit 0 means "stay
# down"; the caller (wake-hook.ps1, from Task Scheduler) does the launching,
# because a backgrounded child of this script does not survive its exit on
# MSYS - an earlier version silently launched nothing.
#
# Three wake conditions, cheapest first:
#   1. The lane's selector already has a feature       -> `run-loop.sh --next`
#   2. Intake owes an open issue a triage              -> `intake_candidates`
#   3. Reconcile owes a PR a state change              -> `run-loop.sh --work-prs`
# Every answer comes from the code the loop itself runs. A hook that re-derived
# eligibility, candidacy or the live-PR set would be a second source of truth,
# and the two would drift: condition 2 written by hand missed the intake skip
# list and fired on ten issues intake had already declined.
set -uo pipefail
export PATH="/usr/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="${LOOP_LOG_DIR:-/d/startrips/loop-logs}"
LOG="$LOGDIR/wake-hook.log"
GH_REPO="${STARTRIPS_GH_REPO:-U2SG/startrips}"
# This is the dedicated LOCAL Backend wake hook. Generic run-loop has no default.
case "${STARTRIPS_LANE:-backend}" in
  backend) export STARTRIPS_LANE=backend ;;
  *) echo "Wrong lane for LOCAL Backend wake hook" >&2; exit 64 ;;
esac
mkdir -p "$LOGDIR"

say() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
wake() { say "$1 -> wake."; exit 10; }

# A deliberate stop outranks the hook. AGENT_STOP and SUPERVISOR_STOP are the
# loop's own sentinels, CANCEL_SCHEDULED_RESTART is what the restart scripts
# honour: any of them means a human or another orchestrator wants the loop
# down, and waking over that would be the bug.
for guard in AGENT_STOP SUPERVISOR_STOP CANCEL_SCHEDULED_RESTART; do
  if [[ -f "$ROOT/$guard" ]]; then say "$guard present; staying down."; exit 0; fi
done

# Never a second state writer: one supervisor at a time, and a running one
# already reconciles on its own schedule.
#
# Ask Windows, not MSYS. `ps -W` lists only the bash processes in this shell's
# own lineage, so it never saw the supervisor the scheduled task starts
# detached through Start-Process, and the guard was a no-op for every real
# launch: on 2026-09-15 the 13:10 tick left a supervisor running, the 14:10
# tick saw nothing and stacked a second supervisor and a second builder onto
# ST-074, both writing one feature_list and one checkout. This is the same
# criterion as outage-window.ps1's Supervisor-Running, widened to run-loop.sh
# because that is the process that actually writes; `-ne $PID` drops the
# querying powershell, whose own command line carries the pattern.
#
# Unreadable is treated as running: staying down for one tick costs an hour,
# stacking a second writer costs a feature.
if ! python3 -B "$ROOT/lib/execution.py" check "$ROOT" >/dev/null 2>&1; then
  say "another execution or unavailable provider; no duplicate launch, observation retained"
  exit 6
fi

if ! NEXT="$("$ROOT/run-loop.sh" --next 2>/dev/null | tr -d '\r')"; then
  say "selector UNKNOWN; no dispatch, observer remains enabled"
  exit 6
fi
[[ -z "$NEXT" ]] || wake "lane=$STARTRIPS_LANE has $NEXT eligible"

# Both remaining checks need GitHub. An unreachable API is not evidence of work
# and not a failure worth waking for: log it and let the next tick decide.
if ! gh api rate_limit --silent >/dev/null 2>&1; then
  say "GitHub API unreachable; no decision this tick."
  exit 0
fi

# Intake's own candidate list: open, unqueued, not on the skip list, not
# labelled with rules.intake.skip_label.
# shellcheck source=lib/intake.sh
source "$ROOT/lib/intake.sh"
if ! CANDS="$(intake_candidates | tr -d '\r' | tr '\n' ' ')"; then
  say "intake candidates UNKNOWN; do not convert a failed discovery into idle"
  exit 6
fi
CANDS="${CANDS% }"
[[ -z "$CANDS" ]] || wake "intake candidate issue(s): $CANDS"

# Whatever a human merged or closed while the loop was down: that transition is
# what turns a feature `passed` and unblocks its dependents.
# Which of those PRs are `ready_to_merge`. Reconcile is the only thing that acts
# on review findings, and only for this status, so this set is what the review
# check below is allowed to wake for.
READY=""
while IFS=$'\t' read -r _fid _url; do
  READY="$READY $(printf '%s' "$_url" | tr -d '\r' | sed -E 's#.*/pull/([0-9]+)#\1#')"
done < <("$ROOT/run-loop.sh" --ready-prs 2>/dev/null)

CHANGED=""
while IFS=$'\t' read -r fid url; do
  fid="$(printf '%s' "$fid" | tr -d '\r')"; url="$(printf '%s' "$url" | tr -d '\r')"
  [[ -n "$fid" && -n "$url" ]] || continue
  num="$(printf '%s' "$url" | sed -E 's#.*/pull/([0-9]+)#\1#')"
  state="$(gh pr view "$num" --repo "$GH_REPO" --json state --jq .state 2>/dev/null | tr -d '\r')"
  [[ "$state" == "MERGED" || "$state" == "CLOSED" ]] && CHANGED="$CHANGED $fid#$num=$state"
  if [[ "$state" == "OPEN" && " $READY " == *" $num "* ]]; then
    # Unanswered threads or a CHANGES_REQUESTED review on a PR the loop parked
    # for a human: reconcile hands the feature back to the builder, and that
    # write clears the condition, so this cannot re-wake every tick.
    if ! review_result="$("$ROOT/run-loop.sh" --pr-review "$num" 2>/dev/null)"; then
      say "review evidence UNKNOWN for $fid#$num; observer stays enabled"
      exit 6
    fi
    IFS=$'\t' read -r un ch <<< "$(printf '%s' "$review_result" | tr -d '\r')"
    if [[ "$un" -gt 0 || "$ch" -gt 0 ]]; then
      wake "review waiting on $fid#$num (unanswered=${un:-0}, changes_requested=${ch:-0})"
    fi
  fi
done < <("$ROOT/run-loop.sh" --work-prs 2>/dev/null)
[[ -z "$CHANGED" ]] || wake "PR state moved while down:$CHANGED"

say "lane=$STARTRIPS_LANE idle: nothing eligible, no intake candidate, no PR state change, no waiting review."
exit 0
