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
apps/server       hexagonal API (Phase B)
apps/web          React PWA (Phase C)
```

## Commands

```bash
npm install          # once
npm run check        # typecheck + all tests
npm test             # tests only
npm start -w @pm/server
```

Requires Node ≥ 24. The server runs TypeScript natively (no build step), so imports use `.ts` extensions.

## Build plan

- [x] **Phase A: Foundation.** 0 skeleton · 1 shared package
- [ ] **Phase B: Server.** 2 core · 3 SQLite · 4 auth and isolation · 5 sync API · 6 SSE · 7 black-box tests
- [ ] **Phase C: PWA.** 8 shell · 9 local store · 10 SyncEngine · 11 TASKS · 12 PRIORITY · 13 LOG · 14 export and purge
- [ ] **Phase D: Run it.** 15 deploy on the Mac (launchd, Tailscale, backups) · 16 install on devices and do the end-to-end check
