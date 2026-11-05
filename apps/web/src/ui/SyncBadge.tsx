import { useServices, useSyncStatus } from "./services.tsx";

export function SyncBadge() {
  const { sync } = useServices();
  const s = useSyncStatus();

  let label: string;
  let tone: "ok" | "busy" | "warn" | "bad";
  switch (s.state) {
    case "syncing":
      label = "Syncing…";
      tone = "busy";
      break;
    case "offline":
      label = s.pending ? `Offline · ${s.pending} pending` : "Offline";
      tone = "warn";
      break;
    case "unauthorized":
      label = "Signed out";
      tone = "bad";
      break;
    case "error":
      label = "Sync error";
      tone = "bad";
      break;
    default:
      label = s.pending ? `${s.pending} pending` : "Synced";
      tone = s.pending ? "busy" : "ok";
  }
  const title =
    (s.message ? `${s.message}\n` : "") +
    (s.lastSyncedAt ? `Last synced ${new Date(s.lastSyncedAt).toLocaleTimeString()}` : "Not synced yet") +
    `\nLive updates: ${s.realtime}` +
    "\nClick to sync now";

  return (
    <button className={`syncbadge ${tone}`} onClick={() => void sync.syncNow()} title={title} aria-live="polite">
      <span className={`dot ${s.realtime === "open" ? "live" : ""}`} aria-hidden />
      {label}
    </button>
  );
}
