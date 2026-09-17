#!/bin/bash
# Install Pasture as an always-on service on a Mac, for a TV.
#
# Two user-level launchd agents:
#   dev.bronson.pasture     the production server on 127.0.0.1:$PASTURE_PORT, using the
#                           gh CLI's token at request time (nothing stored), so it never
#                           needs a sign-in and never logs out.
#   dev.bronson.pasture-tv  a kiosk Chrome window on the field, relaunched if it closes.
#   dev.bronson.pasture-awake  (PASTURE_AWAKE=1) caffeinate, so a laptop feeding a TV never sleeps.
#
# Re-run after `git pull` to rebuild and restart. `scripts/mini/pasture-tv off` hides the
# kiosk without touching the server. The server binds to localhost on purpose: in gh token
# mode there is no sign-in, so nothing off this machine may reach it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PASTURE_PORT:-3517}"
# Chrome's debugging port for the kiosk, loopback only: scripts/mini/tv-shot.mjs screenshots the TV through it.
TV_DEBUG_PORT="${PASTURE_TV_DEBUG_PORT:-9333}"
ORG="${PASTURE_DEFAULT_ORG:-coval-ai}"
RELEASE_GITHUB="${PASTURE_RELEASE_GITHUB:-0}"
RELEASE_REPOS="${PASTURE_RELEASE_GITHUB_REPOS:-}"
RELEASE_PRODUCTION_PATTERN="${PASTURE_RELEASE_GITHUB_PRODUCTION_PATTERN:-}"
RELEASE_SCOPES="${PASTURE_RELEASE_SCOPES:-$ORG}"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="$(command -v node)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
UID_NUM="$(id -u)"

mkdir -p "$AGENTS" "$LOGS"

command -v gh >/dev/null || { echo "gh is not installed; the server uses its token" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not signed in; run: gh auth login" >&2; exit 1; }

if [ "${PASTURE_SKIP_BUILD:-0}" = "1" ] && [ -f "$ROOT/.next/BUILD_ID" ]; then
  echo "using the existing build in $ROOT/.next"
else
  echo "building $ROOT"
  (cd "$ROOT" && npm ci --no-audit --no-fund && npm run build) >"$LOGS/pasture-build.log" 2>&1 || {
    tail -20 "$LOGS/pasture-build.log" >&2
    exit 1
  }
fi

cat >"$AGENTS/dev.bronson.pasture.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.bronson.pasture</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/node_modules/next/dist/bin/next</string>
    <string>start</string>
    <string>-H</string><string>127.0.0.1</string>
    <string>-p</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PASTURE_GH_CLI</key><string>1</string>
    <key>PASTURE_DEFAULT_ORG</key><string>$ORG</string>
    <key>PASTURE_RELEASE_GITHUB</key><string>$RELEASE_GITHUB</string>
    <key>PASTURE_RELEASE_GITHUB_REPOS</key><string>$RELEASE_REPOS</string>
    <key>PASTURE_RELEASE_GITHUB_PRODUCTION_PATTERN</key><string>$RELEASE_PRODUCTION_PATTERN</string>
    <key>PASTURE_RELEASE_SCOPES</key><string>$RELEASE_SCOPES</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/pasture.log</string>
  <key>StandardErrorPath</key><string>$LOGS/pasture.log</string>
</dict>
</plist>
PLIST

cat >"$AGENTS/dev.bronson.pasture-tv.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.bronson.pasture-tv</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/scripts/mini/pasture-tv.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
    <key>PASTURE_PORT</key><string>$PORT</string>
    <key>PASTURE_TV_DEBUG_PORT</key><string>$TV_DEBUG_PORT</string>
    <key>PASTURE_CHROME</key><string>$CHROME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/pasture-tv.log</string>
  <key>StandardErrorPath</key><string>$LOGS/pasture-tv.log</string>
</dict>
</plist>
PLIST

# Stop a service and wait until launchd has really let go of it before starting it again;
# bootout returns before a slow process (Chrome) has exited.
reload() {
  launchctl bootout "gui/$UID_NUM/$1" 2>/dev/null || true
  for i in $(seq 1 30); do
    launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1 || break
    sleep 1
  done
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$1.plist"
}
reload dev.bronson.pasture
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/pasture" 2>/dev/null; then break; fi
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/pasture" || { echo "server did not come up; see $LOGS/pasture.log" >&2; exit 1; }
echo "server: http://127.0.0.1:$PORT/pasture"
if [ "${PASTURE_TV:-1}" = "1" ]; then
  reload dev.bronson.pasture-tv
  echo "tv: kiosk Chrome loaded (scripts/mini/pasture-tv off to hide it)"
fi
if [ "${PASTURE_AWAKE:-0}" = "1" ]; then
  cat >"$AGENTS/dev.bronson.pasture-awake.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.bronson.pasture-awake</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-dis</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
  reload dev.bronson.pasture-awake
  echo "awake: caffeinate loaded (display and system sleep off while on power)"
fi
