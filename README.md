# Personal Manager

A personal app with five sections, synced across a MacBook Air M1, a Windows 11 laptop and a Samsung Galaxy M31:

| Section | What it does |
|---|---|
| **TASKS** | Add or remove task cards: title, optional description, optional due date. Sort them into **folders** (nested, any depth): ＋ New folder, ✎ rename (names are unique among siblings), ✕ remove (also deletes everything inside, after a confirm that counts it). Tap a folder to open it; new tasks go into the open folder. New tasks and folders, and anything moved in, go to the very **top** of the folder (above its older folders) until you drag them elsewhere. Drag a card or folder onto a folder to move it in, onto a name in the path to move it out, or between items to reorder (long-press on touch); or use **Move to…**. The open folder is remembered per device. Folders only shape this tab: every other section lists tasks exactly as before, with the name of the task's folder on its card |
| **PRIORITY** | All cards in one stack. Drag and drop sets the order; new cards go on top; the order syncs. Top right: the **waiting queue**. Drag a card onto it to park it (it leaves the list). Tapping it shows a pipeline, newest on top and oldest at the bottom. Each task goes from blue to red over an hour, then pulses faster; the icon glows by the oldest task. Dragging the bottom task out puts it back at the top of the priority list (#1). Next to it, the **confirm ✓** icon: reordering, adding, deleting, queuing and un-queuing only change what you see. Scores use the last confirmed order until you press ✓, which snapshots the visible list (never the queue) at that moment. It can only be pressed when the order or ranks have changed. **Ranks**: each card's # starts as its position; tap it to type a rank (1 up to the number of cards; cards can share one, and the card moves to sit with it, other cards keep their numbers) or clear it. A folder's rank (set with # on its row in the Tasks tab) goes to every task inside it, at any depth, and wins over a typed rank; the nearest ranked folder wins. A drag, queuing, un-queuing or a new task erases every typed rank (positions become the list as shown); folder ranks stay. **Drops beat folders**: a card (in a folder or not) dropped above a folder's group takes that slot's rank, and the group and everything below move down a step (the folder's # in the Tasks tab too); dropped between tied cards of a folder it shares their rank; dragged out of its own folder's group, only that card leaves (its position is its own rank from then on, the folder keeps its group) until it is dragged back next to them; reordering inside a group changes nothing else. **Scheduled lists** (clock icon): plan the list for any future slot (date, start, end to the minute; slots never overlap) in a copy of the list with the same drag / # / leave-out controls. At the start a device makes it the visible list and confirms it (tasks added since go on top, deleted ones drop out, its queued tasks come out, others are queued); at the end the list from before comes back. A ✓ pressed during a slot only lasts until its end. Future slots can be edited or deleted, a running one ended earlier or later, past ones are listed read-only. Scores follow the slots even if no device was open at the start |
| **LOG** | Calendar → a day. Its 24 hours are a **split bar**: time already logged and the running timer are locked. Double-tap to cut (whole minutes), drag a divider to move it or onto a neighbour to merge, pinch / Ctrl+scroll to zoom (down to 15 min), tap a piece and type (or tap a task) its activity right in the bar, and save. Typing narrows the task cards to the matches (title, folder name or description; best match first) and suggests matching activities logged before as chips; tap one to fill it in. Each piece has its activity's colour; unlogged time is red; logged time is faded. Each log is listed slice by slice, with its colour: one slice per confirmed priority order in force while it ran, with that order's #1 task and the slice's own deviation |
| **TIMER** | One timer shared by every device. Opening it shows the time since the last restart as a **split bar**, typed into straight away: one piece = **one** activity (`Activity;`; the `;` is added if missing, and nothing may follow it). Typing narrows the task cards below to the matches (title, folder or description), with activities logged before as chips; tap one to fill it in. Double-tap the bar to cut it into pieces of any size (whole minutes, at least 1 minute each), the same as a LOG day: give each piece its own activity or leave it unlogged; same-activity neighbours become one log. ✓ logs them. ✕ restarts without logging |
| **INSIGHTS** | **Focus** per clock hour = 100 / (1 + activity switches); an empty stretch counts as a switch. **Deviation** per slice = 100·(m − 1)/(n + 1) against the confirmed priority list in force then (a scheduled list during its slot), where n = the number of different ranks in that list and m = the step of the activity's rank among them (ties score the same, gaps don't count: ranks 1, 1, 4 are steps 1, 1, 2; older confirmed lists rank by position) (the queue is never part of it); anything not in that list (queued, new, or not a task) gets the worst score, n/(n + 1). A log that ran under several confirmed orders gets one score per slice, never an average |

When two devices that were apart log the same time, a timer log trims a manual one (on the server). Two timer logs, or two manual logs, are shown to you to pick which one to keep.

It also exports logs to Excel for a date range and deletes logs older than a chosen date. All deletes are hard deletes.

**Running it for real:** see [DEPLOY.md](DEPLOY.md). It covers the Mac service, Tailscale, installing on each device, backups and restore.

## Architecture

