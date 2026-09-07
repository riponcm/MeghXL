#!/usr/bin/env bash
# Make MeghXL start automatically when you log in (macOS / launchd).
# Usage:  npm run autostart:install        (optionally: PORT=8080 npm run autostart:install)
set -euo pipefail

LABEL="com.meghxl.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
PORT="${PORT:-3000}"

if [ -z "$NODE" ]; then
  echo "✗ Could not find 'node' on PATH. Install Node.js first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/meghxl.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/meghxl.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✅ MeghXL will now auto-start when you log in, and is running now."
echo "   URL:    http://localhost:$PORT  (and your LAN IP / meghxl.local)"
echo "   Plist:  $PLIST"
echo "   Logs:   $DIR/logs/"
echo "   Remove with:  npm run autostart:uninstall"
