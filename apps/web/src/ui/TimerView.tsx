import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LIMITS, splitByDay } from "@pm/shared";
import { CheckIcon, XIcon } from "./icons.tsx";
import { useServices } from "./services.tsx";
import { formatElapsed, readTimerStart, saveTimerStart } from "./timer-store.ts";

/** A finger lifting right after the opening touch may land on ✕: ignore it. */
const GHOST_TAP_MS = 300;

/**
 * TIMER: one round button in the middle of an empty screen.
 *
 * Hover (mouse), touch (finger) or Space/Enter replaces the button with:
 *   - ONE fixed time above (how long since the count last restarted),
 *   - a text bar, and ✓ / ✕ under it.
 * ✓ logs the time from the last restart until NOW under the typed text,
 *   split across days at each local midnight; then the count restarts.
 * ✕ logs nothing; the button comes back and the count restarts from now.
 */
export function TimerView() {
  const { logs } = useServices();
  const [shown, setShown] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const openedAt = useRef(0);
  const open = shown !== null;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const reveal = () => {
    if (open) return;
    const now = Date.now();
    let startedAt = readTimerStart();
    if (startedAt === null) {
      startedAt = now; // first ever use: nothing to measure yet
      saveTimerStart(now);
    }
    openedAt.current = now;
    setShown(formatElapsed(now - startedAt));
  };

  const close = () => {
    saveTimerStart(Date.now());
    setShown(null);
    setText("");
    setError(null);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || saving) return;
    const end = Date.now();
    const startedAt = readTimerStart() ?? end;
    setSaving(true);
    const result = await logs.addSpan(splitByDay(startedAt, end), text);
    setSaving(false);
    if (result.ok) close();
    else setError(result.error); // keep the bar and the text so nothing is lost
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    reveal();
  };

  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  // The time slot above is always reserved and mirrored by a spacer below,
  // so the button (or the bar that replaces it) stays exactly centred.
  return (
    <section className="view timer">
      <output className="timer-display" aria-label="Time since last check" hidden={!open}>
        {shown ?? ""}
      </output>
      {open ? (
        <form className="timer-query" onSubmit={submit}>
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
          <div className="timer-actions">
            <button type="submit" className="timer-ok" aria-label="Log it" disabled={!text.trim() || saving}>
              <CheckIcon />
            </button>
            <button
              type="button"
              className="timer-cancel"
              aria-label="Cancel"
              onClick={() => Date.now() - openedAt.current >= GHOST_TAP_MS && close()}
            >
              <XIcon />
            </button>
          </div>
          {error && (
            <p className="error timer-error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <button
          type="button"
          className="timer-button"
          aria-label="Timer"
          onPointerEnter={reveal}
          onPointerDown={reveal}
          onKeyDown={onButtonKey}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}
      <span className="timer-spacer" aria-hidden="true" />
    </section>
  );
}