```
 Mac / Windows / M31: installable PWA (React), works offline
   IndexedDB (local copy) + outbox + cursor  ──push/pull──┐
                                                          ▼
 Mac M1: Node server (Hono)  ← reached via Tailscale HTTPS (MagicDNS)
   SQLite: users, tasks, placements, folders, log_entries, priority_history, priority_slots, change_log (server only)
```

- **Offline-first:** the UI only reads and writes the local DB; a SyncEngine pushes the outbox and pulls `change_log` entries after the device's cursor.
- **Conflicts:** field-level patches; when two devices change the same field, the one that reaches the server last wins; delete beats edit.
- **Ordering:** fractional-index ranks, so a drag changes only one row.
- **Hexagonal server:** `domain` ← `application` (use cases) → `ports` (interfaces) ← `adapters` (http, sqlite, crypto). Only `main.ts` wires the concrete adapters together.

## Repo layout

```
packages/shared   types, zod schemas, sync protocol, UUIDv7, ranks, seconds parser
apps/server       hexagonal API
  src/domain        errors (no framework imports)
  src/ports         interfaces: repositories, unit of work, clock, hasher, tokens, notifier
  src/application   use cases: SignUp/SignIn/SignOut/Authenticate, PushChanges (one handler per op), PullChanges, Cleanup
  src/adapters      sqlite (node:sqlite + SQL migrations), crypto (Argon2id, tokens), http (Hono), realtime (SSE hub)
  src/container.ts  composition root: the only file that knows concrete classes
  test/             use-case tests on in-memory SQLite with a fake clock
packages/test-server  starts the server as a separate process for tests
tests/blackbox    HTTP-only tests against a spawned server process (works for any implementation)
apps/web          offline-first React PWA, hexagonal too
  src/core          ports + use cases: TaskActions, PriorityActions, LogActions, AuthService, SyncEngine, ExportLogs
  src/adapters      Dexie (IndexedDB), in-memory store, HTTP API, SSE over fetch, Excel writer
  src/ui            React screens: TASKS · PRIORITY (dnd-kit) · LOG (calendar → day sheet)
  src/main.tsx      composition root
  test/             store contract (memory + IndexedDB), actions, SyncEngine vs real server, Excel, UI flows (jsdom)
```

## Commands

```bash
npm install                 # once
npm run check               # typecheck + all tests
npm run dev:server          # API on 127.0.0.1:3000 (data in ./apps/server/data)
npm run dev:web             # PWA on http://localhost:5173 (proxies /api to :3000)
npm run build               # production PWA → apps/web/dist
npm run icons               # regenerate PWA icons
SERVER_CMD="python server.py" npx vitest run tests   # check another implementation
```

If port 5173 is taken: `npm run dev -w @pm/web -- --port 5180`.

Requires Node ≥ 24. The server runs TypeScript natively (no build step), so imports use `.ts` extensions, and constructor parameter properties are not used.

## Server configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Localhost only; Tailscale `serve` forwards to it |
| `PORT` | `3000` | `0` picks a free port |
| `DATA_DIR` | `./data` | Holds `personal-manager.db` |
| `ALLOW_SIGNUP` | `true` | Set `false` once your account exists |
| `SESSION_TTL_DAYS` | `90` | Sliding login lifetime per device |
| `AUTH_RATE_LIMIT_MAX` / `_WINDOW_MS` | `10` / `60000` | Sign-in attempts per username per window |
| `SSE_HEARTBEAT_MS` | `25000` | Keep-alive ping on the event stream |

## API

All endpoints are under `/api`. Errors look like `{ "error": "<code>", "message": "..." }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | – | Liveness |
| POST | `/auth/signup` | – | `{username, password}` → `201 {token, user}` |
| POST | `/auth/signin` | – | `{username, password}` → `{token, user}` |
| POST | `/auth/signout` | Bearer | Revoke this device's token |
| GET | `/me` | Bearer | Current user |
| POST | `/sync/push` | Bearer | `{changes: Change[]}` → per-change `applied` / `ignored` |
| GET | `/sync/pull?cursor=N` | Bearer | Changes after N (incremental or snapshot, paged) |
| GET | `/sync/events` | Bearer | SSE: `changed` events with the latest cursor |

## Build plan

- [x] **Phase A: Foundation.** 0 skeleton · 1 shared package
- [x] **Phase B: Server.** 2 core · 3 SQLite · 4 auth and isolation · 5 sync API · 6 SSE · 7 black-box tests
- [x] **Phase C: PWA.** 8 shell · 9 local store · 10 SyncEngine · 11 TASKS · 12 PRIORITY · 13 LOG · 14 export and purge
- [x] **Phase D: Run it.** 15 Mac service (launchd, auto-restart, daily verified backups, restore) · Tailscale publish script · 16 device install guide and end-to-end checklist in DEPLOY.md
  - [ ] your steps: install and log in to Tailscale, enable HTTPS certs, run `deploy/tailscale.sh`, install on Windows and the M31 (DEPLOY.md steps 2–6)
