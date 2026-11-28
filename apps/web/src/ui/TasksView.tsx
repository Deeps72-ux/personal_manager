import { createContext, useContext, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { LIMITS, type Folder, type Task } from "@pm/shared";
import type { Slot } from "../core/actions.ts";
import { buildFolderTree, type Entry, type FolderId, type FolderTree } from "../core/folders.ts";
import { FolderIcon, FolderPlusIcon, MoveIcon, PencilIcon, XIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { useDragAutoScroll } from "./drag-autoscroll.ts";

const FOLDER_KEY = "pm.tasks.folder";

function readFolder(): FolderId {
  try {
    return localStorage.getItem(FOLDER_KEY) || null;
  } catch {
    return null;
  }
}

function rememberFolder(id: FolderId) {
  try {
    if (id) localStorage.setItem(FOLDER_KEY, id);
    else localStorage.removeItem(FOLDER_KEY);
  } catch {
    // private mode: just don't remember
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What is being dragged, or moved with "Move to…". */
type Item = { kind: "task"; id: string } | { kind: "folder"; id: string };
const itemId = (i: Item) => `${i.kind}:${i.id}`;
function parseItem(id: string): Item | null {
  const [kind, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  return kind === "task" || kind === "folder" ? { kind, id: rest } : null;
}

/** Where a drag would land: next to a task/folder, or into a folder ("root" = the top level). */
type Drop = { target: string; zone: "before" | "after" | "into" };

/**
 * TASKS: add and remove task cards, sorted into FOLDERS. Folders only shape
 * this tab: every other screen lists tasks the same, whatever their folder.
 */
export function TasksView() {
  const { tasks, folders } = useServices();
  const data = useLive(
    async (s) => ({ folders: await s.store.listFolders(), tasks: await s.store.listTasks(), placements: await s.store.listPlacements() }),
    [],
  );
  const tree = useMemo(() => (data ? buildFolderTree(data.folders, data.tasks, data.placements) : null), [data]);

  const [wanted, setWanted] = useState<FolderId>(readFolder);
  // A remembered folder that is gone (deleted on another device) falls back to the top level.
  const current: FolderId = tree && wanted && !tree.has(wanted) ? null : wanted;
  const open = (id: FolderId) => {
    setWanted(id);
    rememberFolder(id);
    setConfirm(null);
    setRenaming(null);
    setRanking(null);
    setCreating(false);
    setError(null);
  };

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null); // itemId awaiting Remove/Keep
  const [renaming, setRenaming] = useState<string | null>(null);
  const [ranking, setRanking] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<Item | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    // Take the values and clear the form NOW, so anything typed while the
    // save is in flight belongs to the next task (not wiped or merged).
    const input = { title, description, dueDate, folderId: current };
    setTitle("");
    setDescription("");
    setDueDate("");
    try {
      await tasks.create(input);
    } catch (err) {
      setTitle(input.title);
      setDescription(input.description);
      setDueDate(input.dueDate);
      setFormError(message(err));
    }
  };

  /** Runs a folder action; a refusal (duplicate name, folder into itself) shows above the list. */
  const attempt = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    }
  };

  const moveTo = (item: Item, target: FolderId, slot?: Slot) =>
    attempt(() => (item.kind === "task" ? folders.moveTask(item.id, target, slot) : folders.moveFolder(item.id, target, slot)));

  const here = tree?.get(current ?? "");
  const entries = tree?.items(current) ?? [];
  const total = !tree ? 0 : current === null ? (data?.tasks.length ?? 0) : tree.taskCount(current);

  return (
    <section className="view">
      <form className="panel addtask" onSubmit={add}>
        <h2>{here ? <>New task in {here.name}</> : "New task"}</h2>
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            maxLength={LIMITS.titleMax}
            required
          />
        </label>
        <label>
          <span>
            Description <span className="muted">(optional)</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={LIMITS.descriptionMax}
          />
        </label>
        <div className="row">
          <label className="grow">
            <span>
              Due date <span className="muted">(optional)</span>
            </span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <button className="primary">Add task</button>
        </div>
        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}
      </form>

      {tree && (
        <FolderBrowser
          tree={tree}
          current={current}
          onDrop={(item, drop) => void dropItem(tree, current, item, drop, moveTo)}
        >
          <div className="folder-head">
            <Crumbs tree={tree} current={current} onOpen={open} total={total} />
            <button
              className="ghost small new-folder"
              onClick={() => {
                setCreating(true);
                setError(null);
              }}
              disabled={creating}
            >
              <FolderPlusIcon /> New folder
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          {creating && (
            <ul className="folderlist" aria-label="New folder">
              <NewFolderRow
                  onCreate={async (name) => {
                    const ok = await attempt(() => folders.create(name, current));
                    if (ok) setCreating(false);
                  }}
                  onCancel={() => {
                    setCreating(false);
                    setError(null);
                  }}
                />
            </ul>
          )}

          {entries.length === 0 && !creating && (
            <p className="empty">{current === null ? "No tasks yet. Add your first one above." : "No tasks or folders yet."}</p>
          )}

          <div className="itemlist">
            {runs(entries).map((run) =>
              run[0]!.kind === "folder" ? (
                <ul key={run[0]!.id} className="folderlist" aria-label="Folders">
                  {run.map((e) => {
                    if (e.kind !== "folder") return null;
                    const f = e.folder;
                    return (
                      <FolderRow
                        key={f.id}
                        folder={f}
                        tree={tree}
                        renaming={renaming === f.id}
                        ranking={ranking === f.id}
                        onRankStart={() => {
                          setRanking(f.id);
                          setRenaming(null);
                          setConfirm(null);
                          setError(null);
                        }}
                        onRanked={async (rank) => {
                          const ok = await attempt(() => folders.setPriority(f.id, rank));
                          if (ok) setRanking(null);
                        }}
                        onCancelRank={() => {
                          setRanking(null);
                          setError(null);
                        }}
                        confirming={confirm === `folder:${f.id}`}
                        onOpen={() => open(f.id)}
                        onRename={() => {
                          setRenaming(f.id);
                          setConfirm(null);
                          setError(null);
                        }}
                        onRenamed={async (name) => {
                          const ok = await attempt(() => folders.rename(f.id, name));
                          if (ok) setRenaming(null);
                        }}
                        onCancelRename={() => {
                          setRenaming(null);
                          setError(null);
                        }}
                        onMove={() => setMoving({ kind: "folder", id: f.id })}
                        onAskRemove={() => setConfirm(`folder:${f.id}`)}
                        onRemove={() => void folders.remove(f.id).then(() => setConfirm(null))}
                        onKeep={() => setConfirm(null)}
                      />
                    );
                  })}
                </ul>
              ) : (
                <div key={run[0]!.id} className="cardlist">
                  {run.map((e) => {
                    if (e.kind !== "task") return null;
                    const t = e.task;
                    return (
                      <TaskItem
                      key={t.id}
                      task={t}
                      actions={
                        confirm === `task:${t.id}` ? (
                          <span className="inline-confirm">
                            <button className="danger small" onClick={() => void tasks.remove(t.id).then(() => setConfirm(null))}>
                              Remove
                            </button>
                            <button className="ghost small" onClick={() => setConfirm(null)}>
                              Keep
                            </button>
                          </span>
                        ) : (
                          <>
                            <button
                              className="icon"
                              aria-label={`Move ${t.title}`}
                              title="Move to…"
                              onClick={() => setMoving({ kind: "task", id: t.id })}
                            >
                              <MoveIcon />
                            </button>
                            <button
                              className="icon"
                              aria-label={`Remove ${t.title}`}
                              title="Remove"
                              onClick={() => setConfirm(`task:${t.id}`)}
                            >
                              <XIcon />
                            </button>
                          </>
                        )
                      }
                    />
                    );
                  })}
                </div>
              ),
            )}
          </div>
        </FolderBrowser>
      )}
      {data && data.tasks.length + data.folders.length > 0 && (
        <p className="hint">
          New tasks and folders, and anything moved in, go to the very top. Drag a card or folder onto a folder to move it in,
          or onto a name in the path above to move it out. Removing a task never changes days you already logged.
        </p>
      )}

      {moving && tree && data && (
        <MoveDialog
          tree={tree}
          item={moving}
          {...describe(tree, data.tasks, moving)}
          onPick={async (target) => {
            const ok = await moveTo(moving, target);
            if (ok) setMoving(null);
          }}
          onClose={() => setMoving(null)}
          error={error}
        />
      )}
    </section>
  );
}

