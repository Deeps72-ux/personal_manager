/**
 * SyncEngine: keeps the local copy and the server in step (design Step 4).
 *
 *   syncNow():  push outbox (in batches) → pull pages until caught up
 *               → re-apply still-pending outbox changes ("rebase")
 *
 * Triggers (wired by main.tsx / this class):
 *   - requestSync() after every local change (debounced)
 *   - SSE "changed" event with a newer cursor
 *   - app comes to the foreground / back online
 *   - a slow fallback timer while visible
 *
 * Single-flight: overlapping requests collapse into "run once more after".
 */
import { SYNC_LIMITS, type Change, type PullResponse } from "@pm/shared";
import { applyChangeLocally } from "./apply-change.ts";
import { AuthExpiredError, NetworkError, RemoteError } from "./errors.ts";
import type { LocalStore, RealtimeChannel, RealtimeStatus, RemoteApi, SyncTrigger } from "./ports.ts";

export type SyncState = "idle" | "syncing" | "offline" | "unauthorized" | "error";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncedAt: number | null;
  realtime: RealtimeStatus;
  message: string | null;
}

export interface SyncEngineDeps {
  store: LocalStore;
  api: RemoteApi;
  realtime?: RealtimeChannel;
  /** Called once when the server rejects the session. */
  onUnauthorized?: () => void;
  debounceMs?: number;
  /** Retry backoff after a failed sync (defaults 1s → 30s). */
  retryMinMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

export class SyncEngine implements SyncTrigger {
  private readonly deps: SyncEngineDeps;
  private status: SyncStatus = { state: "idle", pending: 0, lastSyncedAt: null, realtime: "closed", message: null };
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disconnect: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;

  constructor(deps: SyncEngineDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribeStore = this.deps.store.subscribe(() => void this.refreshPending());
    this.disconnect =
      this.deps.realtime?.connect({
        onChanged: (cursor) => void this.onRemoteCursor(cursor),
        onStatus: (realtime) => {
          const reopened = realtime === "open" && this.status.realtime !== "open";
          this.update({ realtime });
          // Events may have been missed while the stream was down: catch up.
          if (reopened) this.requestSync();
        },
      }) ?? null;
    void this.refreshPending();
    void this.syncNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelay = 0;
    this.disconnect?.();
    this.disconnect = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  /** Debounced: many quick edits → one sync. */
  requestSync(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, this.deps.debounceMs ?? 300);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run a full push + pull now (or once more after the current run). */
  syncNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.cycle();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async onRemoteCursor(cursor: number) {
    if (cursor > (await this.deps.store.cursor())) void this.syncNow();
  }

  private async cycle(): Promise<void> {
    this.update({ state: "syncing", message: null });
    try {
      await this.push();
      await this.pull();
      this.retryDelay = 0;
      this.update({ state: "idle", lastSyncedAt: (this.deps.now ?? Date.now)() });
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        this.update({ state: "unauthorized", message: err.message });
        this.stop();
        this.deps.onUnauthorized?.();
      } else if (err instanceof NetworkError) {
        this.update({ state: "offline", message: "Server unreachable; changes are saved on this device" });
        this.scheduleRetry();
      } else {
        console.error("sync failed", err);
        this.update({ state: "error", message: err instanceof Error ? err.message : String(err) });
        this.scheduleRetry();
      }
    } finally {
      await this.refreshPending();
    }
  }

  /**
   * After a failure, try again on our own: 1s, 2s, 4s … capped at 30s.
   * A stalled request on a phone (Wi-Fi power-save, VPN reconnect) usually
   * succeeds on the very next attempt over a fresh connection.
   */
  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const min = this.deps.retryMinMs ?? 1000;
    const max = this.deps.retryMaxMs ?? 30_000;
    this.retryDelay = this.retryDelay ? Math.min(this.retryDelay * 2, max) : min;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow();
    }, this.retryDelay);
  }

  private async push(): Promise<void> {
    let previous = Infinity;
    for (;;) {
      const outbox = await this.deps.store.listOutbox();
      if (outbox.length === 0) return;
      if (outbox.length >= previous) throw new Error("server did not acknowledge pushed changes");
      previous = outbox.length;
      const batch = outbox.slice(0, SYNC_LIMITS.maxPushChanges);
      try {
        await this.pushBatch(batch);
      } catch (err) {
        // A change the server refuses as invalid would block the queue forever:
        // retry one by one and drop only the poisoned ones.
        if (err instanceof RemoteError && err.code === "invalid_request") await this.pushOneByOne(batch);
        else throw err;
      }
    }
  }

  private async pushBatch(batch: readonly Change[]) {
    const res = await this.deps.api.push(batch);
    const purgedLogs: string[] = [];
    for (const r of res.results) {
      if (r.status === "ignored" && r.reason === "purged") {
        const c = batch.find((x) => x.changeId === r.changeId);
        if (c?.op === "createLog") purgedLogs.push(c.entry.id);
      }
    }
    if (purgedLogs.length) {
      await this.deps.store.write(async (tx) => {
        for (const id of purgedLogs) await tx.deleteLog(id);
      });
    }
    await this.deps.store.removeFromOutbox(res.results.map((r) => r.changeId));
  }

  private async pushOneByOne(batch: readonly Change[]) {
    for (const change of batch) {
      try {
        await this.pushBatch([change]);
      } catch (err) {
        if (err instanceof RemoteError && err.code === "invalid_request") {
          console.warn("dropping change rejected by server", change, err.message);
          await this.deps.store.removeFromOutbox([change.changeId]);
        } else throw err;
      }
    }
  }

  private async pull(): Promise<void> {
    for (;;) {
      const page = await this.deps.api.pull(await this.deps.store.cursor());
      await this.apply(page);
      if (!page.hasMore) return;
    }
  }

  private async apply(p: PullResponse) {
    await this.deps.store.write(async (tx) => {
      if (p.mode === "snapshot") await tx.clearSynced();
      for (const id of p.deletes.placements) await tx.deletePlacement(id);
      for (const id of p.deletes.tasks) await tx.deleteTask(id);
      for (const id of p.deletes.logEntries) await tx.deleteLog(id);
      for (const t of p.upserts.tasks) await tx.putTask(t);
      for (const pl of p.upserts.placements) await tx.putPlacement(pl);
      for (const l of p.upserts.logEntries) await tx.putLog(l);
      await tx.setPurgedBefore(p.purgedBefore);
      await tx.setCursor(p.cursor);
      // Rebase: changes made while this sync was running stay visible.
      for (const c of await tx.listOutbox()) await applyChangeLocally(tx, c);
    });
  }

  private async refreshPending() {
    const pending = (await this.deps.store.listOutbox()).length;
    if (pending !== this.status.pending) this.update({ pending });
  }

  private update(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }
}
