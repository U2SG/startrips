#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
if ! command -v pnpm >/dev/null; then
  echo "Install pnpm 10.17.1 and run pnpm install --frozen-lockfile at the repository root before opening Startrips." >&2
  exit 1
fi
pnpm exec vite build --config mobile/ios/Scene/vite.config.ts
