/**
 * Timer state, kept PER DEVICE (not synced, no server).
 *
 * Only one number is stored: the moment counting started (epoch ms).
 * Elapsed time is always computed from the clock, so it stays correct
 * while the app is closed, in the background, or the device sleeps.
 */
const KEY = "pm.timer.startedAt";

export function readTimerStart(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null; // storage blocked (private mode)
  }
}

export function saveTimerStart(ms: number): void {
  try {
    localStorage.setItem(KEY, String(ms));
  } catch {
    // not remembered across launches, but still works for this session
  }
}

/** Elapsed ms as HH:MM:SS. Hours keep growing past 24 (e.g. "27:05:09"). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
