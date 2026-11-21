/**
 * How "hot" a task in the WAITING QUEUE looks after waiting `waitMs`:
 * blue when it goes in, through violet and magenta to full red at one hour,
 * then a pulse that keeps getting faster the longer it waits.
 */
import { useEffect, useState } from "react";

export const FULL_RED_MS = 60 * 60 * 1000;

export interface Heat {
  /** 0 (just queued) … 1 (one hour or more). */
  level: number;
  /** Hours past full red (0 before that). */
  overdue: number;
  /** CSS colour. Hue 220 (blue) → 360 (red), going round through violet, never through green. */
  color: string;
  /** Glow radius in px. */
  glow: number;
  /** Seconds per pulse, or null while not yet full red. */
  pulse: number | null;
}

export function heat(waitMs: number): Heat {
  const w = Math.max(0, waitMs);
  const level = Math.min(1, w / FULL_RED_MS);
  const overdue = Math.max(0, (w - FULL_RED_MS) / FULL_RED_MS);
  const hue = Math.round(220 + 140 * level) % 360;
  return {
    level,
    overdue,
    color: `hsl(${hue} ${Math.round(75 + 10 * level)}% ${Math.round(56 - 6 * level)}%)`,
    glow: Math.round(4 + 12 * level + Math.min(12, 4 * overdue)),
    pulse: w < FULL_RED_MS ? null : Math.max(0.35, 1.6 / (1 + overdue)),
  };
}

/** "45s", "12m", "1h 05m", "2d 3h". */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Current time, refreshed every `everyMs` while mounted. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
