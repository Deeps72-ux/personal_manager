# Personal Manager

A personal app with three sections, synced across a MacBook Air M1, a Windows 11 laptop and a Samsung Galaxy M31:

| Section | What it does |
|---|---|
| **TASKS** | Add or remove task cards: title, optional description, optional due date |
| **PRIORITY** | All cards in one stack. Drag and drop sets the order; new cards go on top; the order syncs |
| **LOG** | Calendar → a day → rows of `seconds → task title`. A day can't go over 24 h (UI-only rule) |

It also exports logs to Excel for a date range and deletes logs older than a chosen date. All deletes are hard deletes.

## Architecture

```
 Mac / Windows / M31: installable PWA (React), works offline
   IndexedDB (local copy) + outbox + cursor  ──push/pull──┐
                                                          ▼
 Mac M1: Node server (Hono)  ← reached via Tailscale HTTPS (MagicDNS)
   SQLite: users, tasks, placements, log_entries, change_log (server only)
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
- [ ] **Phase D: Run it.** 15 deploy on the Mac (launchd, Tailscale, backups) · 16 install on devices and do the end-to-end check
