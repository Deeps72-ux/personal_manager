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
import { DAY_SECONDS, formatSeconds, parseSecondsInput, sumSeconds, type Day, type Task } from "@pm/shared";
import { formatDayLong, priorityOrder } from "../core/views.ts";
import { ChevronLeft, XIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";
import { cardLook } from "./TaskCard.tsx";

const DROP_ID = "log-drop-zone";

/**
 * One day of the LOG. Drag a task card onto the drop zone (or tap it),
 * type the seconds, add. A day can never exceed 86,400 seconds.
 */
export function DaySheet({ day, onBack }: { day: Day; onBack: () => void }) {
  const { logs } = useServices();
  const entries = useLive((s) => s.store.listLogsForDay(day), [day]);
  const tasks = useLive(async (s) => priorityOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  const purgedBefore = useLive((s) => s.store.purgedBefore(), []);
  const [picked, setPicked] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  );

  const total = sumSeconds(entries ?? []);
  const left = DAY_SECONDS - total;
  const locked = purgedBefore != null && day < purgedBefore;

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

      <div className="daymeter" aria-label={`${total} of ${DAY_SECONDS} seconds logged`}>
        <div className="daymeter-bar">
          <span style={{ width: `${Math.min(100, (total / DAY_SECONDS) * 100)}%` }} />
        </div>
        <div className="daymeter-text">
          <strong>{total.toLocaleString()} s</strong> of {DAY_SECONDS.toLocaleString()} s
          <span className="muted"> · {formatSeconds(left)} left</span>
        </div>
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
                left={left}
                onCancel={() => setPicked(null)}
                onAdd={async (secs) => {
                  const r = await logs.add(day, secs, picked);
                  if (r.ok) setPicked(null);
                  return r.ok ? null : r.error;
                }}
              />
            ) : (
              <p className="dropzone-hint">
                {left > 0 ? "Drag a task card here (or tap one) to log seconds" : "This day is full: 24 hours logged"}
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
        {entries?.map((e) => (
          <li key={e.id} className="entry">
            <span className="entry-secs">{e.seconds.toLocaleString()} s</span>
            <span className="entry-title">{e.taskTitle}</span>
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
  left,
  onAdd,
  onCancel,
}: {
  title: string;
  left: number;
  onAdd: (secs: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const preview = value.trim() ? parseSecondsInput(value) : null;
  const over = preview?.ok && preview.seconds > left;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(await onAdd(value));
  };

  return (
    <form className="secondsform" onSubmit={submit}>
      <div className="secondsform-title">
        Seconds for <strong>{title}</strong>
      </div>
      <div className="row">
        <input
          ref={input}
          className="grow"
          inputMode="text"
          placeholder='e.g. 27, 8*60*60 or 1h30m'
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          aria-label={`Seconds for ${title}`}
        />
        <button className="primary" disabled={!preview?.ok || over}>
          Add
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className={`preview ${over || (preview && !preview.ok) ? "bad" : ""}`} aria-live="polite">
        {preview?.ok &&
          (over
            ? `Over 24 hours: only ${left.toLocaleString()} s (${formatSeconds(left)}) left`
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
