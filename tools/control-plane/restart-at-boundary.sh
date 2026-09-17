#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -B "$ROOT/lib/boundary_restart.py" "$ROOT" "${MAX_WAIT_S:-14400}"