/** Runs of neighbouring rows of the same kind: folders render as a list, tasks as cards. */
function runs(entries: readonly Entry[]): Entry[][] {
  const out: Entry[][] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (last && last[0]!.kind === e.kind) last.push(e);
    else out.push([e]);
  }
  return out;
}

/** `current`'s rows without the dragged item, and the row `over` among them. */
function around(tree: FolderTree, current: FolderId, item: Item, over: Item) {
  const list = tree.items(current).filter((e) => !(e.kind === item.kind && e.id === item.id));
  const entry = list.find((e) => e.kind === over.kind && e.id === over.id);
  return { list, entry };
}

/**
 * Apply a finished drag. "into" moves to the very top of that folder.
 * Next to a row: beside a recent row it joins the recent area; beside a row
 * of its own kind it joins that block; above the very first row (of the
 * other kind) it goes to the recent area.
 */
async function dropItem(
  tree: FolderTree,
  current: FolderId,
  item: Item,
  drop: Drop,
  moveTo: (item: Item, target: FolderId, slot?: Slot) => Promise<boolean>,
) {
  const over = drop.target === "root" ? null : parseItem(drop.target);
  if (drop.zone === "into") {
    const target = drop.target === "root" ? null : over?.id ?? null;
    await moveTo(item, target);
    return;
  }
  if (!over) return;
  const { list, entry } = around(tree, current, item, over);
  if (!entry) return;
  const after = drop.zone === "after" ? 1 : 0;
  if (entry.top || entry.kind !== item.kind) {
    const top = list.filter((e) => e.top);
    const at = top.indexOf(entry);
    await moveTo(item, current, { top: true, index: at < 0 ? top.length : at + after });
    return;
  }
  const block = list.filter((e) => !e.top && e.kind === item.kind);
  await moveTo(item, current, { top: false, index: block.indexOf(entry) + after });
}

