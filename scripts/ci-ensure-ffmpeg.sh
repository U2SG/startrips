#!/usr/bin/env bash
# Hosted runners may not ship the FFmpeg/ffprobe CLI required by render QA.
# Bound every download stall; never retry product assertions or hide failures.
set -euo pipefail
trap 'echo "::error::FFmpeg infrastructure setup failed (not a render assertion)" >&2' ERR

# Primary path: a pinned static build served by GitHub release assets, so CI no
# longer depends on archive.ubuntu.com. BtbN keeps month-end autobuilds long
# term. The workflow caches the verified archive under this key/path; the SHA
# is checked again before every extraction, including cache hits.
FFMPEG_RELEASE=autobuild-2026-03-31-13-11
FFMPEG_ASSET=ffmpeg-n7.1.3-43-g5a1f107b4c-linux64-gpl-7.1
FFMPEG_SHA256=c2bffbc1e827ca735f756dc3d2ccd33d4c2c15362566932ced4bb7686f034d08
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/$FFMPEG_RELEASE/$FFMPEG_ASSET.tar.xz"
FFMPEG_CACHE_DIR="$HOME/.cache/startrips-ffmpeg"
work_root="${RUNNER_TEMP:-/tmp}"

verify_archive() {
  printf '%s  %s\n' "$FFMPEG_SHA256" "$1" | sha256sum --check --status - 2>/dev/null
}

# Returns non-zero (never exits) so the caller can fall back. Nothing reaches
# PATH or the cache directory until the archive is verified and both binaries run.
install_static() {
  local archive="$FFMPEG_CACHE_DIR/$FFMPEG_ASSET.tar.xz"
  local partial install_dir
  if [[ -f "$archive" ]] && ! verify_archive "$archive"; then
    echo "::warning::Cached static FFmpeg archive failed SHA-256 verification; discarding it" >&2
    rm -f -- "$archive"
  fi
  if [[ ! -f "$archive" ]]; then
    partial=$(mktemp "$work_root/startrips-ffmpeg-download-XXXXXX") || return 1
    if ! curl --fail --location --silent --show-error --connect-timeout 15 --max-time 60 \
      --output "$partial" "$FFMPEG_URL"; then
      rm -f -- "$partial"
      return 1
    fi
    if ! verify_archive "$partial"; then
      echo "::warning::Downloaded static FFmpeg archive failed SHA-256 verification" >&2
      rm -f -- "$partial"
      return 1
    fi
    if ! mkdir -p -- "$FFMPEG_CACHE_DIR" || ! mv -- "$partial" "$archive"; then
      rm -f -- "$partial"
      return 1
    fi
  fi
  install_dir=$(mktemp -d "$work_root/startrips-ffmpeg-XXXXXX") || return 1
  if ! tar -xJf "$archive" -C "$install_dir" --strip-components=2 \
      "$FFMPEG_ASSET/bin/ffmpeg" "$FFMPEG_ASSET/bin/ffprobe" \
    || ! "$install_dir/ffmpeg" -version >/dev/null \
    || ! "$install_dir/ffprobe" -version >/dev/null; then
    rm -rf -- "$install_dir"
    return 1
  fi
  PATH="$install_dir:$PATH"
  if [[ -n "${GITHUB_PATH:-}" ]]; then echo "$install_dir" >> "$GITHUB_PATH"; fi
}

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  . /etc/os-release
  if [[ "$ID" != "ubuntu" || "$VERSION_CODENAME" != "noble" || "$(uname -m)" != "x86_64" ]]; then
    echo "::error::FFmpeg setup requires the ubuntu-24.04 x64 CI image" >&2
    exit 1
  fi
fi
if { ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; } && ! install_static; then
  # Fallback only: Ubuntu's mirror is a failure domain independent of GitHub
  # release assets, so one bounded APT attempt still beats failing outright.
  echo "::warning::Pinned static FFmpeg unavailable; falling back to bounded Ubuntu APT install" >&2
  elevate=()
  if [[ "$(id -u)" != "0" ]]; then elevate=(sudo -n); fi
  # The hosted Azure HTTP mirror transferred packages at tens of KB/s in
  # run 36751927316. A timeout bounds that failure but cannot fix the source.
  # Keep Ubuntu's packages/signature checks; change only this invocation's
  # download route, without rewriting the runner's global source configuration.
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
