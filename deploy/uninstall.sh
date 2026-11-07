#!/usr/bin/env bash
# Stop and remove the background service. Your data and backups are KEPT
# unless you pass --delete-data (asks for confirmation).
set -euo pipefail
source "$(dirname "$0")/common.sh"

for label in "$SERVER_LABEL" "$BACKUP_LABEL"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null && ok "stopped $label" || true
done
rm -f "$SERVER_PLIST" "$BACKUP_PLIST"
rm -rf "$APP_DIR" "$APP_DIR.previous" "$APP_DIR.new"
ok "service removed"

if TS="$(find_tailscale)" && [[ -n "$TS" ]] && "$TS" serve status 2>/dev/null | grep -q "127.0.0.1:$PM_PORT"; then
  "$TS" serve --https=443 off >/dev/null 2>&1 && ok "stopped publishing on Tailscale"
fi

if [[ "${1:-}" == "--delete-data" ]]; then
  read -r -p "Permanently delete ALL data and backups in '$APP_HOME'? Type DELETE: " answer
  if [[ "$answer" == "DELETE" ]]; then
    rm -rf "$APP_HOME"
    ok "data deleted"
  else
    warn "kept data"
  fi
else
  echo "Data and backups kept in: $APP_HOME"
fi
