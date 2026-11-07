import { useEffect, useState } from "react";
import { formatElapsed, readTimerStart, saveTimerStart } from "./timer-store.ts";

/**
 * TIMER: shows only a round button. Tapping it reveals the time since you last
 * left this screen. Leaving (another tab, or the app goes to the background)
 * hides the time and restarts the count from that moment.
 */
export function TimerView() {
  const [startedAt, setStartedAt] = useState<number>(() => {
    const saved = readTimerStart();
    if (saved !== null) return saved;
    const now = Date.now(); // first ever visit: start counting now
    saveTimerStart(now);
    return now;
  });
  const [shown, setShown] = useState(false);
  const [now, setNow] = useState(Date.now);

  // Redraw once a second, only while the time is on screen.
  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [shown]);

  // Leaving = switching tab (unmount) or the app/page going to the background.
  useEffect(() => {
    const leave = () => {
      const t = Date.now();
      saveTimerStart(t);
      setStartedAt(t);
      setShown(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      saveTimerStart(Date.now());
    };
  }, []);

  // No visible text: the time sits above the button (above the thumb) and
  // its slot is always reserved, so the button never jumps when it appears.
  return (
    <section className="view timer">
      <output className="timer-display" aria-label="Time since you last left" hidden={!shown}>
        {shown ? formatElapsed(now - startedAt) : ""}
      </output>
      <button
        type="button"
        className="timer-button"
        aria-label="Timer"
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      />
    </section>
  );
}
