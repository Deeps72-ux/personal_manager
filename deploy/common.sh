# Shared settings for the deploy scripts (macOS). Sourced, not run.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Outside ~/Documents on purpose: macOS privacy protection (TCC) blocks
# background launchd jobs from reading ~/Documents, ~/Desktop, ~/Downloads.
APP_HOME="$HOME/Library/Application Support/PersonalManager"
APP_DIR="$APP_HOME/app"
DATA_DIR="$APP_HOME/data"
BACKUP_DIR="$APP_HOME/backups"
SETTINGS="$APP_HOME/settings.env"
LOG_DIR="$HOME/Library/Logs/PersonalManager"

AGENTS="$HOME/Library/LaunchAgents"
SERVER_LABEL="com.personalmanager.server"
BACKUP_LABEL="com.personalmanager.backup"
SERVER_PLIST="$AGENTS/$SERVER_LABEL.plist"
BACKUP_PLIST="$AGENTS/$BACKUP_LABEL.plist"
DOMAIN="gui/$(id -u)"

# Defaults; overridden by settings.env (written by install.sh).
PM_PORT=7810
PM_ALLOW_SIGNUP=true
PM_BACKUP_KEEP=30
PM_BACKUP_MIRROR_DIR=""
PM_BACKUP_HOUR=3
# shellcheck disable=SC1090
[[ -f "$SETTINGS" ]] && source "$SETTINGS"

say() { printf '\033[1;34m•\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

find_node() {
  local node
  node="$(command -v node || true)"
  [[ -n "$node" ]] || die "node not found in PATH (install with: brew install node)"
  "$node" -e 'const [a]=process.versions.node.split(".").map(Number);process.exit(a>=24?0:1)' ||
    die "Node $("$node" -v) is too old: need >= 24 (built-in SQLite + Argon2)"
  echo "$node"
}

find_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
  elif [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
    echo "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  fi
}

health() { curl -fsS --max-time 3 "http://127.0.0.1:$PM_PORT/api/health" >/dev/null 2>&1; }

# sed, not ${s//&/...}: in bash ≥ 5.2 a bare & in the replacement means "the match".
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
