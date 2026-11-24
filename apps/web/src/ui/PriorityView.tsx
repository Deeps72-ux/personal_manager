import { useEffect, useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { latestConfirmed, type Task } from "@pm/shared";
import { canConfirm, splitPriority, type QueuedTask } from "../core/views.ts";
import { CheckIcon, GripIcon, QueueIcon, XIcon } from "./icons.tsx";
import { formatWait, heat, useNow, type Heat } from "./queue-heat.ts";
import { useLive, useServices } from "./services.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { FolderChip, useFolderName } from "./folder-chip.tsx";

const QUEUE_ID = "waiting-queue";
const EXIT_ID = "queue-exit";

/** The queue icon wins whenever the pointer / finger is over it; otherwise the nearest card. */
const collision: CollisionDetection = (args) => {
  const onQueue = pointerWithin(args).filter((c) => c.id === QUEUE_ID);
  if (onQueue.length) return onQueue;
  return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => c.id !== QUEUE_ID) });
};

const heatStyle = (h: Heat) =>
  ({
    "--q-color": h.color,
    "--q-glow": `${h.glow}px`,
    "--q-pulse": h.pulse === null ? "0s" : `${h.pulse}s`,
  }) as CSSProperties;

/**
 * PRIORITY: every card in one stack; drag to reorder. New cards appear on top.
 * Top right: the WAITING QUEUE. Drag a card onto it to park it there; it
 * glows from blue to red as its oldest task keeps waiting.
 *
 * Next to it, the CONFIRM icon: reordering, adding, deleting, queuing and
 * un-queuing only change what you see. Scores keep using the last confirmed
 * order until you press it; then the visible list (never the queue) is
 * snapshotted at that moment. It can only be pressed when the order differs.
 */
export function PriorityView({ onGoToTasks }: { onGoToTasks: () => void }) {
  const { priority } = useServices();
  const data = useLive(async (s) => splitPriority(await s.store.listTasks(), await s.store.listPlacements()), []);
  const confirmed = useLive(async (s) => latestConfirmed(await s.store.listHistory()), []);
  const [confirming, setConfirming] = useState(false);
  // Optimistic order while the drop is being written, so cards never jump back.
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const now = useNow(1000);
  const folderName = useFolderName();

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Press-and-hold on phones, so normal swipes still scroll the list.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!data) return null;
  const { list: tasks, queue } = data;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = (optimistic ?? tasks.map((t) => t.id)).filter((id) => byId.has(id));
  const active = activeId ? byId.get(activeId) : undefined;
  const pending = confirmed !== undefined && canConfirm(tasks.map((t) => t.title), confirmed);
  const confirm = () => {
    if (!pending || confirming) return;
    setConfirming(true);
    void priority
      .confirm()
      .catch((err: unknown) => console.error(err))
      .finally(() => setConfirming(false));
  };

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const id = String(e.active.id);
    if (e.over?.id === QUEUE_ID) {
      setOptimistic(ids.filter((x) => x !== id));
      void priority.enqueue(id).finally(() => setOptimistic(null));
      return;
    }
    const from = ids.indexOf(id);
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    setOptimistic(arrayMove(ids, from, to));
    void priority.move(id, to).finally(() => setOptimistic(null));
  };

  return (
    <section className="view">
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="view-head priority-head">
          <div className="priority-title">
            <h2 className="section-title">
              Priority <span className="count">{ids.length}</span>
            </h2>
            {ids.length > 0 && (
              <p className="hint">
                Drag cards to reorder, or onto the queue to park them. On a phone, press and hold a card first.
              </p>
            )}
            {pending && (
              <p className="hint confirm-hint" role="status">
                {confirmed
                  ? "Order changed: scores still use the last confirmed order. Press ✓ when you're done."
                  : "Nothing confirmed yet: logs are not scored until you press ✓."}
              </p>
            )}
          </div>
          <button
            type="button"
            className={`confirm-btn ${pending ? "pending" : ""}`}
            disabled={!pending || confirming}
            onClick={confirm}
            aria-label={pending ? "Confirm this priority order" : "Priority order confirmed"}
            title={pending ? "Confirm this priority order" : "This order is confirmed"}
          >
            <CheckIcon />
          </button>
          <QueueButton queue={queue} now={now} dragging={activeId !== null} onOpen={() => setQueueOpen(true)} />
        </div>

        {ids.length === 0 ? (
          <div className="empty">
            <p>{queue.length ? "Everything is in the waiting queue." : "Your stack is empty."}</p>
            <button className="primary" onClick={onGoToTasks}>
              Add a task
            </button>
          </div>
        ) : (
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ol className="stack">
              {ids.map((id, i) => (
                <SortableCard key={id} task={byId.get(id)!} index={i} folder={folderName(byId.get(id)!)} />
              ))}
            </ol>
          </SortableContext>
        )}
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }}>
          {active ? <TaskCard task={active} className="dragging" actions={<GripIcon />} folder={folderName(active)} /> : null}
        </DragOverlay>
      </DndContext>

      {queueOpen && <QueueModal queue={queue} now={now} onClose={() => setQueueOpen(false)} />}
    </section>
  );
}

