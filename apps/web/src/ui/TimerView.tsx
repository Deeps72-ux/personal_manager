import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { LIMITS, ONE_ACTIVITY_ERROR, hasTextAfterSeparator } from "@pm/shared";
import { piecesToLog, singleSegment, type Segment } from "../core/split.ts";
import { chipText, pad2, pickOrder } from "../core/views.ts";
import { cardLook, useActivityHue } from "./colors.ts";
import { CheckIcon, XIcon } from "./icons.tsx";
import { SplitBar } from "./SplitBar.tsx";
import { useLive, useServices } from "./services.tsx";
import { clearLegacyTimerStart, formatElapsed, readLegacyTimerStart } from "./timer-store.ts";

/** A finger lifting right after the opening touch may land on ✕ or a card: ignore it. */
const GHOST_TAP_MS = 300;

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * TIMER: one round button in the middle of an empty screen.
 *
 * ONE TIMER for all devices: its start is synced, so it can be started on
 * the phone and ✓-ed on the laptop.
 *
 * Hover (mouse), touch (finger) or Space/Enter replaces the button with:
 *   - ONE fixed time above (how long since the count last restarted),
 *   - the SPLIT BAR exactly where the button was (screen centre): the time
 *     since the last restart as one piece, typed into straight away,
 *   - ✓ / ✕ under it, and every task title under those (the priority
 *     list, then the waiting queue).
 * A log holds ONE activity: `Activity;`. Tapping a title makes the picked
 * piece exactly `title;`; the ";" is added on ✓ if left out; typing after a
 * ";" is blocked.
 * Double-tap the bar to cut the time into pieces of any size (whole minutes,
 *   at least 1 minute each), tap a piece to type its activity, or leave it
 *   unlogged (red). Dividers drag; onto a neighbour they merge.
 * ✓ logs every labeled piece until NOW (neighbours with the same activity
 *   become one log), split across days at each local midnight, and restarts
 *   the count, in ONE local transaction.
 * ✕ logs nothing; the button comes back and the count restarts from now.
 */
