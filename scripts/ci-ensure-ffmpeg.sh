#!/usr/bin/env bash
# Hosted runners may not ship the FFmpeg/ffprobe CLI required by render QA.
# Bound package-mirror stalls; never retry product assertions or hide failures.
set -euo pipefail
trap 'echo "::error::FFmpeg infrastructure setup failed (not a render assertion)" >&2' ERR
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  elevate=()
  if [[ "$(id -u)" != "0" ]]; then elevate=(sudo -n); fi
  apt_options=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1 -o DPkg::Lock::Timeout=20)
  timeout --kill-after=5s 60s "${elevate[@]}" apt-get "${apt_options[@]}" update
  timeout --kill-after=5s 90s "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install --no-install-recommends -y ffmpeg
fi
ffmpeg -version | sed -n '1p'
ffprobe -version | sed -n '1p'
