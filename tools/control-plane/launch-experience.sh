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
token="experience-$(date +%s)-$$-$RANDOM"
exec "$ROOT/run-loop.sh" --carrier-lane=experience "--carrier-token=$token"
