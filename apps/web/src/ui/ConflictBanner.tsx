import { formatSeconds, todayLocal } from "@pm/shared";
import { findConflicts } from "../core/timeline.ts";
import { formatDayLong, pad2 } from "../core/views.ts";
import { useLive, useServices } from "./services.tsx";

const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const daysAgo = (n: number) => {
  const d = new Date();
  return todayLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));
};

/**
 * Two devices that were apart may have logged the same time: two TIMER logs,
 * or two manual ones (a timer log over a manual one is settled for you: the
 * timer wins). Shows the first such pair; keeping one deletes the other.
 */
export function ConflictBanner() {
  const { logs } = useServices();
  const conflicts = useLive(async (s) => findConflicts(await s.store.listLogsBetween(daysAgo(60), daysAgo(-1))), []);
  const c = conflicts?.[0];
  if (!c) return null;
  const side = (e: typeof c.a, span: typeof c.aSpan, drop: string) => (
    <button className="ghost small conflict-keep" onClick={() => void logs.remove(drop)}>
      Keep <strong>{e.taskTitle}</strong> {clock(span.start)}–{clock(span.end)}{" "}
      <span className="muted">({formatSeconds(e.seconds)})</span>
    </button>
  );
  return (
    <div className="conflict" role="alert">
      <p>
        Two {c.a.source === "manual" ? "manual logs" : "timer logs"} overlap on {formatDayLong(c.a.day)}
        {conflicts!.length > 1 ? ` (and ${conflicts!.length - 1} more)` : ""}. Which one do you keep?
      </p>
      <div className="conflict-actions">
        {side(c.a, c.aSpan, c.b.id)}
        {side(c.b, c.bSpan, c.a.id)}
      </div>
    </div>
  );
}
