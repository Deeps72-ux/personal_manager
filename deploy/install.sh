#!/usr/bin/env bash
# Install or upgrade Personal Manager on this Mac as a background service.
#
#   deploy/install.sh                       first install (sign-up allowed)
#   deploy/install.sh --no-signup           upgrade + close sign-up (after your account exists)
#   deploy/install.sh --mirror "<dir>"      also copy each daily backup to <dir>
#   deploy/install.sh --port 7810           change the local port
#
# Safe to re-run: settings are remembered, data is never touched.
set -euo pipefail
source "$(dirname "$0")/common.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-signup) PM_ALLOW_SIGNUP=false ;;
    --allow-signup) PM_ALLOW_SIGNUP=true ;;
    --port) PM_PORT="$2"; shift ;;
    --mirror) PM_BACKUP_MIRROR_DIR="$2"; shift ;;
    --no-mirror) PM_BACKUP_MIRROR_DIR="" ;;
    --keep) PM_BACKUP_KEEP="$2"; shift ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[[ "$PM_PORT" =~ ^[0-9]+$ ]] || die "port must be a number"

NODE="$(find_node)"
say "node: $NODE ($("$NODE" -v))"

# 1. Build the self-contained release from this checkout.
say "building release"
"$NODE" "$ROOT/deploy/build-release.mjs" >/dev/null
ok "release built: $(cat "$ROOT/release/VERSION")"

# 2. Install it (swap in place; previous version kept as app.previous).
mkdir -p "$APP_HOME" "$DATA_DIR" "$BACKUP_DIR" "$LOG_DIR" "$AGENTS"
chmod 700 "$APP_HOME" "$DATA_DIR" "$BACKUP_DIR"
rm -rf "$APP_DIR.new"
cp -R "$ROOT/release" "$APP_DIR.new"
rm -rf "$APP_DIR.previous"
[[ -d "$APP_DIR" ]] && mv "$APP_DIR" "$APP_DIR.previous"
mv "$APP_DIR.new" "$APP_DIR"
ok "installed to $APP_DIR"

# 3. Remember settings for next time.
cat >"$SETTINGS" <<EOF
# Written by deploy/install.sh. Re-run install.sh with flags to change.
PM_PORT=$PM_PORT
PM_ALLOW_SIGNUP=$PM_ALLOW_SIGNUP
PM_BACKUP_KEEP=$PM_BACKUP_KEEP
PM_BACKUP_MIRROR_DIR="$PM_BACKUP_MIRROR_DIR"
PM_BACKUP_HOUR=$PM_BACKUP_HOUR
EOF

# 4. launchd agents: the server (always on) and the daily backup.
E() { xml_escape "$1"; }
cat >"$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(E "$NODE")</string>
    <string>$(E "$APP_DIR/server.mjs")</string>
  </array>
  <key>WorkingDirectory</key><string>$(E "$APP_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>$PM_PORT</string>
    <key>DATA_DIR</key><string>$(E "$DATA_DIR")</string>
    <key>WEB_DIR</key><string>$(E "$APP_DIR/web")</string>
    <key>ALLOW_SIGNUP</key><string>$PM_ALLOW_SIGNUP</string>
    <key>NODE_ENV</key><string>production</string>
    <key>ACCESS_LOG</key><string>true</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(E "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key><string>$(E "$LOG_DIR/server.log")</string>
</dict>
</plist>
EOF

cat >"$BACKUP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$BACKUP_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(E "$NODE")</string>
    <string>$(E "$APP_DIR/backup.mjs")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATA_DIR</key><string>$(E "$DATA_DIR")</string>
    <key>BACKUP_DIR</key><string>$(E "$BACKUP_DIR")</string>
    <key>BACKUP_KEEP</key><string>$PM_BACKUP_KEEP</string>
    <key>BACKUP_MIRROR_DIR</key><string>$(E "$PM_BACKUP_MIRROR_DIR")</string>
  </dict>
  <!-- Daily; if the Mac was asleep at that time, launchd runs it on wake. -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$PM_BACKUP_HOUR</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$(E "$LOG_DIR/backup.log")</string>
  <key>StandardErrorPath</key><string>$(E "$LOG_DIR/backup.log")</string>
</dict>
</plist>
EOF
plutil -lint "$SERVER_PLIST" "$BACKUP_PLIST" >/dev/null || die "generated plist is invalid"

# 5. (Re)load both agents.
for label in "$SERVER_LABEL" "$BACKUP_LABEL"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
done
sleep 1
launchctl bootstrap "$DOMAIN" "$SERVER_PLIST"
launchctl bootstrap "$DOMAIN" "$BACKUP_PLIST"
ok "launchd agents loaded ($SERVER_LABEL, $BACKUP_LABEL)"

# 6. Wait for the server.
for _ in $(seq 1 30); do
  health && break
  sleep 0.5
done
health || die "server did not become healthy; see $LOG_DIR/server.log"
ok "server healthy on http://127.0.0.1:$PM_PORT (sign-up: $PM_ALLOW_SIGNUP)"

# 7. Back up right away so there is always a recent copy after an upgrade.
launchctl kickstart "$DOMAIN/$BACKUP_LABEL" >/dev/null 2>&1 || true

echo
echo "Data:     $DATA_DIR"
echo "Backups:  $BACKUP_DIR${PM_BACKUP_MIRROR_DIR:+  (mirror: $PM_BACKUP_MIRROR_DIR)}"
echo "Logs:     $LOG_DIR"
if TS="$(find_tailscale)" && [[ -n "$TS" ]]; then
  echo "Next:     deploy/tailscale.sh   (publish it to your devices over HTTPS)"
else
  echo "Next:     install Tailscale (see DEPLOY.md), then run deploy/tailscale.sh"
fi
