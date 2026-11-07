# Deploying Personal Manager

Your MacBook Air runs the server and keeps the data. Your Windows laptop and Galaxy M31 reach it privately over Tailscale. Every device installs the same web app (a PWA) and keeps its own offline copy.

```
 Galaxy M31 ─┐                       MacBook Air M1
 Windows 11 ─┼── Tailscale (HTTPS) ──►  tailscale serve :443
 Mac itself ─┘                          → 127.0.0.1:7810  (launchd: com.personalmanager.server)
                                          ├─ /       the PWA
                                          ├─ /api    sync + auth
                                          └─ SQLite  ~/Library/Application Support/PersonalManager/data
                                        launchd: com.personalmanager.backup  (daily 03:00 → backups/)
```

---

## Step 1: Install the service on the Mac ✅ (done)

```bash
deploy/install.sh
```

This builds a self-contained release and installs it to `~/Library/Application Support/PersonalManager/app`. It also starts the server at login, restarts it if it crashes, and schedules a daily backup.

It installs outside `~/Documents` because macOS blocks background services from reading `~/Documents`.

Check it any time:

```bash
deploy/status.sh
```

---

## Step 2: Install Tailscale on the Mac (you)

1. Install the **Tailscale** app from the Mac App Store, or from https://tailscale.com/download/mac.
2. Open it, click **Log in**, and sign in with any account (Google, Microsoft, GitHub…). Approve the VPN prompt macOS shows.
3. In the admin console at https://login.tailscale.com/admin/dns:
   - turn on **MagicDNS** (it's usually on already)
   - under **HTTPS Certificates**, click **Enable**
4. Optional, so the name is readable: https://login.tailscale.com/admin/machines → your Mac → ⋯ → **Edit machine name**. Something like `mac` gives you `https://mac.<your-tailnet>.ts.net`.

   Certificate names appear in public certificate logs, so don't put anything private in the name.

## Step 3: Publish the app to your devices (on the Mac)

```bash
deploy/tailscale.sh
```

It prints your URL, e.g. `https://mac.tail1234.ts.net`. This setting survives reboots. `deploy/tailscale.sh --off` stops publishing.

---

## Step 4: Create your account (once)

On the Mac, open the URL from step 3 in Chrome, Edge or Safari, then **Create account**.

Then close sign-up so nobody else on your tailnet can register:

```bash
deploy/install.sh --no-signup
```

---

## Step 5: Install the app on each device

Each device needs the **Tailscale app, signed in to the same Tailscale account**.

### MacBook Air (Chrome or Edge)
1. Open your URL, then sign in.
2. Click the **install icon** (a monitor with a down arrow) at the right end of the address bar, then **Install**.
   - In Safari instead: **File → Add to Dock**.
3. It opens in its own window and appears in Launchpad and the Dock.

### Windows 11 laptop (Edge or Chrome)
1. Install Tailscale from https://tailscale.com/download/windows and log in with the same account.
2. In Edge, open your URL, then sign in.
3. Use the **App available → Install** icon in the address bar, or **⋯ → Apps → Install this site as an app**.
4. Pin it to the taskbar or Start menu if you like.

### Samsung Galaxy M31 (Chrome)
1. Install **Tailscale** from the Play Store, log in with the same account, and keep its VPN **on**.
   - Android allows only **one VPN at a time**. If you use another VPN app, they will conflict.
   - Recommended: **Settings → Apps → Tailscale → Battery → Unrestricted**, so Android doesn't cut the connection.
2. In **Chrome**, open your URL, then sign in.
3. Use **⋮ → Add to Home screen → Install**. Samsung Internet also works: **≡ → Add page to → Home screen**.
4. It opens full screen from the home-screen icon.

To reorder cards on a phone, **press and hold** a card, then drag.

---

## Step 6: End-to-end check (about 5 minutes)

| # | Do this | Expect |
|---|---|---|
| 1 | Phone: add task "Test A" | Laptop shows it at the top of PRIORITY within ~2 s |
| 2 | Laptop: drag "Test A" to the bottom | Phone shows the new order |
| 3 | Phone: turn on **airplane mode**, add task "Offline B", log 60 s on today | Works normally; badge says "Offline · 2 pending" |
| 4 | Phone: airplane mode **off**, open the app | Badge goes to "Synced"; Mac shows "Offline B" and the 60 s |
| 5 | Mac: delete "Offline B" in TASKS | Gone everywhere; the 60 s log entry stays |
| 6 | Laptop: try to log `25h` on one day | Blocked: "Over 24 hours" |
| 7 | Mac: **Log → Export / clean up → Download .xlsx** | Excel file with Day, Task, Seconds, Duration |
| 8 | Close the Mac's lid for a minute, edit on the phone, open the lid | Phone syncs when the Mac wakes; nothing lost |

Delete the test tasks afterwards.

---

## Keeping the Mac reachable

When the Mac sleeps, other devices keep working offline and sync when it wakes. If you want sync available all the time:
- **System Settings → Battery → Options → "Prevent automatic sleeping on power adapter when the display is off"** (only applies while plugged in).

This is your choice; the deploy scripts never change system settings.

---

## Backups

- Daily at 03:00 (or on wake, if the Mac was asleep then), plus one at every install or upgrade.
- Each backup is a consistent copy, **integrity-checked**, and the newest **30** are kept in `~/Library/Application Support/PersonalManager/backups/`.
- Time Machine, if enabled, also backs that folder up.
- **Recommended:** mirror each backup off the Mac, e.g. to iCloud Drive or an external disk:

  ```bash
  deploy/install.sh --mirror "$HOME/Library/Mobile Documents/com~apple~CloudDocs/PersonalManager-backups"
  ```

Back up right now:

```bash
launchctl kickstart gui/$(id -u)/com.personalmanager.backup
```

Restore:

```bash
deploy/restore.sh                     # list backups
deploy/restore.sh <file.db>           # verify, keep current DB aside, restore, restart
```

After a restore, every device downloads a fresh copy automatically on its next sync. Changes still waiting on a device are re-sent.

---

## Upgrading

```bash
git pull
deploy/install.sh        # rebuilds, swaps the app, restarts; settings and data untouched
```

Devices pick up the new version automatically the next time the app opens. The previous version is kept in `app.previous`.

## Uninstall

```bash
deploy/uninstall.sh                 # stop + remove the service; data and backups kept
deploy/uninstall.sh --delete-data   # also delete data (asks you to type DELETE)
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Badge says "Offline" on every device | Is the Mac awake? Run `deploy/status.sh` on the Mac |
| Phone can't open the URL | Tailscale app on the phone: connected? Same account? Another VPN active? |
| `tailscale.sh` says serve failed | Turn on **HTTPS Certificates** in the admin console (step 2.3) |
| Server down | `tail -50 ~/Library/Logs/PersonalManager/server.log` |
| "Signed out" on a device | Its session expired or was revoked. Sign in again; unsynced changes are kept |

| What | Where |
|---|---|
| App | `~/Library/Application Support/PersonalManager/app` |
| Data | `~/Library/Application Support/PersonalManager/data/personal-manager.db` |
| Backups | `~/Library/Application Support/PersonalManager/backups` |
| Settings | `~/Library/Application Support/PersonalManager/settings.env` |
| Logs | `~/Library/Logs/PersonalManager/` |
| Services | `~/Library/LaunchAgents/com.personalmanager.{server,backup}.plist` |