export function TimerView() {
  const { timer } = useServices();
  const tasks = useLive(async (s) => pickOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  const start = useLive((s) => s.store.timerStart(), []); // null until ensured
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The SPLIT BAR while open: the pieces and the one being typed into (-1: none).
  const [split, setSplit] = useState<{ segs: Segment[]; sel: number } | null>(null);
  const hueOf = useActivityHue();
  const input = useRef<HTMLInputElement>(null);
  const openedAt = useRef(0);
  const pendingCursor = useRef<number | null>(null);
  const open = openAt !== null;
  // ONE fixed time: from the start to the moment the bar opened.
  const shown = open && start != null ? formatElapsed(openAt - start) : "";
  const value = split?.segs[split.sel]?.text ?? "";
  const canLog = !!split?.segs.some((p) => p.locked === null && p.text.trim());

  // Opened: the whole time as one piece, picked. Another device restarted
  // the timer meanwhile: start again from its new start.
  useEffect(() => {
    if (openAt === null || start == null) return;
    if (split && split.segs[0]!.start === start) return;
    if (split) setError("The timer was restarted on another device: the pieces were cleared");
    setSplit({ segs: singleSegment(start, Math.max(openAt, start + 1)), sel: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAt, start]);

  // Make sure a start exists; carry over one kept by an older version.
  useEffect(() => {
    void timer.ensureStart(readLegacyTimerStart()).then(clearLegacyTimerStart, (err) => console.error(err));
  }, [timer]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open, split !== null]);

  // After a title is inserted, put the cursor right after its ";".
  useLayoutEffect(() => {
    const at = pendingCursor.current;
    if (at === null || !input.current) return;
    pendingCursor.current = null;
    input.current.focus();
    input.current.setSelectionRange(at, at);
  }, [value]);

  const reveal = () => {
    if (open) return;
    const now = Date.now();
    openedAt.current = now;
    setOpenAt(now);
    if (start != null) setSplit({ segs: singleSegment(start, Math.max(now, start + 1)), sel: 0 });
  };

  const ghostTap = () => Date.now() - openedAt.current < GHOST_TAP_MS;

  const hide = () => {
    setOpenAt(null);
    setSplit(null);
    setError(null);
  };

  const setValue = (v: string) => {
    if (split && split.segs[split.sel]?.locked === null)
      setSplit({ ...split, segs: split.segs.map((p, i) => (i === split.sel ? { ...p, text: v } : p)) });
  };

  /** ✕ / Escape: log nothing, count again from now. */
  const cancel = () => {
    hide();
    void timer.restart().catch((err) => console.error(err));
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!split || !canLog || saving) return;
    const check = piecesToLog(split.segs, (tasks ?? []).map((t) => t.title));
    if (!check.ok) {
      setSplit({ ...split, sel: check.index });
      setError(check.error);
      return;
    }
    setSaving(true);
    let result: Awaited<ReturnType<typeof timer.logAndRestart>>;
    try {
      // logs + restart, atomically
      result =
        split.segs.length === 1
          ? await timer.logAndRestart(split.segs[0]!.text)
          : await timer.logSegments(split.segs);
    } catch (err) {
      console.error(err);
      result = { ok: false, error: "Could not save, try again" };
    } finally {
      setSaving(false); // never leave ✓ stuck greyed out
    }
    if (result.ok) hide();
    else setError(result.error); // keep the bar and the text so nothing is lost
  };

  const pick = (title: string) => {
    if (ghostTap()) return;
    if (!split || split.sel === -1) {
      setError("Tap a piece of the bar first");
      return;
    }
    const next = chipText(title);
    pendingCursor.current = next.length;
    setValue(next);
    setError(null);
  };

  const type = (v: string) => {
    // One activity per log: a second one (anything after ";") is not accepted.
    if (hasTextAfterSeparator(v) && !(tasks ?? []).some((t) => chipText(t.title) === v.trim())) {
      setError(ONE_ACTIVITY_ERROR);
      return;
    }
    setValue(v);
    setError(null);
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    reveal();
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  // Three rows: time | button-or-bar | everything below. The outer rows are
  // equal, so the middle one (button, then bar) sits exactly at the centre.
  return (
    <section className="view timer">
      <div className="timer-top">
        <output className="timer-display" aria-label="Time since last check" hidden={!open}>
          {shown}
        </output>
      </div>
      {open ? (
        <form className="timer-form" onSubmit={submit}>
          <div className="timer-bar">
            {split && (
              <SplitBar
                label="The time since the last check"
                segs={split.segs}
                selected={split.sel}
                onSelect={(sel) => {
                  setSplit((cur) => (cur ? { ...cur, sel } : cur));
                  setError(null);
                }}
                onChange={(segs, sel) => {
                  setSplit({ segs, sel: sel ?? Math.min(split.sel, segs.length - 1) });
                  setError(null);
                }}
                hueOf={(p) => hueOf(p.text)}
                input={{
                  ref: input,
                  label: (p) =>
                    split.segs.length === 1 ? "What did you do?" : `What did you do from ${hhmm(p.start)} to ${hhmm(p.end)}?`,
                  placeholder: split.segs.length === 1 ? "One activity, e.g. Reading;" : "One activity, or leave empty",
                  maxLength: LIMITS.titleMax + 1,
                  onText: type,
                  onKeyDown: onInputKey,
                }}
              />
            )}
          </div>
          <div className="timer-bottom">
            <div className="timer-actions">
              <button type="submit" className="timer-ok" aria-label="Log it" disabled={!canLog || saving}>
                <CheckIcon />
              </button>
              <button type="button" className="timer-cancel" aria-label="Cancel" onClick={() => !ghostTap() && cancel()}>
                <XIcon />
              </button>
            </div>
            {error && (
              <p className="error timer-error" role="alert">
                {error}
              </p>
            )}
            {tasks && tasks.length > 0 && (
              <ul className="timer-tasks" aria-label="Tasks">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="timer-task"
                      style={{ "--hue": cardLook(t.id).hue } as CSSProperties}
                      // keep focus (and the phone keyboard) on the bar
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => pick(t.title)}
                    >
                      {t.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </form>
      ) : (
        <>
          <button
            type="button"
            className="timer-button"
            aria-label="Timer"
            onPointerEnter={reveal}
            onPointerDown={reveal}
            onKeyDown={onButtonKey}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div className="timer-bottom" aria-hidden="true" />
        </>
      )}
    </section>
  );
}