// ───────────── drag and drop ─────────────

/** Pointer Y during a drag: where it started plus how far it moved. */
function pointerY(e: DragMoveEvent): number | null {
  const a = e.activatorEvent as (MouseEvent & TouchEvent) | null;
  if (!a) return null;
  const y = typeof a.clientY === "number" ? a.clientY : (a.touches?.[0] ?? a.changedTouches?.[0])?.clientY;
  return typeof y === "number" ? y + e.delta.y : null;
}

/**
 * Where `item` would land over `overId` in `current`, given how far down the
 * target the pointer is (0..1). It can go next to a recent row, next to a row
 * of its own kind, or above the very first row; over a folder's middle, into it.
 */
export function dropZone(tree: FolderTree, current: FolderId, item: Item, overId: string, frac: number): Drop | null {
  if (overId === itemId(item)) return null;
  if (overId.startsWith("crumb:")) {
    const target = overId.slice("crumb:".length);
    if (item.kind === "folder" && target !== "root" && tree.contains(item.id, target)) return null;
    return { target: target === "root" ? "root" : `folder:${target}`, zone: "into" };
  }
  const over = parseItem(overId);
  if (!over) return null;
  const { list, entry } = around(tree, current, item, over);
  if (!entry) return null;
  const beside = entry.top || entry.kind === item.kind;
  const fits = (side: "before" | "after") => beside || (side === "before" && list[0] === entry);
  if (entry.kind === "folder") {
    const edge = frac < 0.25 ? "before" : frac > 0.75 ? "after" : null;
    return { target: overId, zone: edge && fits(edge) ? edge : "into" };
  }
  const half = frac < 0.5 ? "before" : "after";
  return fits(half) ? { target: overId, zone: half } : null;
}

