#!/usr/bin/env bash
# Owner export QA renders Chinese text and needs a fontconfig CJK font.
# Bound every download stall; never retry product assertions or hide failures.
set -euo pipefail
trap 'echo "::error::CJK font infrastructure setup failed (not a render assertion)" >&2' ERR

# Primary path: a pinned Noto Sans SC release asset served by GitHub, so CI no
# longer depends on azure.archive.ubuntu.com (run 39769104429 crawled 9+ min on
# the 61 MB fonts-noto-cjk package). The workflow caches the verified zip under
# this key/path; the SHA is checked again before every extraction, including
# cache hits.
CJK_FONT_RELEASE=Sans2.004
CJK_FONT_ASSET=18_NotoSansSC
CJK_FONT_SHA256=4d107c09ada479d3e48b6e78c83835773cbd9214bf6e12cdb7b60f8e068292ec
CJK_FONT_URL="https://github.com/notofonts/noto-cjk/releases/download/$CJK_FONT_RELEASE/$CJK_FONT_ASSET.zip"
CJK_FONT_CACHE_DIR="$HOME/.cache/startrips-cjk-font"
CJK_FONT_DIR="$HOME/.local/share/fonts/startrips-noto-sc"
work_root="${RUNNER_TEMP:-/tmp}"

has_cjk_font() {
  [[ -n "$(fc-list :lang=zh family)" ]]
}

verify_archive() {
  printf '%s  %s\n' "$CJK_FONT_SHA256" "$1" | sha256sum --check --status - 2>/dev/null
}

# Returns non-zero (never exits) so the caller can fall back. Nothing reaches
# the font directory or the cache directory until the zip is verified, and the
# font directory only appears through one rename of a fully extracted staging dir.
install_pinned() {
  local archive="$CJK_FONT_CACHE_DIR/$CJK_FONT_ASSET.zip"
  local partial staging
  if [[ -f "$archive" ]] && ! verify_archive "$archive"; then
    echo "::warning::Cached CJK font archive failed SHA-256 verification; discarding it" >&2
    rm -f -- "$archive"
  fi
  if [[ ! -f "$archive" ]]; then
    partial=$(mktemp "$work_root/startrips-cjk-font-download-XXXXXX") || return 1
    if ! curl --fail --location --silent --show-error --connect-timeout 15 --max-time 90 \
      --output "$partial" "$CJK_FONT_URL"; then
      rm -f -- "$partial"
      return 1
    fi
    if ! verify_archive "$partial"; then
      echo "::warning::Downloaded CJK font archive failed SHA-256 verification" >&2
      rm -f -- "$partial"
      return 1
    fi
    if ! mkdir -p -- "$CJK_FONT_CACHE_DIR" || ! mv -- "$partial" "$archive"; then
      rm -f -- "$partial"
      return 1
    fi
  fi
  mkdir -p -- "$(dirname -- "$CJK_FONT_DIR")" || return 1
  staging=$(mktemp -d "$(dirname -- "$CJK_FONT_DIR")/.startrips-noto-sc-XXXXXX") || return 1
  if ! unzip -q -o "$archive" NotoSansSC-Regular.otf NotoSansSC-Medium.otf NotoSansSC-Bold.otf LICENSE -d "$staging" \
    || ! rm -rf -- "$CJK_FONT_DIR" \
    || ! mv -- "$staging" "$CJK_FONT_DIR"; then
    rm -rf -- "$staging"
    return 1
  fi
  if ! fc-cache -f "$CJK_FONT_DIR" >/dev/null || ! has_cjk_font; then
    rm -rf -- "$CJK_FONT_DIR"
    fc-cache -f >/dev/null 2>&1 || true
    return 1
  fi
}

if ! has_cjk_font && ! install_pinned; then
  # Fallback only: Ubuntu's mirror is a failure domain independent of GitHub
  # release assets, so one bounded APT attempt still beats failing outright.
  echo "::warning::Pinned Noto Sans SC unavailable; falling back to bounded Ubuntu APT install" >&2
  . /etc/os-release
  if [[ "$ID" != "ubuntu" || "$VERSION_CODENAME" != "noble" ]]; then
    echo "::error::CJK font APT fallback requires the ubuntu-24.04 CI image" >&2
    exit 1
  fi
  elevate=()
  if [[ "$(id -u)" != "0" ]]; then elevate=(sudo -n); fi
  # Keep Ubuntu's packages/signature checks; change only this invocation's
  # download route, without rewriting the runner's global source configuration.
  apt_sources=$(mktemp /tmp/startrips-cjk-font-XXXXXX.list)
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
  timeout --kill-after=5s 120s "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install --no-install-recommends -y fonts-noto-cjk
  has_cjk_font || false
fi
fc-list :lang=zh family | sed -n '1p'
