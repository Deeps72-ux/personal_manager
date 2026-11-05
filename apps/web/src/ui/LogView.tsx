import { useMemo, useState } from "react";
import { DAY_SECONDS, formatSeconds, todayLocal, type Day } from "@pm/shared";
import { formatMonth, monthGrid, shiftMonth, totalsByDay } from "../core/views.ts";
import { DataTools } from "./DataTools.tsx";
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
  const totals = useLive(async (s) => totalsByDay(await s.store.listLogsBetween(first, last)), [first, last]);

  return (
    <div className="calendar" role="grid" aria-label={formatMonth(year, month)}>
      {WEEKDAYS.map((w) => (
        <div key={w} className="weekday" role="columnheader">
          {w}
        </div>
      ))}
      {weeks.flat().map((c) => {
        const total = totals?.get(c.day) ?? 0;
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
              <span style={{ width: `${pct}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
