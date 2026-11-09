import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { LIMITS } from "@pm/shared";
import { insertTitle, priorityOrder } from "../core/views.ts";
import { CheckIcon, XIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";
import { cardLook } from "./TaskCard.tsx";
import { clearLegacyTimerStart, formatElapsed, readLegacyTimerStart } from "./timer-store.ts";

/** A finger lifting right after the opening touch may land on ✕ or a card: ignore it. */
const GHOST_TAP_MS = 300;

/**
 * TIMER: one round button in the middle of an empty screen.
 *
 * Hover (mouse), touch (finger) or Space/Enter replaces the button with:
 *   - ONE fixed time above (how long since the count last restarted),
 *   - a text bar exactly where the button was (screen centre),
 *   - ✓ / ✕ under it, and every task title (priority order) under those.
 * Tapping a title types `title;` at the cursor (once; remove it by hand).
 * ✓ logs the time from the last restart until NOW under the typed text,
 *   split across days at each local midnight, and restarts the count, in
 *   ONE local transaction (start time lives in the local DB, not localStorage).
 * ✕ logs nothing; the button comes back and the count restarts from now.
 */
export function TimerView() {
  const { timer } = useServices();
  const tasks = useLive(async (s) => priorityOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  const start = useLive((s) => s.store.timerStart(), []); // null until ensured
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const openedAt = useRef(0);
  const pendingCursor = useRef<number | null>(null);
  const open = openAt !== null;
  // ONE fixed time: from the start to the moment the bar opened.
  const shown = open && start != null ? formatElapsed(openAt - start) : "";

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
  }, [text]);

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
    setError(null);
  };

  /** ✕ / Escape: log nothing, count again from now. */
  const cancel = () => {
    hide();
    void timer.restart().catch((err) => console.error(err));
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    let result: Awaited<ReturnType<typeof timer.logAndRestart>>;
    try {
      result = await timer.logAndRestart(text); // logs + restart, atomically
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
    const cursor = input.current?.selectionStart ?? text.length;
    const r = insertTitle(text, cursor, title, LIMITS.titleMax);
    if (!r.ok) {
      if (r.reason === "too-long") setError(`Too long: the bar holds at most ${LIMITS.titleMax} characters`);
      return; // "present": already typed, nothing to do
    }
    pendingCursor.current = r.cursor;
    setText(r.text);
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
            aria-label="What did you do?"
            placeholder="What did you do?"
            maxLength={LIMITS.titleMax}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={onInputKey}
          />
          <div className="timer-bottom">
            <div className="timer-actions">
              <button type="submit" className="timer-ok" aria-label="Log it" disabled={!text.trim() || saving}>
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
