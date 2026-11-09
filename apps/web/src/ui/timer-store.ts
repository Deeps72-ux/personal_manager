/**
 * Timer helpers for the UI.
 *
 * The timer's start time now lives in the local database (see TimerActions),
 * so logging and restarting happen in one transaction. Older versions kept it
 * in localStorage under KEY; it is read once to carry the count over, then removed.
 */
const KEY = "pm.timer.startedAt";

export function readLegacyTimerStart(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null; // storage blocked (private mode)
  }
}

export function clearLegacyTimerStart(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clean up
  }
}

/** Elapsed ms as HH:MM:SS. Hours keep growing past 24 (e.g. "27:05:09"). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
