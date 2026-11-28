import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { activityKey, dayBounds, type Day, type Folder, type PlanList, type Placement, type PrioritySlot, type PrioritySnapshot, type Task } from "@pm/shared";
import { periodList, periodsForDay, priorityPeriods, type DayPeriod, type PeriodKind, type PriorityPeriod } from "../core/periods.ts";
import { pad2, rankedList } from "../core/views.ts";
import { useActivityHue } from "./colors.ts";
import { XIcon } from "./icons.tsx";
import { ScheduleView, type ScheduleStart } from "./ScheduleView.tsx";
import { useLive, useServices } from "./services.tsx";

const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** 24:00 for the end of the day, like logs. */
const endClock = (t: number, dayEnd: number) => (t >= dayEnd ? "24:00" : clock(t));

const KIND_LABEL: Record<PeriodKind, string> = {
  confirm: "✓ Confirmed",
  slot: "Scheduled list",
  back: "Back after a scheduled list",
  scheduled: "Scheduled",
};

const longWhen = (t: number) =>
  `${new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${clock(t)}`;

/** "#1 A, B" (all tied first tasks) + how many more. */
function topLine(p: PriorityPeriod): string {
  const best = Math.min(...p.ranks);
  const top = p.titles.filter((_, i) => p.ranks[i] === best);
  const more = p.titles.length - top.length;
  return `#${best} ${top.join(", ")}${more > 0 ? ` · +${more} more` : ""}`;
}

/**
 * A day's PRIORITY LISTS, shown like its logs: a 24-hour bar with a block
 * per list in force, and a row per list. Today also shows the slots still to
 * come, a future day its scheduled slots. Tap one to see the whole ranked
 * list, restore it as the current list, or schedule it again.
 */
