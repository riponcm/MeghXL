#!/usr/bin/env bash
#
# Compile the MeghXL Node server into a single self-contained executable and
# stage it (plus the dashboard's static files) for the Tauri bundler.
#
# The server has no native dependencies, so `bun build --compile` produces one
# portable binary with no Node.js installation required on the user's machine.
#
#   bash scripts/build-server.sh                       # host platform
#   bash scripts/build-server.sh x86_64-pc-windows-msvc # cross-compile the server half
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$(dirname "$HERE")"
PROJ="$(dirname "$DESKTOP")"
OUT="$DESKTOP/src-tauri/binaries"
RES="$DESKTOP/src-tauri/resources"

command -v bun >/dev/null || {
  echo "✗ 'bun' not found. Install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

# --- Resolve the Rust target triple Tauri expects for the sidecar name --------
if [ $# -ge 1 ]; then
  TRIPLE="$1"
else
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
fi

case "$TRIPLE" in
  aarch64-apple-darwin)      BUN_TARGET="bun-darwin-arm64" ; EXT="" ;;
  x86_64-apple-darwin)       BUN_TARGET="bun-darwin-x64"   ; EXT="" ;;
  aarch64-unknown-linux-gnu) BUN_TARGET="bun-linux-arm64"  ; EXT="" ;;
  x86_64-unknown-linux-gnu)  BUN_TARGET="bun-linux-x64"    ; EXT="" ;;
  x86_64-pc-windows-msvc)    BUN_TARGET="bun-windows-x64"  ; EXT=".exe" ;;
  *) echo "✗ Unsupported target triple: $TRIPLE" >&2; exit 1 ;;
esac

mkdir -p "$OUT" "$RES"

# --- 1. The server, as one executable ----------------------------------------
echo "→ Compiling server for $TRIPLE ($BUN_TARGET)"
bun build "$PROJ/server.js" \
  --compile \
  --target="$BUN_TARGET" \
  --outfile "$OUT/meghxl-server-$TRIPLE$EXT"

# Bun appends .exe itself for Windows targets; make sure we didn't double it.
[ -f "$OUT/meghxl-server-$TRIPLE.exe.exe" ] && \
  mv "$OUT/meghxl-server-$TRIPLE.exe.exe" "$OUT/meghxl-server-$TRIPLE.exe"

# --- 2. The dashboard's static files, as an app resource ---------------------
# The compiled binary has no source tree next to it, so the server reads these
# through PUBLIC_DIR (set by the Rust shell to this staged copy).
echo "→ Staging dashboard assets"
rm -rf "$RES/public"
mkdir -p "$RES/public"
cp -R "$PROJ/public/." "$RES/public/"

SIZE="$(du -h "$OUT/meghxl-server-$TRIPLE$EXT" | cut -f1 | tr -d ' ')"
echo "✓ binaries/meghxl-server-$TRIPLE$EXT  ($SIZE)"
