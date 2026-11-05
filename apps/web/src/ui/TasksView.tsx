import { useState, type FormEvent } from "react";
import { LIMITS } from "@pm/shared";
import { priorityOrder } from "../core/views.ts";
import { XIcon } from "./icons.tsx";
import { useLive, useServices } from "./services.tsx";
import { TaskCard } from "./TaskCard.tsx";

/** TASKS: add and remove task cards. */
export function TasksView() {
  const { tasks } = useServices();
  const list = useLive(async (s) => priorityOrder(await s.store.listTasks(), await s.store.listPlacements()), []);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Take the values and clear the form NOW, so anything typed while the
    // save is in flight belongs to the next task (not wiped or merged).
    const input = { title, description, dueDate };
    setTitle("");
    setDescription("");
    setDueDate("");
    try {
      await tasks.create(input);
    } catch (err) {
      setTitle(input.title);
      setDescription(input.description);
      setDueDate(input.dueDate);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="view">
      <form className="panel addtask" onSubmit={add}>
        <h2>New task</h2>
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      <h2 className="section-title">
        All tasks <span className="count">{list?.length ?? 0}</span>
      </h2>
      {list && list.length === 0 && <p className="empty">No tasks yet. Add your first one above.</p>}
      <div className="cardlist">
        {list?.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            tilt={false}
            actions={
              confirmId === t.id ? (
                <span className="inline-confirm">
                  <button className="danger small" onClick={() => void tasks.remove(t.id).then(() => setConfirmId(null))}>
                    Remove
                  </button>
                  <button className="ghost small" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button className="icon" aria-label={`Remove ${t.title}`} title="Remove" onClick={() => setConfirmId(t.id)}>
                  <XIcon />
                </button>
              )
            }
          />
        ))}
      </div>
      {list && list.length > 0 && (
        <p className="hint">Removing a task never changes days you already logged.</p>
      )}
    </section>
  );
}
