import { useEffect, useRef, useState } from "react";
import type { HiddenActivity, LogEntry, Task } from "@pm/shared";
import { activityStats, chipText, pastActivities } from "../core/views.ts";
import { XIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";

/** Every log on this device (for suggesting activities typed before). */
export function useAllLogs(): readonly LogEntry[] {
  return useLive((s) => s.store.listLogsBetween("0000-01-01", "9999-12-31"), []) ?? [];
}

/** Activities removed from the chips (synced). */
export function useHidden(): readonly HiddenActivity[] {
  return useLive((s) => s.store.listHidden(), []) ?? [];
}

const LONG_PRESS_MS = 450;
const UNDO_MS = 5000;

/**
 * Small tappable chips under the TIMER / LOG bar: activities logged before
 * that are not tasks and match what is typed. Each chip has a ✕ (on a phone,
 * press and hold the chip to show it) that hides it from suggestions, with
 * Undo; "Manage" lists them all. Logs are never changed.
 */
export function PastActivitySuggestions({
  text,
  tasks,
  onPick,
}: {
  text: string;
  tasks: readonly Task[];
  onPick: (title: string) => void;
}) {
  const { logs } = useServices();
  const allLogs = useAllLogs();
  const hidden = useHidden();
  const [armed, setArmed] = useState<string | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const press = useRef<{ timer: number; title: string; fired: boolean } | null>(null);

  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [undo]);

  const titles = pastActivities(allLogs, tasks, text, 8, hidden).filter((t) => chipText(t) !== text.trim());

  const remove = (title: string) => {
    setArmed(null);
    setUndo(title);
    void logs.hideActivities([title]);
  };

  const startPress = (title: string, pointerType: string) => {
    if (pointerType === "mouse") return;
    const timer = window.setTimeout(() => {
      if (press.current) press.current.fired = true;
      setArmed(title);
    }, LONG_PRESS_MS);
    press.current = { timer, title, fired: false };
  };
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };

  return (
    <>
      {titles.length > 0 && (
        <div className="past-chips" aria-label="Logged before">
          {titles.map((t) => (
            <span key={t} className={`past-chip-wrap ${armed === t ? "armed" : ""}`}>
              <button
                type="button"
                className="past-chip"
                // keep focus (and the phone keyboard) on the bar
                onPointerDown={(e) => {
                  e.preventDefault();
                  startPress(t, e.pointerType);
                }}
                onPointerUp={endPress}
                onPointerLeave={endPress}
                onPointerCancel={endPress}
                onContextMenu={(e) => e.preventDefault()}
                onClick={() => {
                  // the press that showed the ✕ is not a pick
                  if (press.current?.fired) {
                    press.current = null;
                    return;
                  }
                  press.current = null;
                  setArmed(null);
                  onPick(t);
                }}
              >
                {t}
              </button>
              <button
                type="button"
                className="past-chip-x"
                aria-label={`Remove ${t} from suggestions`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => remove(t)}
              >
                <XIcon />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="link-btn past-manage"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setManage(true)}
          >
            Manage
          </button>
        </div>
      )}
      {undo && (
        <div className="undo-toast" role="status">
          <span>“{undo}” removed from suggestions</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              void logs.unhideActivities([undo]);
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
      {manage && <ManageSuggestions tasks={tasks} logs={allLogs} hidden={hidden} onClose={() => setManage(false)} />}
    </>
  );
}

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Every past activity: how often and when last used; tick to remove, or bring back hidden ones. */
export function ManageSuggestions({
  tasks,
  logs: entries,
  hidden,
  onClose,
}: {
  tasks: readonly Task[];
  logs: readonly LogEntry[];
  hidden: readonly HiddenActivity[];
  onClose: () => void;
}) {
  const { logs } = useServices();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const stats = activityStats(entries, tasks, hidden);
  const shown = stats.filter((a) => !a.hidden);
  const gone = stats.filter((a) => a.hidden);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };
  const removePicked = async () => {
    await logs.hideActivities(shown.filter((a) => picked.has(a.key)).map((a) => a.title));
    setPicked(new Set());
  };
  const allPicked = shown.length > 0 && shown.every((a) => picked.has(a.key));

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal suggest-modal" role="dialog" aria-modal="true" aria-label="Manage suggestions">
        <div className="modal-head">
          <h2>Suggestions</h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <p className="hint">
          Activities you logged before that aren't tasks. Removing one only stops suggesting it: past logs keep their names,
          and logging it again brings it back.
        </p>
        {shown.length === 0 ? (
          <p className="hint">Nothing is suggested.</p>
        ) : (
          <>
            <div className="suggest-bar">
              <label className="suggest-all">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((a) => a.key)))}
                />
                All
              </label>
              <button type="button" className="danger small" disabled={picked.size === 0} onClick={() => void removePicked()}>
                Remove {picked.size > 0 ? picked.size : ""}
              </button>
            </div>
            <ul className="suggest-list" aria-label="Suggested">
              {shown.map((a) => (
                <li key={a.key}>
                  <label>
                    <input type="checkbox" checked={picked.has(a.key)} onChange={() => toggle(a.key)} />
                    <span className="suggest-title">{a.title}</span>
                    <span className="suggest-meta">
                      {a.count}× · last {shortDate(a.lastMs)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {gone.length > 0 && (
          <>
            <h3 className="suggest-sub">Removed</h3>
            <ul className="suggest-list" aria-label="Removed">
              {gone.map((a) => (
                <li key={a.key} className="removed">
                  <span className="suggest-title">{a.title}</span>
                  <span className="suggest-meta">
                    {a.count}× · last {shortDate(a.lastMs)}
                  </span>
                  <button type="button" className="ghost small" onClick={() => void logs.unhideActivities([a.title])}>
                    Bring back
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
