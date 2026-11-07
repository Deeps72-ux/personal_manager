#!/usr/bin/env bash
# One-screen health report: service, version, data, backups, Tailscale.
set -uo pipefail
source "$(dirname "$0")/common.sh"

agent_state() {
  local out
  out="$(launchctl print "$DOMAIN/$1" 2>/dev/null)" || {
    echo "not loaded"
    return
  }
  local state pid code
  state="$(awk -F'= ' '/^\tstate = /{print $2; exit}' <<<"$out")"
  pid="$(awk -F'= ' '/^\tpid = /{print $2; exit}' <<<"$out")"
  code="$(awk -F'= ' '/last exit code = /{print $2; exit}' <<<"$out")"
  echo "${state:-?}${pid:+ (pid $pid)}${code:+, last exit $code}"
}

echo "Personal Manager on $(scutil --get ComputerName 2>/dev/null || hostname)"
echo "  version:   $(cat "$APP_DIR/VERSION" 2>/dev/null || echo 'not installed')"
echo "  server:    $(agent_state "$SERVER_LABEL")"
if health; then
  echo "  health:    ok  http://127.0.0.1:$PM_PORT"
else
  echo "  health:    DOWN (see $LOG_DIR/server.log)"
fi
echo "  sign-up:   $PM_ALLOW_SIGNUP"

DB="$DATA_DIR/personal-manager.db"
if [[ -f "$DB" ]]; then
  echo "  database:  $(du -h "$DB" | cut -f1)  $DB"
fi

echo "  backup:    $(agent_state "$BACKUP_LABEL")"
LATEST="$(ls -1t "$BACKUP_DIR"/personal-manager-*.db 2>/dev/null | head -1)"
if [[ -n "$LATEST" ]]; then
  COUNT="$(ls -1 "$BACKUP_DIR"/personal-manager-*.db | wc -l | tr -d ' ')"
  echo "  backups:   $COUNT kept, latest $(basename "$LATEST") ($(du -h "$LATEST" | cut -f1 | tr -d " "))"
else
  echo "  backups:   none yet"
fi
[[ -n "$PM_BACKUP_MIRROR_DIR" ]] && echo "  mirror:    $PM_BACKUP_MIRROR_DIR"

TS="$(find_tailscale)"
if [[ -z "$TS" ]]; then
  echo "  tailscale: not installed"
elif ! "$TS" status >/dev/null 2>&1; then
  echo "  tailscale: installed, NOT connected"
else
  DNS="$("$TS" status --json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null)"
  if "$TS" serve status 2>/dev/null | grep -q "127.0.0.1:$PM_PORT"; then
    echo "  tailscale: published at https://$DNS"
  else
    echo "  tailscale: connected as $DNS, but NOT published (run deploy/tailscale.sh)"
  fi
fi

if [[ -f "$LOG_DIR/backup.log" ]]; then
  echo
  echo "Last backup log line:"
  tail -1 "$LOG_DIR/backup.log" | sed 's/^/  /'
fi
