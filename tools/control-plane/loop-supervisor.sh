#!/usr/bin/env bash
# Supervises run-loop.sh across Claude quota exhaustions.
#
#   exit 0  -> queue finished or AGENT_STOP: stop.
#   exit 5  -> quota exhausted (quota_stop): parse "resets <time>" from the run
#              log, sleep until that time plus a buffer, relaunch.
#   exit 6  -> platform failure (transient_stop): wait TRANSIENT_WAIT_S and relaunch,
#              up to MAX_TRANSIENT_RETRIES in a row (own counter, not MAX_RESUMES).
#   exit 3  -> MAX_ITERATIONS reached with work still eligible: a per-run cap, not a
#              problem. Relaunch at once (a fresh shell also picks up harness edits).
#   exit 7  -> nothing eligible, but features are `ready_to_merge` and waiting on
#              a human `merge-ready` sign-off. Not a finished queue: sleep and
#              re-reconcile, so the merge is picked up without a relaunch.
#   exit 8  -> the execution guard reported one of this supervisor's own published
#              identities: a deterministic self-block, not a transient failure.
#              Stop at once instead of spending the exit-6 budget on it.
#   other   -> a real problem (broken baseline, invalid verdict, no-change
#              stall): stop and leave the log for a human.
#
# Logs live OUTSIDE the workspace repo, because builder git operations have
# clobbered in-repo logs before. Stop everything early with AGENT_STOP in the
# workspace root — run-loop checks it at each iteration boundary, and the
# supervisor honors the resulting exit 0; during a quota sleep, create
# SUPERVISOR_STOP instead. Neither sentinel interrupts a builder that is already
# running: that needs a real taskkill (see the /loop-harness skill).
set -uo pipefail
# Detached launches inherit the raw Windows PATH; make MSYS coreutils explicit
# so date/grep/sed behave identically to an interactive shell.
export PATH="/usr/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# MSYS emulates fork/exec by spawning fresh Windows processes, so the
# ParentProcessId recorded for run-loop routinely names an already-exited stub:
# the execution guard cannot reach this supervisor by walking ppids and reports
# it as a competing instance, failing every iteration with rc=6. Publish what
# this supervisor and its launcher ARE -- pid bound to start stamp -- because a
# bare number is reused and would later excuse an unrelated process. Refuse to
# run unobserved rather than start without a verifiable identity.
native_pids() {
  local pid out=""
  for pid in $$ ${PPID:-}; do
    [[ -n "$pid" ]] || continue
    if [[ -r "/proc/$pid/winpid" ]]; then
      out="$out $(cat "/proc/$pid/winpid")"
    else
      out="$out $pid"
    fi
  done
  printf '%s' "$out"
}
# shellcheck disable=SC2046  # the helper prints a deliberate pid word list
if ! STARTRIPS_OWN_PIDS="$(python3 -B "$ROOT/lib/execution.py" identity "$ROOT" $(native_pids))"; then
  echo "[supervisor] own execution identity is not observable; refusing to start" >&2
  exit 64
