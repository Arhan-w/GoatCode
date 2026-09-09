# install-goat — one-command global install of GoatCode (Windows, Linux, macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/Arhan-w/GoatCode/v2-typescript/install.sh | bash
#
# Strategy: prefer the prebuilt release binary for this platform (fast, no
# toolchain); fall back to building from source with Bun when no release
# matches. Drops `goat` on PATH. Idempotent — re-running upgrades in place.
set -euo pipefail

REPO_SLUG="Arhan-w/GoatCode"
BRANCH="${GOAT_BRANCH:-v2-typescript}"
INSTALL_DIR="${GOAT_INSTALL_DIR:-$HOME/.goatcode/bin}"
REPO_DIR="$HOME/.goatcode/src"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { printf '%s[goat-install]%s %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%s[goat-install]%s %s\n' "$YELLOW" "$NC" "$*"; }
err()  { printf '%s[goat-install]%s %s\n' "$RED" "$NC" "$*" >&2; }

# --- 0. Platform -----------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  msys*|cygwin*|mingw*) OS="windows" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
BIN_NAME="goat"
[ "$OS" = "windows" ] && BIN_NAME="goat.exe"
log "platform: $OS-$ARCH"

mkdir -p "$INSTALL_DIR" "$HOME/.goatcode"

# --- 1. Try the prebuilt release binary ------------------------------------
# Release assets are named goat-<os>-<arch>[.exe] (see .github/workflows).
fetch_asset() {
  local name="$1" url="https://github.com/$REPO_SLUG/releases/latest/download/$name"
  local tmp="$HOME/.goatcode/.dl-part"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$tmp" "$url" 2>/dev/null || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$tmp" "$url" 2>/dev/null || return 1
  else
    return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
  # sanity: real binaries are ~100 MB; anything small is an error page
  local size; size=$(wc -c < "$tmp")
  if [ "$size" -lt 1000000 ]; then
    rm -f "$tmp"; warn "asset too small ($size bytes) — skipping"
    return 1
  fi
  mv "$tmp" "$INSTALL_DIR/$BIN_NAME"
  chmod +x "$INSTALL_DIR/$BIN_NAME"
  return 0
}

if [ "${GOAT_FORCE_SOURCE:-0}" != "1" ] && fetch_asset "goat-$OS-$ARCH$( [ "$OS" = windows ] && echo .exe )"; then
  log "installed prebuilt release binary"
else
  # --- 2. Fallback: build from source with Bun ----------------------------
  warn "no prebuilt binary for $OS-$ARCH (or download failed) — building from source"
  if ! command -v bun >/dev/null 2>&1; then
    log "installing bun"
    if command -v curl >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | bash
    elif command -v wget >/dev/null 2>&1; then wget -qO- https://bun.sh/install | bash
    else err "need curl or wget"; exit 1; fi
    export PATH="$HOME/.bun/bin:$HOME/.bun:$PATH"
  fi
  if command -v git >/dev/null 2>&1; then
    if [ -d "$REPO_DIR/.git" ]; then
      git -C "$REPO_DIR" fetch --depth=1 origin "$BRANCH" && git -C "$REPO_DIR" checkout -f "origin/$BRANCH"
    else
      git clone --depth=1 --branch "$BRANCH" "https://github.com/$REPO_SLUG.git" "$REPO_DIR"
    fi
    ( cd "$REPO_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install )
    if bun build "$REPO_DIR/src/index.ts" --compile --outfile "$INSTALL_DIR/$BIN_NAME" >/dev/null 2>&1; then
      log "built from source"
    else
      warn "compile failed — installing a bun-runner shim"
      printf '#!/usr/bin/env bash\nexec bun run "%s/src/index.ts" "$@"\n' "$REPO_DIR" > "$INSTALL_DIR/$BIN_NAME"
      chmod +x "$INSTALL_DIR/$BIN_NAME"
    fi
  else
    err "git missing and no prebuilt binary available — install git and retry"
    exit 1
  fi
fi

# --- 3. PATH ---------------------------------------------------------------
add_path_line() {
  local rc="$1" line="export PATH=\"\$PATH:$INSTALL_DIR\""
  if [ ! -f "$rc" ] || ! grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null; then
    mkdir -p "$(dirname "$rc")"
    printf '\n# GoatCode\n%s\n' "$line" >> "$rc"
    log "PATH += $INSTALL_DIR (in $rc)"
  fi
}
case "${SHELL:-}" in
  */zsh)  add_path_line "$HOME/.zshrc" ;;
  *)      add_path_line "$HOME/.bashrc" ;;
esac
[ "$OS" = "windows" ] || add_path_line "$HOME/.profile"

# --- 4. Verify -------------------------------------------------------------
export PATH="$INSTALL_DIR:$PATH"
if "$INSTALL_DIR/$BIN_NAME" --version; then
  log ""
  log "✓ GoatCode installed → $INSTALL_DIR/$BIN_NAME"
  log "  open a new terminal and run:  goat"
  log "  upgrade:   re-run the same curl command"
  log "  uninstall: rm -rf $HOME/.goatcode  (and remove the # GoatCode lines from your shell rc)"
else
  err "binary present but won't run — try: $INSTALL_DIR/$BIN_NAME --version"
  exit 1
fi