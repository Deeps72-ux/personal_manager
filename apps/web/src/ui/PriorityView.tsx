import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
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
import type { Task } from "@pm/shared";
import { priorityOrder } from "../core/views.ts";
import { GripIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";
import { TaskCard } from "./TaskCard.tsx";

/**
 * PRIORITY: every card in one stack; drag to reorder. The order is all this
 * screen stores. New cards appear on top.
 */
export function PriorityView({ onGoToTasks }: { onGoToTasks: () => void }) {
  const { priority } = useServices();
  const tasks = useLive(async (s) => priorityOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  // Optimistic order while the drop is being written, so cards never jump back.
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Press-and-hold on phones, so normal swipes still scroll the list.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!tasks) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = (optimistic ?? tasks.map((t) => t.id)).filter((id) => byId.has(id));
  const active = activeId ? byId.get(activeId) : undefined;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const from = ids.indexOf(String(e.active.id));
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    setOptimistic(arrayMove(ids, from, to));
    void priority.move(String(e.active.id), to).finally(() => setOptimistic(null));
  };

  return (
    <section className="view">
      <div className="view-head">
        <h2 className="section-title">
          Priority <span className="count">{tasks.length}</span>
        </h2>
        {tasks.length > 1 && <p className="hint">Drag cards to reorder. On a phone, press and hold a card first.</p>}
      </div>

      {tasks.length === 0 ? (
        <div className="empty">
          <p>Your stack is empty.</p>
          <button className="primary" onClick={onGoToTasks}>
            Add a task
          </button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ol className="stack">
              {ids.map((id, i) => (
                <SortableCard key={id} task={byId.get(id)!} index={i} />
              ))}
            </ol>
          </SortableContext>
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }}>
            {active ? <TaskCard task={active} className="dragging" actions={<GripIcon />} /> : null}
          </DragOverlay>
        </DndContext>
      )}
    </section>
  );
}

function SortableCard({ task, index }: { task: Task; index: number }) {
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
      <TaskCard task={task} index={index} actions={<GripIcon />} />
    </li>
  );
}