/** The drop the current drag would make, for the targets to light up. */
const DropState = createContext<Drop | null>(null);

function FolderBrowser({
  tree,
  current,
  onDrop,
  children,
}: {
  tree: FolderTree;
  current: FolderId;
  onDrop: (item: Item, drop: Drop) => void;
  children: ReactNode;
}) {
  // Long-press on touch so a normal swipe still scrolls; a small move with a mouse.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const [active, setActive] = useState<Item | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const update = (d: Drop | null) => {
    dropRef.current = d;
    setDrop((old) => (old?.target === d?.target && old?.zone === d?.zone ? old : d));
  };

  const onMove = (e: DragMoveEvent) => {
    const item = parseItem(String(e.active.id));
    const y = pointerY(e);
    if (!item || !e.over || y === null) return update(null);
    const r = e.over.rect;
    update(dropZone(tree, current, item, String(e.over.id), r.height > 0 ? (y - r.top) / r.height : 0.5));
  };

  const edgeScroll = useDragAutoScroll();
  const end = () => {
    edgeScroll.stop();
    setActive(null);
    update(null);
  };

  return (
    <DropState.Provider value={drop}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        autoScroll={false}
        onDragStart={(e: DragStartEvent) => {
          setActive(parseItem(String(e.active.id)));
          edgeScroll.start(e.activatorEvent);
        }}
        onDragMove={onMove}
        onDragEnd={() => {
          const d = dropRef.current;
          if (active && d) onDrop(active, d);
          end();
        }}
        onDragCancel={end}
      >
        <div className="folder-browser" data-folder={current ?? "root"}>
          {children}
        </div>
        <DragOverlay dropAnimation={null}>
          {active?.kind === "task" && tree.tasks(current).find((t) => t.id === active.id) && (
            <TaskCard task={tree.tasks(current).find((t) => t.id === active.id)!} tilt={false} className="dragging" />
          )}
          {active?.kind === "folder" && tree.get(active.id) && (
            <div className="folderrow dragging">
              <span className="folder-open">
                <FolderIcon />
                <span className="folder-name">{tree.get(active.id)!.name}</span>
              </span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </DropState.Provider>
  );
}


/** CSS class showing where a drop would land on this target. */
function useDropClass(id: string): string {
  const drop = useContext(DropState);
  if (!drop || drop.target !== id) return "";
  return `drop-${drop.zone}`;
}

function TaskItem({ task, actions }: { task: Task; actions: ReactNode }) {
  const id = `task:${task.id}`;
  const drag = useDraggable({ id });
  const dropTarget = useDroppable({ id });
  const dropClass = useDropClass(id);
  return (
    <div
      ref={(n) => {
        drag.setNodeRef(n);
        dropTarget.setNodeRef(n);
      }}
      className={`drag-item ${drag.isDragging ? "placeholder" : ""} ${dropClass}`}
      {...drag.attributes}
      {...drag.listeners}
      role="group"
      aria-label={task.title}
      tabIndex={-1}
    >
      <TaskCard task={task} tilt={false} actions={actions} />
    </div>
  );
}

// ───────────── folders ─────────────

function FolderRow({
  folder,
  tree,
  renaming,
  ranking,
  onRankStart,
  onRanked,
  onCancelRank,
  confirming,
  onOpen,
  onRename,
  onRenamed,
  onCancelRename,
  onMove,
  onAskRemove,
  onRemove,
  onKeep,
}: {
  folder: Folder;
  tree: FolderTree;
  renaming: boolean;
  ranking: boolean;
  onRankStart: () => void;
  onRanked: (rank: number | null) => Promise<void>;
  onCancelRank: () => void;
  confirming: boolean;
  onOpen: () => void;
  onRename: () => void;
  onRenamed: (name: string) => Promise<void>;
  onCancelRename: () => void;
  onMove: () => void;
  onAskRemove: () => void;
  onRemove: () => void;
  onKeep: () => void;
}) {
  const id = `folder:${folder.id}`;
  const editing = renaming || ranking;
  const drag = useDraggable({ id, disabled: editing });
  const priority = folder.priority ?? null;
  const dropTarget = useDroppable({ id });
  const dropClass = useDropClass(id);
  const count = tree.taskCount(folder.id);
  const inside = tree.descendants(folder.id).length + 1;

  return (
    <li
      ref={(n) => {
        drag.setNodeRef(n);
        dropTarget.setNodeRef(n);
      }}
      className={`folderrow drag-item ${drag.isDragging ? "placeholder" : ""} ${dropClass}`}
      {...(editing ? {} : { ...drag.attributes, ...drag.listeners })}
      tabIndex={-1}
    >
      {renaming ? (
        <NameForm label={`Rename ${folder.name}`} initial={folder.name} onSave={onRenamed} onCancel={onCancelRename} />
      ) : ranking ? (
        <RankForm name={folder.name} initial={priority} onSave={onRanked} onCancel={onCancelRank} />
      ) : (
        <button className="folder-open" onClick={onOpen} aria-label={`Open ${folder.name}, ${plural(count, "task")}`}>
          <FolderIcon />
          <span className="folder-name">{folder.name}</span>
          <span className="count">{count}</span>
        </button>
      )}
      {!editing &&
        (confirming ? (
          <span className="folder-confirm">
            <span className="muted">
              Deletes {inside === 1 ? "this folder" : plural(inside, "folder")} and {plural(count, "task")}
            </span>
            <span className="inline-confirm">
              <button className="danger small" onClick={onRemove}>
                Remove
              </button>
              <button className="ghost small" onClick={onKeep}>
                Keep
              </button>
            </span>
          </span>
        ) : (
          <span className="taskcard-actions">
            <button
              className={`icon folder-rank ${priority !== null ? "set" : ""}`}
              aria-label={priority !== null ? `${folder.name}: priority rank ${priority}, change` : `Give ${folder.name} a priority rank`}
              title="Priority rank for every task inside"
              onClick={onRankStart}
            >
              #{priority ?? ""}
            </button>
            <button className="icon" aria-label={`Rename ${folder.name}`} title="Rename" onClick={onRename}>
              <PencilIcon />
            </button>
            <button className="icon" aria-label={`Move ${folder.name}`} title="Move to…" onClick={onMove}>
              <MoveIcon />
            </button>
            <button className="icon" aria-label={`Remove ${folder.name}`} title="Remove" onClick={onAskRemove}>
              <XIcon />
            </button>
          </span>
        ))}
    </li>
  );
}

function NewFolderRow({ onCreate, onCancel }: { onCreate: (name: string) => Promise<void>; onCancel: () => void }) {
  return (
    <li className="folderrow">
      <NameForm label="New folder name" initial="" onSave={onCreate} onCancel={onCancel} />
    </li>
  );
}

/** Inline folder rank: a number (Enter saves), Clear removes it, Esc cancels. */
function RankForm({
  name,
  initial,
  onSave,
  onCancel,
}: {
  name: string;
  initial: number | null;
  onSave: (rank: number | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial === null ? "" : String(initial));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSave(value.trim() === "" ? null : Number(value));
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <form className="name-form" onSubmit={submit} noValidate>
      <span className="folder-rank-label">#</span>
      <input
        aria-label={`Priority rank of ${name}`}
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys}
        placeholder="Rank for every task inside"
        autoFocus
      />
      <button className="primary small">Save</button>
      {initial !== null && (
        <button type="button" className="ghost small" onClick={() => void onSave(null)}>
          Clear
        </button>
      )}
      <button type="button" className="ghost small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** Inline name field: Enter saves, Esc cancels. */
function NameForm({
  label,
  initial,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSave(name);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <form className="name-form" onSubmit={submit}>
      <FolderIcon />
      <input
        aria-label={label}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={keys}
        maxLength={LIMITS.titleMax}
        placeholder="Folder name"
        autoFocus
        required
      />
      <button className="primary small">Save</button>
      <button type="button" className="ghost small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

// ───────────── path ─────────────

/** Tasks › … › Parent › Current. Every name but the current one opens it, and takes drops. */
function Crumbs({
  tree,
  current,
  onOpen,
  total,
}: {
  tree: FolderTree;
  current: FolderId;
  onOpen: (id: FolderId) => void;
  total: number;
}) {
  const path = tree.path(current);
  const here = path.at(-1);
  const ancestors = path.slice(0, -1);
  // Long paths keep the top level and the last two parents.
  const hidden = ancestors.length > 2 ? ancestors.slice(0, -2) : [];
  const shown = ancestors.length > 2 ? ancestors.slice(-2) : ancestors;
  return (
    <nav className="crumbs" aria-label="Folder path">
      {here ? (
        <>
          <Crumb id="root" name="Tasks" onOpen={() => onOpen(null)} />
          {hidden.length > 0 && (
            <>
              <span className="crumb-sep" aria-hidden="true">
                ›
              </span>
              <span className="crumb-more" title={hidden.map((f) => f.name).join(" › ")}>
                …
              </span>
            </>
          )}
          {shown.map((f) => (
            <span key={f.id} className="crumb-wrap">
              <span className="crumb-sep" aria-hidden="true">
                ›
              </span>
              <Crumb id={f.id} name={f.name} onOpen={() => onOpen(f.id)} />
            </span>
          ))}
          <span className="crumb-sep" aria-hidden="true">
            ›
          </span>
          <h2 className="crumb-current" aria-current="page">
            {here.name} <span className="count">{total}</span>
          </h2>
        </>
      ) : (
        <h2 className="crumb-current" aria-current="page">
          Tasks <span className="count">{total}</span>
        </h2>
      )}
    </nav>
  );
}

function Crumb({ id, name, onOpen }: { id: string; name: string; onOpen: () => void }) {
  const dropId = `crumb:${id}`;
  const { setNodeRef } = useDroppable({ id: dropId });
  const drop = useContext(DropState);
  const target = id === "root" ? "root" : `folder:${id}`;
  const lit = drop?.zone === "into" && drop.target === target;
  return (
    <button ref={setNodeRef} className={`crumb ${lit ? "drop-into" : ""}`} onClick={onOpen}>
      {name}
    </button>
  );
}

// ───────────── Move to… ─────────────

/** The moved item's name and the folder it is in now. */
function describe(tree: FolderTree, tasks: readonly Task[], item: Item): { name: string; where: FolderId } {
  if (item.kind === "folder") return { name: tree.get(item.id)?.name ?? "", where: tree.parentOf(item.id) };
  const task = tasks.find((t) => t.id === item.id);
  return { name: task?.title ?? "", where: task ? tree.folderOf(task) : null };
}

function MoveDialog({
  tree,
  item,
  name,
  where,
  onPick,
  onClose,
  error,
}: {
  tree: FolderTree;
  item: Item;
  name: string;
  where: FolderId;
  onPick: (target: FolderId) => void;
  onClose: () => void;
  error: string | null;
}) {
  // Not where it already is, and a folder never into itself or its own sub-folders.
  const blocked = (target: FolderId) => target === where || (item.kind === "folder" && tree.contains(item.id, target));

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal move-modal" role="dialog" aria-modal="true" aria-label={`Move ${name}`}>
        <div className="modal-head">
          <h2>Move “{name}” to…</h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <ul className="move-list">
          <li>
            <button className="move-target" disabled={blocked(null)} onClick={() => onPick(null)}>
              Tasks <span className="muted">(top level)</span>
            </button>
          </li>
          {tree.flatten().map(({ folder, depth }) => (
            <li key={folder.id}>
              <button
                className="move-target"
                style={{ paddingLeft: `${0.8 + (depth + 1) * 1.1}rem` }}
                disabled={blocked(folder.id)}
                onClick={() => onPick(folder.id)}
              >
                <FolderIcon />
                {folder.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
