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

# Publish the invocation token on the Experience entrypoint itself before MSYS
# can split the launcher and run-loop into unrelated native ancestry. The first
# process immediately re-execs this same canonical entrypoint with one token;
# every later wrapper/run-loop carrier can therefore be joined by exact token.
CARRIER_TOKEN=""
case "${1:-}" in
  --carrier-token=*) CARRIER_TOKEN="${1#--carrier-token=}"; shift ;;
  "") ;;
  *) echo "UNKNOWN_EXPERIENCE_ARGUMENT: $1" >&2; exit 64 ;;
esac
if [[ -z "$CARRIER_TOKEN" ]]; then
  token="experience-$(date +%s)-$$-$RANDOM"
  exec "$ROOT/launch-experience.sh" "--carrier-token=$token"
fi
[[ "$CARRIER_TOKEN" =~ ^[A-Za-z0-9._:-]{8,128}$ ]] || {
  echo "INVALID_CARRIER_TOKEN" >&2; exit 64;
}
export STARTRIPS_CARRIER_TOKEN="$CARRIER_TOKEN"
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
exec "$ROOT/run-loop.sh" --carrier-lane=experience "--carrier-token=$CARRIER_TOKEN"
