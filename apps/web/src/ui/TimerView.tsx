import { useRef, useState, type KeyboardEvent } from "react";
import { formatElapsed, readTimerStart, saveTimerStart } from "./timer-store.ts";

/**
 * TIMER: one round button in the middle of an empty screen.
 *
 * Hover (mouse) or touch-and-hold (finger) shows ONE fixed time above the
 * button: how long since the last hover/touch ended. It does not tick.
 * When the pointer leaves or the finger lifts, the time hides and the count
 * restarts from 0 at that moment.
 */
export function TimerView() {
  const [shown, setShown] = useState<string | null>(null);
  const revealed = useRef(false);

  const reveal = () => {
    const now = Date.now();
    let startedAt = readTimerStart();
    if (startedAt === null) {
      startedAt = now; // first ever use: nothing to measure yet
      saveTimerStart(now);
    }
    revealed.current = true;
    setShown(formatElapsed(now - startedAt));
  };

  const release = () => {
    if (!revealed.current) return; // only a real reveal resets the count
    revealed.current = false;
    saveTimerStart(Date.now());
    setShown(null);
  };

  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (down && !e.repeat) reveal();
    if (!down) release();
  };

  // No visible text: the time slot above the button is always reserved, so
  // the button stays exactly centred whether the time is showing or not.
  return (
    <section className="view timer">
      <output className="timer-display" aria-label="Time since last check" hidden={shown === null}>
        {shown ?? ""}
      </output>
      <button
        type="button"
        className="timer-button"
        aria-label="Timer"
        aria-pressed={shown !== null}
        onPointerEnter={reveal}
        onPointerLeave={release}
        onPointerCancel={release}
        onKeyDown={(e) => onKey(e, true)}
        onKeyUp={(e) => onKey(e, false)}
        onBlur={release}
        onContextMenu={(e) => e.preventDefault()}
      />
      <span className="timer-spacer" aria-hidden="true" />
    </section>
  );
}
