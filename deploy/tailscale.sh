#!/usr/bin/env bash
# Publish the local server to your tailnet over HTTPS:
#   https://<this-mac>.<tailnet>.ts.net  →  http://127.0.0.1:<port>
#
#   deploy/tailscale.sh          set up (persists across reboots)
#   deploy/tailscale.sh --off    stop publishing
set -euo pipefail
source "$(dirname "$0")/common.sh"

TS="$(find_tailscale)"
[[ -n "$TS" ]] || die "Tailscale is not installed. See DEPLOY.md step 2."

if ! "$TS" status >/dev/null 2>&1; then
  die "Tailscale is installed but not connected. Open the Tailscale app and log in, then re-run."
fi

if [[ "${1:-}" == "--off" ]]; then
  "$TS" serve --https=443 off || true
  ok "stopped publishing"
  exit 0
fi

health || die "local server is not running on port $PM_PORT. Run deploy/install.sh first."

DNS="$("$TS" status --json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
[[ -n "$DNS" ]] || die "could not read this Mac's Tailscale name. Is MagicDNS enabled in the admin console?"

say "publishing https://$DNS → http://127.0.0.1:$PM_PORT"
if ! "$TS" serve --bg --https=443 "http://127.0.0.1:$PM_PORT"; then
  warn "serve failed. Usually HTTPS certificates are not enabled yet:"
  warn "  https://login.tailscale.com/admin/dns → enable MagicDNS and 'HTTPS Certificates'"
  exit 1
fi

say "checking it from this Mac (first request also fetches the certificate; can take ~30s)"
for _ in $(seq 1 30); do
  curl -fsS --max-time 10 "https://$DNS/api/health" >/dev/null 2>&1 && break
  sleep 2
done
if curl -fsS --max-time 10 "https://$DNS/api/health" >/dev/null 2>&1; then
  ok "live at https://$DNS"
  echo
  echo "Open that URL on each device (Tailscale app on and logged in) and install the app."
else
  warn "not reachable yet over HTTPS. Check: $TS serve status"
  exit 1
fi
