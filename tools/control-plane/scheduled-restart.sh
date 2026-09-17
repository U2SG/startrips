#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELAY_S="${DELAY_S:-18000}"
[[ "$DELAY_S" =~ ^[0-9]+$ ]] || exit 64
end=$(( $(date +%s) + DELAY_S ))
while (( $(date +%s) < end )); do
  for guard in AGENT_STOP SUPERVISOR_STOP CANCEL_SCHEDULED_RESTART; do
    [[ ! -f "$ROOT/$guard" ]] || exit 0
  done
  sleep 10
done
for guard in AGENT_STOP SUPERVISOR_STOP CANCEL_SCHEDULED_RESTART; do
  [[ ! -f "$ROOT/$guard" ]] || exit 0
done
python3 -B "$ROOT/lib/execution.py" check "$ROOT" --lane backend || exit 6
exec /usr/bin/bash "$ROOT/launch-supervisor.sh"
