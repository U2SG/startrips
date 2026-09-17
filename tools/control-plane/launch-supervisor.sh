#!/usr/bin/env bash
# Detached-launch wrapper for loop-supervisor.sh.
#
# Start-Process must be handed ONE argument (this script's path) and nothing
# else: passing `bash -c "... > log 2>&1"` through Start-Process loses the
# redirection during command-line reassembly and the shell exits immediately
# with an empty log. Keep the redirection here, on the bash side.
set -uo pipefail
# Dedicated LOCAL Backend entrypoint, not a generic lane fallback.
case "${STARTRIPS_LANE:-backend}" in
  backend) export STARTRIPS_LANE=backend ;;
  *) echo "This launcher belongs to LOCAL Backend; refusing another lane" >&2; exit 64 ;;
esac
export PATH="/usr/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for guard in AGENT_STOP SUPERVISOR_STOP CANCEL_SCHEDULED_RESTART; do
  [[ ! -f "$ROOT/$guard" ]] || { echo "Owner STOP present; use explicit local Resume when authorized"; exit 0; }
done
python3 -B "$ROOT/lib/execution.py" check "$ROOT" || exit 6
LOGDIR="${LOOP_LOG_DIR:-/d/startrips/loop-logs}"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%dT%H%M%S)"; TS="$(printf '%s' "$TS" | tr -d '\r')"
LOG="$LOGDIR/supervisor-$TS.log"
cd "$ROOT" || exit 1
echo "[launch] $(date '+%F %T') starting supervisor, log=$LOG" >"$LOG"
exec /usr/bin/bash "$ROOT/loop-supervisor.sh" >>"$LOG" 2>&1