function SortableCard({ task, index, folder }: { task: Task; index: number; folder: string | null }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`stack-item ${isDragging ? "placeholder" : ""}`}
      {...attributes}
      {...listeners}
      aria-label={`${index + 1}. ${task.title}`}
    >
      <TaskCard task={task} index={index} actions={<GripIcon />} folder={folder} />
    </li>
  );
}

/** The icon: a drop target while dragging, opens the queue when tapped. Glows by the OLDEST task's wait. */
function QueueButton({
  queue,
  now,
  dragging,
  onOpen,
}: {
  queue: readonly QueuedTask[];
  now: number;
  dragging: boolean;
  onOpen: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: QUEUE_ID });
  const oldest = queue[0];
  const h = oldest ? heat(now - oldest.queuedAt) : null;
  const label = oldest
    ? `Waiting queue: ${queue.length} task${queue.length === 1 ? "" : "s"}, oldest waiting ${formatWait(now - oldest.queuedAt)}`
    : "Waiting queue: empty";
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`queue-btn ${h ? "hot" : ""} ${h?.pulse ? "pulsing" : ""} ${dragging ? "armed" : ""} ${isOver ? "over" : ""}`}
      style={h ? heatStyle(h) : undefined}
      onClick={onOpen}
      aria-label={label}
      title={label}
    >
      <QueueIcon />
      {queue.length > 0 && <span className="queue-count">{queue.length}</span>}
    </button>
  );
}

/**
 * The WAITING QUEUE as a downward pipeline: newest on top, the first one in
 * at the bottom. Only the bottom task can be pulled out (dragged down into
 * the outlet): it goes back to the priority list at the top (#1).
 */
function QueueModal({ queue, now, onClose }: { queue: readonly QueuedTask[]; now: number; onClose: () => void }) {
  const { priority } = useServices();
  const [leaving, setLeaving] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && !dragging && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dragging]);

  const shown = queue.filter((q) => q.task.id !== leaving);
  const bottom = shown[0];
  const pipeline = [...shown].reverse(); // newest first, oldest last (bottom)

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(false);
    if (e.over?.id !== EXIT_ID || !bottom) return;
    const id = bottom.task.id;
    setLeaving(id);
    void priority.dequeue(id).finally(() => setLeaving(null));
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal queue-modal" role="dialog" aria-modal="true" aria-label="Waiting queue">
        <div className="modal-head">
          <h2>
            Waiting queue <span className="count">{shown.length}</span>
          </h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        {shown.length === 0 ? (
          <p className="empty">Nothing is waiting. Drag a priority card onto the queue icon to park it here.</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={(a) => {
              const hit = pointerWithin(a);
              return hit.length ? hit : rectIntersection(a); // keyboard drags have no pointer
            }}
            onDragStart={() => setDragging(true)}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragging(false)}
          >
            <p className="hint">
              In at the top, out at the bottom. Pull the bottom task down and out: it goes back to the top of your
              priority list as #1. Confirm the order there to score it.
            </p>
            <ol className="pipeline">
              {pipeline.map((q) =>
                q === bottom ? (
                  <BottomCard key={q.task.id} item={q} now={now} />
                ) : (
                  <li key={q.task.id} className="pipe-item" style={heatStyle(heat(now - q.queuedAt))}>
                    <QueueCard item={q} now={now} />
                  </li>
                ),
              )}
            </ol>
            <Outlet armed={dragging} />
          </DndContext>
        )}
      </div>
    </div>
  );
}

function QueueCard({ item, now }: { item: QueuedTask; now: number }) {
  const h = heat(now - item.queuedAt);
  const folderName = useFolderName();
  return (
    <div className={`queue-card ${h.pulse ? "pulsing" : ""}`}>
      <span className="queue-card-main">
        <span className="queue-card-title">{item.task.title}</span>
        <FolderChip name={folderName(item.task)} />
      </span>
      <span className="queue-card-wait">waiting {formatWait(now - item.queuedAt)}</span>
    </div>
  );
}

function BottomCard({ item, now }: { item: QueuedTask; now: number }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `pop-${item.task.id}` });
  return (
    <li
      ref={setNodeRef}
      className={`pipe-item bottom ${isDragging ? "lifting" : ""}`}
      style={{ ...heatStyle(heat(now - item.queuedAt)), transform: CSS.Translate.toString(transform) }}
      aria-label={`${item.task.title}, first in line. Drag down and out to put it back at the top of the priority list as #1.`}
      {...attributes}
      {...listeners}
    >
      <QueueCard item={item} now={now} />
    </li>
  );
}

function Outlet({ armed }: { armed: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: EXIT_ID });
  return (
    <div ref={setNodeRef} className={`queue-outlet ${armed ? "armed" : ""} ${isOver ? "over" : ""}`}>
      {isOver ? "Release: back to the list as #1" : "↓ Pull out here (back to the list as #1)"}
    </div>
  );
}
