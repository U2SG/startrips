#!/usr/bin/env bash
# One-shot Experience execution entrypoint. This is not a supervisor or scheduler.
set -euo pipefail
export PATH="/usr/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export STARTRIPS_LANE=experience
export STARTRIPS_ROLE=experience
# Only the explicit global owner stop applies to Experience. Backend lifecycle
# markers are preserved but intentionally do not block this lane.
[[ ! -f "$ROOT/AGENT_STOP" ]] || { echo "Global owner STOP preserved; no Experience execution"; exit 0; }
# Fresh Experience launches must never inherit a stale identity. Publish this
# launcher as PID+CreationDate before MSYS exec can split it into new carriers;
# run-loop extends the same invocation with its own observable carrier identity.
unset STARTRIPS_OWN_PIDS
native_pids() {
  local pid out=""
  for pid in $$ ${PPID:-}; do
    [[ -n "$pid" ]] || continue
    if [[ -r "/proc/$pid/winpid" ]]; then out="$out $(cat "/proc/$pid/winpid")"; else out="$out $pid"; fi
  done
  printf '%s' "$out"
}
# shellcheck disable=SC2046
STARTRIPS_OWN_PIDS="$(python3 -B "$ROOT/lib/execution.py" identity "$ROOT" $(native_pids))" || {
  echo "Experience launch identity is not observable; refusing to start" >&2; exit 64;
}
export STARTRIPS_OWN_PIDS
token="experience-$(date +%s)-$$-$RANDOM"
# The carrier token is non-secret invocation identity already published in argv.
# Emit it before exec so transient pre-scope failures remain attributable after
# the short-lived Windows/MSYS process disappears.
printf 'EXPERIENCE_CARRIER_TOKEN=%s\n' "$token"
exec "$ROOT/run-loop.sh" --carrier-lane=experience "--carrier-token=$token"
