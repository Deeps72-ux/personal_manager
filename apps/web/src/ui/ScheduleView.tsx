import { useEffect, useState, type FormEvent } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MAX_PRIORITY_RANK, type PrioritySlot, type Task } from "@pm/shared";
import { slotLabel } from "../core/actions.ts";
import { dropCard, planEntries, rankedList, sortRanked, isQueued, priorityOrder, pad2, type RankedCard } from "../core/views.ts";
import { GripIcon, XIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { useFolderName } from "./folder-chip.tsx";

const toDateInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const toTimeInput = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** Local date + time → epoch ms (NaN if either is missing). */
const at = (date: string, time: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (!y || !m || !d || hh === undefined || mm === undefined || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return new Date(y, m - 1, d, hh, mm).getTime();
};
/** The end on the start's day, or the next day when it is not after the start (a slot over midnight). */
const endAfter = (start: number, time: string): number => {
  let end = at(toDateInput(start), time);
  if (end <= start) end = new Date(end).setDate(new Date(end).getDate() + 1);
  return end;
};

/** Positions follow the list as it is now; cards ranked by position take theirs. */
const reposition = (cards: readonly RankedCard[]): RankedCard[] =>
  cards.map((c, i) => ({ ...c, position: i + 1, ...(c.source === "position" ? { rank: i + 1 } : {}) }));

interface Draft {
  slot: PrioritySlot | null;
  date: string;
  from: string;
  to: string;
  cards: RankedCard[];
}

/**
 * SCHEDULED priority lists: plan the list for a future time. At its start it
 * becomes the visible list and is confirmed; at its end the list from before
 * comes back. Slots never overlap. A future slot can be changed or deleted, a
 * running one can end earlier or later, past ones are kept to look at.
 */
export function ScheduleView({ onClose }: { onClose: () => void }) {
  const { slots: actions } = useServices();
  const data = useLive(
    async (s) => ({
      slots: await s.store.listSlots(),
      tasks: await s.store.listTasks(),
      placements: await s.store.listPlacements(),
      folders: await s.store.listFolders(),
    }),
    [],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && (draft ? setDraft(null) : onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, draft]);

  if (!data) return null;
  const live = rankedList(
    data.tasks,
    data.placements.filter((p) => !isQueued(p)),
    data.folders,
  );
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const homeOf = new Map(live.map((c) => [c.task.id, c.homeFolderId]));
  const upcoming = data.slots.filter((s) => s.endMs > now);
  const past = data.slots.filter((s) => s.endMs <= now).reverse();

  const startNew = () => {
    const start = Math.ceil((now + 60_000) / 900_000) * 900_000; // the next quarter hour
    setError(null);
    setDraft({ slot: null, date: toDateInput(start), from: toTimeInput(start), to: toTimeInput(start + 3_600_000), cards: live });
  };
  const edit = (slot: PrioritySlot) => {
    const cards = reposition(
      slot.list.entries
        .filter((e) => byId.has(e.taskId))
        .map(
          (e, i): RankedCard => ({
            task: byId.get(e.taskId)!,
            rank: e.rank,
            position: i + 1,
            source: e.folderId ? "folder" : "card",
            folderId: e.folderId,
            homeFolderId: e.folderId ?? homeOf.get(e.taskId) ?? null,
          }),
        ),
    );
    setError(null);
    setDraft({ slot, date: toDateInput(slot.startMs), from: toTimeInput(slot.startMs), to: toTimeInput(slot.endMs), cards });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const running = !!draft.slot && draft.slot.startMs <= now;
    const startMs = running ? draft.slot!.startMs : at(draft.date, draft.from);
    const endMs = endAfter(startMs, draft.to);
    void run(() =>
      actions.save({ ...(draft.slot ? { id: draft.slot.id } : {}), startMs, endMs, entries: planEntries(draft.cards) }),
    );
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !draft && onClose()}>
      <div className="modal schedule-modal" role="dialog" aria-modal="true" aria-label="Scheduled priority lists">
        <div className="modal-head">
          <h2>{draft ? (draft.slot ? "Scheduled list" : "New scheduled list") : "Scheduled lists"}</h2>
          <button className="icon" aria-label="Close" onClick={draft ? () => setDraft(null) : onClose}>
            <XIcon />
          </button>
        </div>
        {draft ? (
          <SlotEditor
            draft={draft}
            now={now}
            allTasks={priorityOrder(data.tasks, data.placements)}
            busy={busy}
            error={error}
            onChange={setDraft}
            onSave={save}
            onCancel={() => setDraft(null)}
            onDelete={() => draft.slot && void run(() => actions.remove(draft.slot!.id))}
            onEndNow={() => draft.slot && void run(() => actions.endNow(draft.slot!.id))}
          />
        ) : (
          <>
            <p className="hint">
              Plan your priority list for a future time. At its start it becomes your list and is confirmed; at its end
              the list from before comes back. Times can't overlap.
            </p>
            <button type="button" className="primary small" onClick={startNew}>
              ＋ New scheduled list
            </button>
            {upcoming.length === 0 ? (
              <p className="empty">Nothing scheduled.</p>
            ) : (
              <ul className="slot-list" aria-label="Upcoming">
                {upcoming.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="slot-row" onClick={() => edit(s)}>
                      <span className="slot-when">{slotLabel(s)}</span>
                      {s.startMs <= now && <span className="slot-badge">Running</span>}
                      <span className="slot-top muted">
                        {s.list.entries.length} task{s.list.entries.length === 1 ? "" : "s"}
                        {s.list.entries[0] ? ` · #1 ${s.list.entries[0].title}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {past.length > 0 && (
              <details className="slot-past">
                <summary>
                  Past scheduled lists <span className="count">{past.length}</span>
                </summary>
                <ul className="slot-list">
                  {past.map((s) => (
                    <li key={s.id} className="slot-row past">
                      <span className="slot-when">{slotLabel(s)}</span>
                      <ol className="slot-titles">
                        {s.list.entries.map((e) => (
                          <li key={e.taskId}>
                            #{e.rank} {e.title}
                          </li>
                        ))}
                      </ol>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SlotEditor({
  draft,
  now,
  allTasks,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
  onDelete,
  onEndNow,
}: {
  draft: Draft;
  now: number;
  allTasks: Task[];
  busy: boolean;
  error: string | null;
  onChange: (d: Draft) => void;
  onSave: (e: FormEvent) => void;
  onCancel: () => void;
  onDelete: () => void;
  onEndNow: () => void;
}) {
  const running = !!draft.slot && draft.slot.startMs <= now;
  const [editing, setEditing] = useState<string | null>(null);
  const folderName = useFolderName();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const cards = draft.cards;
  const inList = new Set(cards.map((c) => c.task.id));
  const leftOut = allTasks.filter((t) => !inList.has(t.id));
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const onDragEnd = (e: DragEndEvent) => {
    const from = cards.findIndex((c) => c.task.id === String(e.active.id));
    const to = e.over ? cards.findIndex((c) => c.task.id === String(e.over!.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    const drop = dropCard(cards, from, to);
    if (drop) set({ cards: drop.order });
  };
  const setRank = (id: string, rank: number | null) => {
    setEditing(null);
    set({
      cards: sortRanked(
        cards.map((c) =>
          c.task.id !== id
            ? c
            : rank === null
              ? { ...c, rank: c.position, source: "position", folderId: null }
              : { ...c, rank, source: "card", folderId: null },
        ),
      ),
    });
  };
  const leave = (id: string) => set({ cards: reposition(cards.filter((c) => c.task.id !== id)) });
  const addBack = (task: Task) =>
    set({
      cards: reposition([{ task, rank: 1, position: 0, source: "position", folderId: null, homeFolderId: null }, ...cards]),
    });

  return (
    <form className="slot-editor" onSubmit={onSave}>
      <div className="slot-times">
        <label>
          Date
          <input type="date" value={draft.date} disabled={running} onChange={(e) => set({ date: e.target.value })} required />
        </label>
        <label>
          From
          <input type="time" value={draft.from} disabled={running} onChange={(e) => set({ from: e.target.value })} required />
        </label>
        <label>
          To
          <input type="time" value={draft.to} onChange={(e) => set({ to: e.target.value })} required />
        </label>
      </div>
      <p className="hint">
        {running
          ? "Running now: only its end can change. The list from before it comes back at the end."
          : "An end earlier than the start means the next day. Drag to reorder, tap # to type a rank, ✕ to leave a task out. Tasks you add later go on top; deleted ones drop out."}
      </p>
      {running ? (
        <ol className="slot-titles">
          {cards.map((c) => (
            <li key={c.task.id}>
              #{c.rank} {c.task.title}
            </li>
          ))}
        </ol>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={cards.map((c) => c.task.id)} strategy={verticalListSortingStrategy}>
            <ol className="stack slot-stack">
              {cards.map((c, i) => (
                <DraftCard
                  key={c.task.id}
                  card={c}
                  index={i}
                  max={cards.length}
                  folder={folderName(c.task)}
                  editing={editing === c.task.id}
                  onRank={() => setEditing(c.task.id)}
                  onSetRank={(r) => setRank(c.task.id, r)}
                  onLeave={() => leave(c.task.id)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {!running && leftOut.length > 0 && (
        <div className="slot-left">
          <span className="muted">Not in this list:</span>
          {leftOut.map((t) => (
            <button key={t.id} type="button" className="past-chip" onClick={() => addBack(t)} aria-label={`Add ${t.title}`}>
              ＋ {t.title}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row slot-buttons">
        <button className="primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        {draft.slot && !running && (
          <button type="button" className="danger-outline" disabled={busy} onClick={onDelete}>
            Delete
          </button>
        )}
        {running && (
          <button type="button" className="danger-outline" disabled={busy} onClick={onEndNow}>
            End now
          </button>
        )}
      </div>
    </form>
  );
}

function DraftCard({
  card,
  index,
  max,
  folder,
  editing,
  onRank,
  onSetRank,
  onLeave,
}: {
  card: RankedCard;
  index: number;
  max: number;
  folder: string | null;
  editing: boolean;
  onRank: () => void;
  onSetRank: (rank: number | null) => void;
  onLeave: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.task.id });
  const [value, setValue] = useState(card.source === "card" ? String(card.rank) : "");
  const limit = Math.min(Math.max(1, max), MAX_PRIORITY_RANK);
  const submit = () => {
    const v = value.trim();
    if (v === "") return onSetRank(null);
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= limit) onSetRank(n);
  };
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`stack-item ${isDragging ? "placeholder" : ""}`}
      {...attributes}
      {...listeners}
      aria-label={`${card.rank}. ${card.task.title}`}
    >
      <TaskCard
        task={card.task}
        index={index}
        rank={card.rank}
        rankSet={card.source !== "position"}
        onRank={onRank}
        folder={folder}
        actions={
          <>
            {editing && (
              <span className="slot-rank" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={limit}
                  value={value}
                  placeholder={String(card.position)}
                  aria-label={`Rank of ${card.task.title}`}
                  autoFocus
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  onBlur={submit}
                />
              </span>
            )}
            <button
              type="button"
              className="icon"
              aria-label={`Leave ${card.task.title} out`}
              title="Leave out of this list"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onLeave}
            >
              <XIcon />
            </button>
            <GripIcon />
          </>
        }
      />
    </li>
  );
}
