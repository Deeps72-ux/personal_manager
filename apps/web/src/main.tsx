/**
 * Composition root of the PWA: the only file that picks concrete adapters.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { DexieStore } from "./adapters/dexie-store.ts";
import { HttpRemoteApi } from "./adapters/http-api.ts";
import { SseChannel } from "./adapters/sse-channel.ts";
import { BrowserFileSaver, XlsxLogWriter } from "./adapters/xlsx.ts";
import { LogActions, PriorityActions, TaskActions } from "./core/actions.ts";
import { AuthService, SessionHolder } from "./core/auth.ts";
import { ExportLogs } from "./core/export-logs.ts";
import { SyncEngine } from "./core/sync-engine.ts";
import { App } from "./ui/App.tsx";
import { ServicesProvider, type Services } from "./ui/services.tsx";
import { applyTheme, readTheme } from "./ui/theme.ts";
import "./ui/styles.css";

// Apply this device's saved appearance before the first render (no flash).
applyTheme(readTheme());

const BASE_URL = ""; // same origin: the Mac server serves both the app and /api

const db = new DexieStore("personal-manager");
const holder = new SessionHolder();
const getToken = () => holder.current?.token ?? null;
const api = new HttpRemoteApi({ baseUrl: BASE_URL, getToken });

let auth: AuthService;
const sync = new SyncEngine({
  store: db,
  api,
  realtime: new SseChannel({ baseUrl: BASE_URL, getToken }),
  onUnauthorized: () => void auth.expire(),
});
auth = new AuthService({ api, sessions: db, store: db, holder });

const services: Services = {
  store: db,
  holder,
  auth,
  sync,
  tasks: new TaskActions({ store: db, sync }),
  priority: new PriorityActions({ store: db, sync }),
  logs: new LogActions({ store: db, sync }),
  exporter: new ExportLogs({ store: db, writer: new XlsxLogWriter(), saver: new BrowserFileSaver() }),
};

// Sync triggers from the browser environment.
window.addEventListener("online", () => sync.requestSync());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sync.requestSync();
});
setInterval(() => {
  if (document.visibilityState === "visible") sync.requestSync();
}, 60_000);

// Ask the browser not to evict our offline data when storage is low.
void navigator.storage?.persist?.().catch(() => undefined);

// Service worker: caches the app shell so it opens offline; auto-updates.
registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesProvider value={services}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
