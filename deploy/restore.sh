#!/usr/bin/env bash
# Restore the database from a backup file.
#
#   deploy/restore.sh                         list available backups
#   deploy/restore.sh <backup-file.db>        restore it (current DB is kept aside)
#
# Devices notice automatically: their sync cursor is now "ahead" of the
# server, so each one downloads a fresh snapshot on its next sync. Changes
# still waiting in a device's outbox are re-sent and land on top.
set -euo pipefail
source "$(dirname "$0")/common.sh"

if [[ $# -eq 0 ]]; then
  echo "Backups in $BACKUP_DIR (newest first):"
  ls -1t "$BACKUP_DIR"/personal-manager-*.db 2>/dev/null | sed 's/^/  /' || echo "  (none)"
  echo
  echo "Usage: $0 <backup-file.db>"
  exit 0
fi

SRC="$1"
[[ -f "$SRC" ]] || die "no such file: $SRC"
NODE="$(find_node)"

say "verifying $SRC"
"$NODE" -e '
  const { DatabaseSync } = require("node:sqlite");
  try {
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const r = db.prepare("PRAGMA integrity_check").get();
    if (r.integrity_check !== "ok") throw new Error("integrity check failed");
    for (const t of ["users", "tasks", "log_entries", "change_log"]) db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).all();
  } catch (e) {
    console.error("  " + e.message);
    process.exit(1);
  }
' "$SRC" || die "that file is not a valid Personal Manager backup"
ok "backup is valid"

DB="$DATA_DIR/personal-manager.db"
STAMP="$(date +%Y%m%d-%H%M%S)"

say "stopping the server"
launchctl bootout "$DOMAIN/$SERVER_LABEL" 2>/dev/null || true
sleep 1

if [[ -f "$DB" ]]; then
  mkdir -p "$DATA_DIR/replaced"
  for f in "$DB" "$DB-wal" "$DB-shm"; do
    [[ -f "$f" ]] && mv "$f" "$DATA_DIR/replaced/$(basename "$f").$STAMP"
  done
  ok "previous database kept in $DATA_DIR/replaced/"
fi
cp "$SRC" "$DB"
chmod 600 "$DB"

say "starting the server"
launchctl bootstrap "$DOMAIN" "$SERVER_PLIST"
for _ in $(seq 1 30); do
  health && break
  sleep 0.5
done
health || die "server did not come back; see $LOG_DIR/server.log"
ok "restored from $(basename "$SRC")"
