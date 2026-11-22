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
import { carveByClock, piecesToLog, singleSegment, splitMiddle, type Segment } from "../core/split.ts";
import { chipText, pickOrder } from "../core/views.ts";
import { CheckIcon, ScissorsIcon, XIcon } from "./icons.tsx";
import { PieceRange, SplitBar } from "./SplitBar.tsx";
import { useLive, useServices } from "./services.tsx";
import { cardLook } from "./TaskCard.tsx";
import { clearLegacyTimerStart, formatElapsed, readLegacyTimerStart } from "./timer-store.ts";

/** A finger lifting right after the opening touch may land on ✕ or a card: ignore it. */
const GHOST_TAP_MS = 300;

/**
 * TIMER: one round button in the middle of an empty screen.
 *
 * ONE TIMER for all devices: its start is synced, so it can be started on
 * the phone and ✓-ed on the laptop.
 *
 * Hover (mouse), touch (finger) or Space/Enter replaces the button with:
 *   - ONE fixed time above (how long since the count last restarted),
 *   - a text bar exactly where the button was (screen centre),
 *   - ✓ / ✂ / ✕ under it, and every task title under those (the priority
 *     list, then the waiting queue).
 * A log holds ONE activity: `Activity;`. Tapping a title makes the bar exactly
 * `title;`; the ";" is added on ✓ if left out; typing after a ";" is blocked.
 * ✓ logs the time from the last restart until NOW under that activity,
 *   split across days at each local midnight, and restarts the count, in
 *   ONE local transaction.
 * ✂ shows the SPLIT BAR: cut the time into pieces of any size (whole
 *   minutes, at least 1 minute each), pick a piece and type or tap its
 *   activity, or leave it unlogged. ✓ then logs every labeled piece
 *   (neighbours with the same activity become one log).
 * ✕ logs nothing; the button comes back and the count restarts from now.
 */
export function TimerView() {
  const { timer } = useServices();
  const tasks = useLive(async (s) => pickOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  const start = useLive((s) => s.store.timerStart(), []); // null until ensured
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The SPLIT BAR, once ✂ was pressed: the pieces and the one being typed into.
  const [split, setSplit] = useState<{ segs: Segment[]; sel: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const openedAt = useRef(0);
  const pendingCursor = useRef<number | null>(null);
  const open = openAt !== null;
  // ONE fixed time: from the start to the moment the bar opened.
  const shown = open && start != null ? formatElapsed(openAt - start) : "";
  // What the text bar edits: the whole span, or the picked piece.
  const value = split ? (split.segs[split.sel]?.text ?? "") : text;
  const canLog = split ? split.segs.some((p) => p.text.trim()) : !!text.trim();

  // Another device restarted the timer: the pieces no longer match it.
  useEffect(() => {
    if (split && start != null && split.segs[0]!.start !== start) {
      setSplit(null);
      setError("The timer was restarted on another device: the split was cleared");
    }
  }, [split, start]);

  // Make sure a start exists; carry over one kept by an older version.
  useEffect(() => {
    void timer.ensureStart(readLegacyTimerStart()).then(clearLegacyTimerStart, (err) => console.error(err));
  }, [timer]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

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
  };

  const ghostTap = () => Date.now() - openedAt.current < GHOST_TAP_MS;

  const hide = () => {
    setOpenAt(null);
    setText("");
    setSplit(null);
    setError(null);
  };

  const setValue = (v: string) => {
    if (!split) setText(v);
    else setSplit({ ...split, segs: split.segs.map((p, i) => (i === split.sel ? { ...p, text: v } : p)) });
  };

  /** ✂: first press shows the bar cut in two; later presses cut the picked piece in two. */
  const cut = () => {
    if (ghostTap() || start == null || openAt === null) return;
    const base = split ?? { segs: singleSegment(start, Math.max(openAt, start + 1), text), sel: 0 };
    const next = splitMiddle(base.segs, base.sel);
    if (next) setSplit({ segs: next, sel: base.sel + 1 });
    else if (!split) setError("Less than 2 minutes: nothing to split");
    else setError("This piece is too short to split (1 minute at least each)");
    input.current?.focus();
  };

  /** ✕ / Escape: log nothing, count again from now. */
  const cancel = () => {
    hide();
    void timer.restart().catch((err) => console.error(err));
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canLog || saving) return;
    if (split) {
      const check = piecesToLog(split.segs, (tasks ?? []).map((t) => t.title));
      if (!check.ok) {
        setSplit({ ...split, sel: check.index });
        setError(check.error);
        return;
      }
    }
    setSaving(true);
    let result: Awaited<ReturnType<typeof timer.logAndRestart>>;
    try {
      // logs + restart, atomically
      result = split ? await timer.logSegments(split.segs) : await timer.logAndRestart(text);
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

  const onInputKey = (e: KeyboardEvent) => {
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
          <input
            ref={input}
            className="timer-input"
            aria-label={split ? "What did you do in this piece?" : "What did you do?"}
            placeholder={split ? "This piece: one activity, or leave empty" : "One activity, e.g. Reading;"}
            maxLength={LIMITS.titleMax + 1}
            value={value}
            onChange={(e) => type(e.target.value)}
            onKeyDown={onInputKey}
          />
          <div className="timer-bottom">
            {split && (
              <>
                <SplitBar
                  label="Split the time"
                  segs={split.segs}
                  selected={split.sel}
                  onSelect={(sel) => {
                    setSplit({ ...split, sel });
                    setError(null);
                    input.current?.focus();
                  }}
                  onChange={(segs, sel) => setSplit({ segs, sel: sel ?? Math.min(split.sel, segs.length - 1) })}
                />
                {split.segs[split.sel] && (
                  <PieceRange
                    seg={split.segs[split.sel]!}
                    canSplit={splitMiddle(split.segs, split.sel) !== null}
                    onSplit={cut}
                    onRange={(from, to) => {
                      const r = carveByClock(split.segs, split.sel, from, to);
                      if (r) setSplit({ segs: r.segs, sel: r.index });
                    }}
                  />
                )}
              </>
            )}
            <div className="timer-actions">
              <button type="submit" className="timer-ok" aria-label="Log it" disabled={!canLog || saving}>
                <CheckIcon />
              </button>
              <button
                type="button"
                className="timer-split"
                aria-label={split ? "Split this piece" : "Split the time"}
                onPointerDown={(e) => e.preventDefault()}
                onClick={cut}
              >
                <ScissorsIcon />
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
