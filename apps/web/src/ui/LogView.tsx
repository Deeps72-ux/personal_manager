import { useMemo, useState, type CSSProperties } from "react";
import { DAY_SECONDS, dayBounds, formatSeconds, todayLocal, type Day, type LogEntry } from "@pm/shared";
import { knownSpan } from "../core/timeline.ts";
import { formatMonth, monthGrid, shiftMonth, totalsByDay } from "../core/views.ts";
import { DataTools } from "./DataTools.tsx";
import { useActivityHue } from "./colors.ts";
import { DaySheet } from "./DaySheet.tsx";
import { ChevronLeft, ChevronRight } from "./icons.tsx";
import { useLive } from "./services.tsx";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** LOG: calendar → click a day → day sheet. */
export function LogView() {
  const today = todayLocal();
  const [ym, setYm] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }));
  const [day, setDay] = useState<Day | null>(null);
  const [tools, setTools] = useState(false);

  if (day) return <DaySheet day={day} onBack={() => setDay(null)} />;
  return (
    <section className="view">
      <div className="calendar-head">
        <button className="icon" aria-label="Previous month" onClick={() => setYm(shiftMonth(ym.year, ym.month, -1))}>
          <ChevronLeft />
        </button>
        <h2>{formatMonth(ym.year, ym.month)}</h2>
        <button className="icon" aria-label="Next month" onClick={() => setYm(shiftMonth(ym.year, ym.month, 1))}>
          <ChevronRight />
        </button>
        <button
          className="ghost small today-btn"
          onClick={() => setYm({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) })}
        >
          Today
        </button>
        <button className={`ghost small ${tools ? "active" : ""}`} onClick={() => setTools(!tools)} aria-expanded={tools}>
          Export / clean up
        </button>
      </div>

      {tools && <DataTools />}

      <Calendar year={ym.year} month={ym.month} today={today} onPick={setDay} />
      <p className="hint">Pick a day to log how its 86,400 seconds were spent.</p>
    </section>
  );
}

function Calendar({ year, month, today, onPick }: { year: number; month: number; today: Day; onPick: (d: Day) => void }) {
  const weeks = useMemo(() => monthGrid(year, month), [year, month]);
  const first = weeks[0]![0]!.day;
  const last = weeks.at(-1)!.at(-1)!.day;
  const logs = useLive((s) => s.store.listLogsBetween(first, last), [first, last]);
  const totals = useMemo(() => totalsByDay(logs ?? []), [logs]);
  const strips = useMemo(() => dayStrips(logs ?? []), [logs]);
  const hue = useActivityHue();

  return (
    <div className="calendar" role="grid" aria-label={formatMonth(year, month)}>
      {WEEKDAYS.map((w) => (
        <div key={w} className="weekday" role="columnheader">
          {w}
        </div>
      ))}
      {weeks.flat().map((c) => {
        const total = totals.get(c.day) ?? 0;
        const pct = Math.min(100, (total / DAY_SECONDS) * 100);
        return (
          <button
            key={c.day}
            role="gridcell"
            className={`daycell ${c.inMonth ? "" : "outside"} ${c.day === today ? "today" : ""} ${total ? "has" : ""} ${total >= DAY_SECONDS ? "full" : ""}`}
            onClick={() => onPick(c.day)}
            aria-label={`${c.day}${total ? `, ${formatSeconds(total)} logged` : ""}`}
          >
            <span className="dnum">{c.dayOfMonth}</span>
            {total > 0 && <span className="dtotal">{formatSeconds(total)}</span>}
            <span className="dbar" aria-hidden>
              {strips.get(c.day)?.map((p, k) => (
                <span
                  key={k}
                  className="dbar-piece"
                  style={{ left: `${p.left}%`, width: `${p.width}%`, "--hue": hue(p.title) } as CSSProperties}
                />
              )) ?? (pct > 0 && <span className="dbar-fill" style={{ width: `${pct}%` }} />)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Each day's logs on its 24 hours, as % positions, for the coloured strip of a calendar cell. */
function dayStrips(entries: readonly LogEntry[]): Map<Day, { left: number; width: number; title: string }[]> {
  const out = new Map<Day, { left: number; width: number; title: string }[]>();
  for (const e of entries) {
    const span = knownSpan(e);
    if (!span) continue;
    const b = dayBounds(e.day);
    const w = b.end - b.start;
    const lo = Math.max(span.start, b.start);
    const hi = Math.min(span.end, b.end);
    if (hi <= lo) continue;
    const list = out.get(e.day) ?? [];
    list.push({ left: ((lo - b.start) / w) * 100, width: Math.max(0.6, ((hi - lo) / w) * 100), title: e.taskTitle });
    out.set(e.day, list);
  }
  return out;
}
