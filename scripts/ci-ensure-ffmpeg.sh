#!/usr/bin/env bash
# Hosted runners may not ship the FFmpeg/ffprobe CLI required by render QA.
# Bound package-mirror stalls; never retry product assertions or hide failures.
set -euo pipefail
trap 'echo "::error::FFmpeg infrastructure setup failed (not a render assertion)" >&2' ERR
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  elevate=()
  if [[ "$(id -u)" != "0" ]]; then elevate=(sudo -n); fi
  # The hosted Azure HTTP mirror transferred packages at tens of KB/s in
  # run 36751927316. A timeout bounds that failure but cannot fix the source.
  # Keep Ubuntu's packages/signature checks; change only this invocation's
  # download route, without rewriting the runner's global source configuration.
  . /etc/os-release
  if [[ "$ID" != "ubuntu" || "$VERSION_CODENAME" != "noble" || "$(uname -m)" != "x86_64" ]]; then
    echo "::error::FFmpeg setup requires the ubuntu-24.04 x64 CI image" >&2
    exit 1
  fi
  apt_sources=$(mktemp /tmp/startrips-ffmpeg-XXXXXX.list)
  trap 'rm -f -- "$apt_sources"' EXIT
  cat > "$apt_sources" <<'SOURCES'
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main universe
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-updates main universe
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu noble-security main universe
SOURCES
  chmod 644 "$apt_sources"
  apt_options=(-o "Dir::Etc::sourcelist=$apt_sources" -o Dir::Etc::sourceparts=-
    -o Acquire::Languages=none -o Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false
    -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1
    -o DPkg::Lock::Timeout=20 -o APT::Update::Error-Mode=any)
  timeout --kill-after=5s 60s "${elevate[@]}" apt-get "${apt_options[@]}" update
  timeout --kill-after=5s 90s "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install --no-install-recommends -y ffmpeg
fi
ffmpeg -version | sed -n '1p'
ffprobe -version | sed -n '1p'