export function DayPriority({ day }: { day: Day }) {
  const data = useLive(
    async (s): Promise<Data> => ({
      history: await s.store.listHistory(),
      slots: await s.store.listSlots(),
      tasks: await s.store.listTasks(),
      placements: await s.store.listPlacements(),
      folders: await s.store.listFolders(),
    }),
    [],
  );
  const hue = useActivityHue();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<PriorityPeriod | null>(null);
  const [schedule, setSchedule] = useState<ScheduleStart | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const periods = useMemo(() => (data ? priorityPeriods(data.history, data.slots, now) : []), [data, now]);
  if (!data) return null;
  const pieces = periodsForDay(periods, day, now);
  const { start: dayStart, end: dayEnd } = dayBounds(day);
  const len = dayEnd - dayStart;
  const pct = (t: number) => `${((Math.min(Math.max(t, dayStart), dayEnd) - dayStart) / len) * 100}%`;
  const nowOnDay = now >= dayStart && now < dayEnd;

  const pick = (p: PriorityPeriod) => {
    if (p.kind === "scheduled" && p.slotId) setSchedule({ kind: "edit", slotId: p.slotId });
    else setOpen(p);
  };

  const range = (x: DayPeriod) => {
    if (x.period.toMs === null) return `since ${x.cutStart ? longWhen(x.period.fromMs) : clock(x.start)} – now`;
    return `${clock(x.start)}–${endClock(x.end, dayEnd)}`;
  };

  return (
    <div className="day-priority">
      <div className="prio-bar" role="group" aria-label="Priority lists over this day's 24 hours">
        {pieces.map((x) => (
          <button
            key={x.period.key}
            type="button"
            className={`prio-block ${x.period.kind}`}
            style={
              {
                left: pct(x.start),
                width: `max(4px, calc(${pct(x.end)} - ${pct(x.start)}))`,
                "--hue": hue(x.period.titles[0] ?? ""),
              } as CSSProperties
            }
            aria-label={`${KIND_LABEL[x.period.kind]} ${range(x)}`}
            onClick={() => pick(x.period)}
          />
        ))}
        {nowOnDay && <span className="prio-now" style={{ left: pct(now) }} aria-hidden="true" />}
      </div>
      <div className="prio-ticks" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>

      {pieces.length === 0 ? (
        <p className="empty">{dayStart > now ? "Nothing scheduled for this day." : "No priority list was in force on this day."}</p>
      ) : (
        <ul className="prio-rows" aria-label="Priority lists">
          {pieces.map((x) => (
            <li key={x.period.key}>
              <button type="button" className={`prio-row ${x.period.kind}`} onClick={() => pick(x.period)}>
                <span className="prio-time">{range(x)}</span>
                <span className="prio-main">
                  <span className="prio-kind">
                    <span className="swatch" style={{ "--hue": hue(x.period.titles[0] ?? "") } as CSSProperties} aria-hidden="true" />
                    {KIND_LABEL[x.period.kind]}
                    {x.cutEnd && x.period.toMs !== null && <span className="muted"> · goes on the next day</span>}
                  </span>
                  <span className="prio-top muted">{topLine(x.period)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <PeriodDetail
          period={open}
          data={data}
          onClose={() => setOpen(null)}
          onSchedule={(list) => {
            setOpen(null);
            setSchedule({ kind: "new", list });
          }}
        />
      )}
      {schedule && <ScheduleView start={schedule} onClose={() => setSchedule(null)} />}
    </div>
  );
}

interface Data {
  history: PrioritySnapshot[];
  slots: PrioritySlot[];
  tasks: Task[];
  placements: Placement[];
  folders: Folder[];
}

/** One past list: its time, its kind, every task with its rank; restore it or schedule it again. */
function PeriodDetail({
  period: p,
  data,
  onClose,
  onSchedule,
}: {
  period: PriorityPeriod;
  data: Data;
  onClose: () => void;
  onSchedule: (list: PlanList) => void;
}) {
  const { priority } = useServices();
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const homeOf = new Map(rankedList(data.tasks, data.placements, data.folders).map((c) => [c.task.id, c.homeFolderId]));
  const list = periodList(p, data.slots, data.tasks, homeOf);
  const alive = new Set(data.tasks.map((t) => activityKey(t.title)));
  const when =
    p.toMs === null ? `${longWhen(p.fromMs)} – now` : `${longWhen(p.fromMs)} – ${new Date(p.toMs).toDateString() === new Date(p.fromMs).toDateString() ? clock(p.toMs) : longWhen(p.toMs)}`;

  const restore = async () => {
    setBusy(true);
    try {
      await priority.restoreList(list);
      setDone(true);
      setAsking(false);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal period-modal" role="dialog" aria-modal="true" aria-label="Priority list">
        <div className="modal-head">
          <h2>{KIND_LABEL[p.kind]}</h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <p className="period-when">{when}</p>
        <ol className="period-list" aria-label="Ranked list">
          {p.titles.map((t, i) => (
            <li key={`${t}:${i}`} className={alive.has(activityKey(t)) ? "" : "gone"}>
              <span className="period-rank">#{p.ranks[i]}</span>
              <span className="period-title">{t}</span>
              {!alive.has(activityKey(t)) && <span className="muted period-gone">deleted</span>}
            </li>
          ))}
        </ol>
        {done ? (
          <p className="notice" role="status">
            Restored as your current list. Press ✓ in Priority when you want scores to use it.
          </p>
        ) : asking ? (
          <div className="period-ask">
            <p>
              Replace the list shown in Priority with this one? Tasks deleted since drop out, newer tasks go on top, and
              tasks not in it go to the waiting queue. Scores keep the last confirmed list until you press ✓.
            </p>
            <div className="row">
              <button type="button" className="primary" disabled={busy || list.entries.length === 0} onClick={() => void restore()}>
                Restore
              </button>
              <button type="button" className="ghost" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row period-actions">
            <button type="button" className="primary" disabled={list.entries.length === 0} onClick={() => setAsking(true)}>
              Restore as current
            </button>
            <button type="button" className="ghost" disabled={list.entries.length === 0} onClick={() => onSchedule(list)}>
              Schedule this list again
            </button>
          </div>
        )}
        {list.entries.length === 0 && <p className="hint">None of these tasks exist any more.</p>}
      </div>
    </div>
  );
}
