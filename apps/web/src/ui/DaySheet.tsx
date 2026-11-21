import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { formatSeconds, parseSecondsInput, sumSeconds, type Day, type Task } from "@pm/shared";
import { dayLayout, knownSpan, longestGap } from "../core/timeline.ts";
import { formatDayLong, pad2, scoringOrder } from "../core/views.ts";
import { ChevronLeft, XIcon } from "./icons.tsx";
import type { ProposeResult } from "../core/actions.ts";
import { useLive, useServices } from "./services.tsx";
import { cardLook } from "./TaskCard.tsx";

const DROP_ID = "log-drop-zone";

const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * One day of the LOG. Drag a task card onto the drop zone (or tap it), type
 * how long; the app places it at the earliest free gap that holds it whole
 * and asks you to accept. Time covered by another log or by the running
 * TIMER is never free.
 */
export function DaySheet({ day, onBack }: { day: Day; onBack: () => void }) {
  const { logs } = useServices();
  const entries = useLive((s) => s.store.listLogsForDay(day), [day]);
  const timerStart = useLive((s) => s.store.timerStart(), []);
  const tasks = useLive(async (s) => scoringOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  const purgedBefore = useLive((s) => s.store.purgedBefore(), []);
  const [picked, setPicked] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  );

  const total = sumSeconds(entries ?? []);
  const layout = dayLayout(day, entries ?? [], timerStart ?? null);
  const daySeconds = Math.round((layout.bounds.end - layout.bounds.start) / 1000);
  const busy = layout.busy.reduce((a, i) => a + (i.end - i.start) / 1000, 0);
  const free = Math.max(0, daySeconds - Math.round(busy));
  const longest = longestGap(layout.free);
  const locked = purgedBefore != null && day < purgedBefore;
  const sorted = [...(entries ?? [])]
    .map((e) => ({ e, span: knownSpan(e) }))
    .sort((a, b) => (a.span?.start ?? Infinity) - (b.span?.start ?? Infinity) || (a.e.id < b.e.id ? -1 : 1));

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    if (e.over?.id === DROP_ID) setPicked(String(e.active.data.current?.title ?? ""));
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
        <div className="daymeter-bar">
          <span style={{ width: `${Math.min(100, (busy / daySeconds) * 100)}%` }} />
        </div>
        <div className="daymeter-text">
          <strong>{formatSeconds(total)}</strong> logged
          <span className="muted">
            {" "}
            · {formatSeconds(free)} free{free > 0 && longest < free ? ` (longest slot ${formatSeconds(longest)})` : ""}
          </span>
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
        <DndContext
          sensors={sensors}
          // A drop counts when the pointer/finger is over the zone: precise and
          // forgiving for small chips on a phone.
          collisionDetection={pointerWithin}
          onDragStart={(e) => setDragging((e.active.data.current?.task as Task) ?? null)}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className="palette" aria-label="Your tasks">
            {tasks?.length === 0 && <p className="muted">No task cards yet. Add some in TASKS.</p>}
            {tasks?.map((t) => (
              <Chip key={t.id} task={t} onPick={() => setPicked(t.title)} />
            ))}
          </div>

          <DropZone active={dragging !== null}>
            {picked ? (
              <SecondsForm
                key={picked}
                title={picked}
                longest={longest}
                onCancel={() => setPicked(null)}
                onPropose={(secs) => logs.propose(day, secs, picked)}
                onAccept={async (secs, startMs) => {
                  const r = await logs.add(day, secs, picked, startMs);
                  if (r.ok) setPicked(null);
                  return r.ok ? null : r.error;
                }}
              />
            ) : (
              <p className="dropzone-hint">
                {longest > 0
                  ? "Drag a task card here (or tap one) to log time"
                  : "No free time on this day: remove a log to make room"}
              </p>
            )}
          </DropZone>

          <DragOverlay>{dragging ? <ChipFace task={dragging} lifted /> : null}</DragOverlay>
        </DndContext>
      )}

      <h3 className="section-title">
        Entries <span className="count">{entries?.length ?? 0}</span>
      </h3>
      {entries && entries.length === 0 && <p className="empty">Nothing logged for this day yet.</p>}
      <ul className="entries">
        {sorted.map(({ e, span }) => (
          <li key={e.id} className="entry">
            <span className="entry-secs">{span ? `${clock(span.start)}–${clock(span.end)}` : "no time"}</span>
            <span className="entry-title">
              {e.taskTitle}
              {e.source && <span className="entry-source muted"> · {e.source}</span>}
            </span>
            <span className="entry-fmt muted">{formatSeconds(e.seconds)}</span>
            <button className="icon" aria-label={`Delete ${e.taskTitle} entry`} onClick={() => void logs.remove(e.id)}>
              <XIcon />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Chip({ task, onPick }: { task: Task; onPick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `chip-${task.id}`,
    data: { title: task.title, task },
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`chip-btn ${isDragging ? "ghosted" : ""}`}
      onClick={onPick}
      {...attributes}
      {...listeners}
    >
      <ChipFace task={task} />
    </button>
  );
}

function ChipFace({ task, lifted = false }: { task: Task; lifted?: boolean }) {
  return (
    <span className={`chip ${lifted ? "lifted" : ""}`} style={{ "--hue": cardLook(task.id).hue } as React.CSSProperties}>
      {task.title}
    </span>
  );
}

function DropZone({ active, children }: { active: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: DROP_ID });
  return (
    <div ref={setNodeRef} className={`dropzone ${active ? "armed" : ""} ${isOver ? "over" : ""}`}>
      {children}
    </div>
  );
}

function SecondsForm({
  title,
  longest,
  onPropose,
  onAccept,
  onCancel,
}: {
  title: string;
  longest: number;
  onPropose: (secs: string) => Promise<ProposeResult>;
  onAccept: (secs: number, startMs: number) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ seconds: number; startMs: number; endMs: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const preview = value.trim() ? parseSecondsInput(value) : null;
  const over = preview?.ok && preview.seconds > longest;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await onPropose(value);
    if (r.ok) setProposal(r);
    else setError(r.error);
  };

  if (proposal) {
    return (
      <div className="secondsform proposal" role="group" aria-label="Confirm the time">
        <div className="secondsform-title">
          Place <strong>{title}</strong> at{" "}
          <strong>
            {clock(proposal.startMs)} – {clock(proposal.endMs)}
          </strong>
          ? <span className="muted">({formatSeconds(proposal.seconds)}, the earliest free slot)</span>
        </div>
        <div className="row">
          <button
            className="primary"
            autoFocus
            onClick={async () => {
              const err = await onAccept(proposal.seconds, proposal.startMs);
              if (err) {
                setProposal(null);
                setError(err);
              }
            }}
          >
            Accept
          </button>
          <button type="button" className="ghost" onClick={() => setProposal(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="secondsform" onSubmit={submit}>
      <div className="secondsform-title">
        How long on <strong>{title}</strong>?
      </div>
      <div className="row">
        <input
          ref={input}
          className="grow"
          inputMode="text"
          placeholder="e.g. 27, 8*60*60 or 1h30m"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          aria-label={`Seconds for ${title}`}
        />
        <button className="primary" disabled={!preview?.ok || over}>
          Find a slot
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className={`preview ${over || (preview && !preview.ok) ? "bad" : ""}`} aria-live="polite">
        {preview?.ok &&
          (over
            ? longest === 0
              ? "No free time on this day: remove a log first"
              : `No free slot that long: the longest is ${formatSeconds(longest)}`
            : `= ${preview.seconds.toLocaleString()} s (${formatSeconds(preview.seconds)})`)}
        {preview && !preview.ok && preview.error}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
