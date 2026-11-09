import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { LogActions, PriorityActions, TaskActions, TimerActions } from "../core/actions.ts";
import type { AuthService, SessionHolder } from "../core/auth.ts";
import type { ExportLogs } from "../core/export-logs.ts";
import type { LocalStore } from "../core/ports.ts";
import type { SyncEngine, SyncStatus } from "../core/sync-engine.ts";

/** Everything the UI may use. Built by main.tsx (or by tests with fakes). */
export interface Services {
  store: LocalStore;
  holder: SessionHolder;
  auth: AuthService;
  sync: SyncEngine;
  tasks: TaskActions;
  priority: PriorityActions;
  logs: LogActions;
  timer: TimerActions;
  exporter: ExportLogs;
}

const Ctx = createContext<Services | null>(null);

export function ServicesProvider({ value, children }: { value: Services; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServices(): Services {
  const s = useContext(Ctx);
  if (!s) throw new Error("ServicesProvider missing");
  return s;
}

/**
 * Re-runs `query` whenever the local store changes (this tab, another tab,
 * or a sync) and returns the latest result. `undefined` while loading.
 */
export function useLive<T>(query: (s: Services) => Promise<T>, deps: readonly unknown[]): T | undefined {
  const services = useServices();
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const run = () => {
      const mine = ++seq;
      query(services).then(
        (v) => alive && mine === seq && setValue(() => v),
        (err) => console.error("query failed", err),
      );
    };
    run();
    const off = services.store.subscribe(run);
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, ...deps]);
  return value;
}

export function useSyncStatus(): SyncStatus {
  const { sync } = useServices();
  const [status, setStatus] = useState(sync.getStatus());
  useEffect(() => sync.subscribe(setStatus), [sync]);
  return status;
}