fi
export STARTRIPS_OWN_PIDS
# A guard failure naming one of those identities is this supervisor blocking its
# own run-loop. That is deterministic, so the transient budget below would only
# hide it for twelve hours, which is exactly what happened on 2026-09-17.
self_blocked() {
  local log="$1" entry pid
  grep -q EXECUTION_UNKNOWN "$log" 2>/dev/null || return 1
  for entry in ${STARTRIPS_OWN_PIDS//,/ }; do
    pid="${entry%@*}"
    [[ -n "$pid" ]] && grep -q "\"pid\": $pid," "$log" && return 0
  done
  return 1
}
LOGDIR="${LOOP_LOG_DIR:-/d/startrips/loop-logs}"
mkdir -p "$LOGDIR"
MAX_RESUMES="${MAX_RESUMES:-20}"
BUFFER_S=300
MERGE_WAIT_S="${MERGE_WAIT_S:-1800}"
TRANSIENT_WAIT_S="${TRANSIENT_WAIT_S:-600}"
MAX_TRANSIENT_RETRIES="${MAX_TRANSIENT_RETRIES:-72}"   # ~12 h of 10-min retries

n=0
transient_count=0
for value in "$MAX_RESUMES" "$MERGE_WAIT_S" "$TRANSIENT_WAIT_S" "$MAX_TRANSIENT_RETRIES"; do
  [[ "$value" =~ ^[0-9]+$ ]] || { echo "Invalid supervisor budget" >&2; exit 64; }
done
stopped() { [[ -f "$ROOT/AGENT_STOP" || -f "$ROOT/SUPERVISOR_STOP" || -f "$ROOT/CANCEL_SCHEDULED_RESTART" ]]; }
while :; do
  stopped && { echo "[supervisor] owner STOP preserved; no child launched"; exit 0; }
  TS="$(date +%Y%m%dT%H%M%S)"; TS="$(printf '%s' "$TS" | tr -d '\r')"
  RUNLOG="$LOGDIR/run-$TS.log"
  echo "[supervisor] $(date '+%F %T') launching run-loop (resume #$n) -> $RUNLOG"
  MAX_ITERATIONS="${MAX_ITERATIONS:-20}" "$ROOT/run-loop.sh" >"$RUNLOG" 2>&1
  rc=$?
  echo "[supervisor] $(date '+%F %T') run-loop exited rc=$rc"
  [[ "$rc" == "6" ]] || transient_count=0
  case "$rc" in
    0)
      echo "[supervisor] clean finish (queue done or AGENT_STOP); stopping."
      exit 0
      ;;
    5)
      n=$((n+1))
      if (( n > MAX_RESUMES )); then
        echo "[supervisor] MAX_RESUMES=$MAX_RESUMES exceeded; stopping."
        exit 5
      fi
      # e.g. "resets 1:10pm (Asia/Singapore)" / "resets 6pm" / "resets 12:20am"
      quota_reset="$(grep -m1 -ioE 'resets +[0-9]{1,2}(:[0-9]{2})?(am|pm)' "$RUNLOG" | sed -E 's/^[Rr]esets +//' | tr -d '\r')"
      now=$(date +%s)
      if [[ -n "$quota_reset" ]] && target="$(date -d "$quota_reset" +%s 2>/dev/null)" && [[ -n "$target" ]]; then
        (( target <= now )) && target="$(date -d "tomorrow $quota_reset" +%s)"
      else
        target=$((now + 1800))   # could not parse: retry in 30 min
      fi
      target=$((target + BUFFER_S))
      echo "[supervisor] quota exhausted; sleeping until $(date -d "@$target" '+%F %T') (parsed reset: '${quota_reset:-unparsed}')"
      while (( $(date +%s) < target )); do
        ! stopped || { echo "[supervisor] SUPERVISOR_STOP present; stopping."; exit 0; }
        sleep 10
      done
      ;;
    3)
      # MAX_ITERATIONS is a per-run cap so one shell never runs forever; the
      # queue is not done and nothing is wrong. Count it like a resume and go
      # straight back in.
      n=$((n+1))
      if (( n > MAX_RESUMES )); then
        echo "[supervisor] MAX_RESUMES=$MAX_RESUMES exceeded; stopping."
        exit 3
      fi
      echo "[supervisor] MAX_ITERATIONS reached; relaunching run-loop (resume #$n)"
      ;;
    6)
      # Platform failure (API unreachable, TLS, 5xx): nothing to fix here, so
      # wait a little and try again; the same feature is re-selected because
      # its state was left untouched. Bounded by TIME, not by MAX_RESUMES: a
      # 5.5 h outage on 2026-09-06 burned all 20 resumes at 10 min apart and
      # stopped the loop for a day. The counter resets on any non-6 exit.
      if self_blocked "$RUNLOG"; then
        echo "[supervisor] the execution guard reported this supervisor itself; stopping for a human. Log: $RUNLOG"
        exit 8
      fi
      transient_count=$((transient_count+1))
      if (( transient_count > MAX_TRANSIENT_RETRIES )); then
        echo "[supervisor] platform failure persisted through $MAX_TRANSIENT_RETRIES retries; stopping."
        exit 6
      fi
      target=$(( $(date +%s) + TRANSIENT_WAIT_S ))
      echo "[supervisor] platform failure (retry $transient_count/$MAX_TRANSIENT_RETRIES); retrying at $(date -d "@$target" '+%F %T')"
      while (( $(date +%s) < target )); do
        ! stopped || { echo "[supervisor] SUPERVISOR_STOP present; stopping."; exit 0; }
        sleep 10
      done
      ;;
    7)
      # The loop cannot merge; only the maintainer can. Wait for that rather than
      # stopping, and honour SUPERVISOR_STOP while waiting.
      target=$(( $(date +%s) + MERGE_WAIT_S ))
      echo "[supervisor] waiting on a human merge-ready sign-off; re-reconciling at $(date -d "@$target" '+%F %T')"
      while (( $(date +%s) < target )); do
        ! stopped || { echo "[supervisor] SUPERVISOR_STOP present; stopping."; exit 0; }
        sleep 10
      done
      ;;
    *)
      echo "[supervisor] rc=$rc needs a human; stopping. Log: $RUNLOG"
      exit "$rc"
      ;;
  esac
done
