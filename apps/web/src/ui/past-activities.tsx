import type { LogEntry } from "@pm/shared";
import { useLive } from "./services.tsx";

/** Every log on this device (for suggesting activities typed before). */
export function useAllLogs(): readonly LogEntry[] {
  return useLive((s) => s.store.listLogsBetween("0000-01-01", "9999-12-31"), []) ?? [];
}

/** Small tappable chips: activities logged before that are not tasks. */
export function PastActivityChips({ titles, onPick }: { titles: readonly string[]; onPick: (title: string) => void }) {
  if (titles.length === 0) return null;
  return (
    <div className="past-chips" aria-label="Logged before">
      {titles.map((t) => (
        <button
          key={t}
          type="button"
          className="past-chip"
          // keep focus (and the phone keyboard) on the bar
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onPick(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
