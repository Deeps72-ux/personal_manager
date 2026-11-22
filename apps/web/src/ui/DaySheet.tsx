import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { formatPercent, formatSeconds, hasTextAfterSeparator, LIMITS, ONE_ACTIVITY_ERROR, sumSeconds, type Day } from "@pm/shared";
import { logSlices } from "../core/insights.ts";
import { daySegments, openIndexAt, piecesToLog, TIMER_LABEL, type Segment } from "../core/split.ts";
import { dayLayout, knownSpan } from "../core/timeline.ts";
import { chipText, formatDayLong, pad2, pickOrder } from "../core/views.ts";
import { cardLook, useActivityHue } from "./colors.ts";
import { ChevronLeft, XIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";
import { SplitBar } from "./SplitBar.tsx";

const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * One day of the LOG.
 *
 * Its 24 hours are a SPLIT BAR: time already logged and the running TIMER
 * are locked (faded, in their activity's colour); free time is open and
 * unlogged (red). Double-tap to cut, drag the dividers, tap a piece and type
 * (or tap a task) its activity right in the bar, and save: each labeled
 * piece becomes a manual log exactly there.
 *
 * Under it, every log is shown slice by slice, with its colour: a slice per
 * confirmed priority order in force while it ran, with that order's #1 task
 * and the slice's own deviation.
 */
export function DaySheet({ day, onBack }: { day: Day; onBack: () => void }) {
  const { logs } = useServices();
  const entries = useLive((s) => s.store.listLogsForDay(day), [day]);
  const timerStart = useLive((s) => s.store.timerStart(), []);
  const history = useLive((s) => s.store.listHistory(), []);
  const tasks = useLive(async (s) => pickOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  const purgedBefore = useLive((s) => s.store.purgedBefore(), []);
  const hue = useActivityHue();
  const input = useRef<HTMLInputElement>(null);

  const layout = useMemo(() => dayLayout(day, entries ?? [], timerStart ?? null), [day, entries, timerStart]);
  // The bar starts again whenever what is taken changes (a save, a sync).
  const takenKey = JSON.stringify([...layout.busy.map((b) => [b.start, b.end])]);
  const [bar, setBar] = useState<{ key: string; segs: Segment[]; sel: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (entries === undefined || timerStart === undefined) return;
    if (bar?.key === takenKey) return;
    const segs = daySegments(day, layout);
    setBar({ key: takenKey, segs, sel: openIndexAt(segs, Date.now()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takenKey, entries, timerStart, day]);

  const total = sumSeconds(entries ?? []);
  const daySeconds = Math.round((layout.bounds.end - layout.bounds.start) / 1000);
  const busy = layout.busy.reduce((a, i) => a + (i.end - i.start) / 1000, 0);
  const free = Math.max(0, daySeconds - Math.round(busy));
  const locked = purgedBefore != null && day < purgedBefore;
  const sorted = [...(entries ?? [])]
    .map((e) => ({ e, span: knownSpan(e) }))
    .sort((a, b) => (a.span?.start ?? Infinity) - (b.span?.start ?? Infinity) || (a.e.id < b.e.id ? -1 : 1));

  const segs = bar?.segs ?? [];
  const sel = bar?.sel ?? -1;
  const picked = segs[sel]?.locked === null ? segs[sel] : undefined;
  const update = (next: Segment[], nextSel = sel) => bar && setBar({ ...bar, segs: next, sel: nextSel });
  const labeled = segs.filter((p) => p.locked === null && p.text.trim()).length;

  const setText = (v: string) => {
    if (!picked) return;
    if (hasTextAfterSeparator(v) && !(tasks ?? []).some((t) => chipText(t.title) === v.trim())) {
      setError(ONE_ACTIVITY_ERROR);
      return;
    }
    update(segs.map((p, i) => (i === sel ? { ...p, text: v } : p)));
    setError(null);
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!bar || saving || labeled === 0) return;
    const check = piecesToLog(segs, (tasks ?? []).map((t) => t.title));
    if (!check.ok) {
      update(segs, check.index);
      setError(check.error);
      return;
    }
    setSaving(true);
    try {
      const r = await logs.addPieces(day, segs);
      if (r.ok) setError(null);
      else setError(r.error);
    } catch (err) {
      console.error(err);
      setError("Could not save, try again");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="view daysheet">
      <div className="day-head">
        <button className="icon" onClick={onBack} aria-label="Back to calendar">
          <ChevronLeft />
        </button>
        <h2>{formatDayLong(day)}</h2>
      </div>

      <div className="daymeter" aria-label={`${total} seconds logged, ${free} seconds free`}>
        <div className="daymeter-text">
          <strong>{formatSeconds(total)}</strong> logged
          <span className="muted"> · {formatSeconds(free)} free</span>
        </div>
        {layout.timer && (
          <p className="hint daymeter-timer">
            The timer is running since {clock(layout.timer.start)}
            {layout.timer.start === layout.bounds.start ? " (an earlier day)" : ""}: that time is the timer's.
          </p>
        )}
      </div>

      {locked ? (
        <p className="notice">Logs before {purgedBefore} were deleted; this day is closed.</p>
      ) : (
        bar && (
          <form className="day-split" onSubmit={(e) => void save(e)}>
            <SplitBar
              label="This day's 24 hours"
              segs={segs}
              selected={sel}
              onSelect={(i) => {
                setBar((cur) => (cur ? { ...cur, sel: i } : cur));
                setError(null);
              }}
              onChange={(next, i) => {
                update(next, i ?? Math.min(sel, next.length - 1));
                setError(null);
              }}
              hueOf={(p) => (p.locked === TIMER_LABEL ? null : hue(p.locked?.split(" / ")[0] ?? p.text))}
              input={{
                ref: input,
                label: (p) => `Activity from ${clock(p.start)} to ${clock(p.end)}`,
                placeholder: "One activity, or leave empty (unlogged)",
                maxLength: LIMITS.titleMax + 1,
                onText: setText,
              }}
            />
            {!segs.some((p) => p.locked === null) && (
              <p className="dropzone-hint">No free time on this day: remove a log to make room</p>
            )}
            {tasks && tasks.length > 0 && (
              <div className="palette" aria-label="Your tasks">
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="chip-btn"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => (picked ? setText(chipText(t.title)) : setError("Tap a piece of the bar first"))}
                  >
                    <span className="chip" style={{ "--hue": cardLook(t.id).hue } as CSSProperties}>
                      {t.title}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row">
              <button type="submit" className="primary" disabled={labeled === 0 || saving}>
                {labeled > 1 ? `Log ${labeled} pieces` : "Log it"}
              </button>
            </div>
          </form>
        )
      )}

      <h3 className="section-title">
        Entries <span className="count">{entries?.length ?? 0}</span>
      </h3>
      {entries && entries.length === 0 && <p className="empty">Nothing logged for this day yet.</p>}
      <ul className="entries">
        {sorted.flatMap(({ e, span }) => {
          const slices = logSlices(e, history ?? []);
          const del = (
            <button
              className="icon"
              aria-label={`Delete ${e.taskTitle} entry${slices.length > 1 ? ` (all ${slices.length} slices)` : ""}`}
              onClick={() => void logs.remove(e.id)}
            >
              <XIcon />
            </button>
          );
          const source = e.source && <span className="entry-source muted"> · {e.source}</span>;
          const swatch = <span className="swatch" style={{ "--hue": hue(e.taskTitle) } as CSSProperties} aria-hidden="true" />;
          if (slices.length === 0) {
            const stored = e.deviation ?? null;
            return [
              <li key={e.id} className="entry">
                <span className="entry-secs">{span ? `${clock(span.start)}–${clock(span.end)}` : "no time"}</span>
                <span className="entry-title">
                  {swatch}
                  {e.taskTitle}
                  {source}
                  {stored !== null && <span className="entry-meta muted">deviation {formatPercent(stored)}</span>}
                </span>
                <span className="entry-fmt muted">{formatSeconds(e.seconds)}</span>
                {del}
              </li>,
            ];
          }
          return slices.map((sl, k) => (
            <li key={`${e.id}:${k}`} className="entry">
              <span className="entry-secs">
                {clock(sl.start)}–{clock(sl.end)}
              </span>
              <span className="entry-title">
                {swatch}
                {e.taskTitle}
                {source}
                <span className="entry-meta muted">
                  priority: {sl.top ?? "none confirmed"}
                  {sl.deviation !== null && <> · deviation {formatPercent(sl.deviation)}</>}
                </span>
              </span>
              <span className="entry-fmt muted">{formatSeconds(Math.round((sl.end - sl.start) / 1000))}</span>
              {del}
            </li>
          ));
        })}
      </ul>
    </section>
  );
}
