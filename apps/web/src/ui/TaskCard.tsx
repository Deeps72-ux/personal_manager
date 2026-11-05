import type { CSSProperties, ReactNode } from "react";
import type { Task } from "@pm/shared";
import { formatDayLong } from "../core/views.ts";

/** Stable per-card "personality" from the id: accent hue + slight tilt. */
export function cardLook(id: string): { hue: number; tilt: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const u = h >>> 0;
  return { hue: u % 360, tilt: ((u >>> 9) % 25) / 10 - 1.2 }; // -1.2° … +1.2°
}

export function TaskCard({
  task,
  index,
  actions,
  style,
  className = "",
  tilt = true,
}: {
  task: Task;
  index?: number;
  actions?: ReactNode;
  style?: CSSProperties;
  className?: string;
  tilt?: boolean;
}) {
  const look = cardLook(task.id);
  return (
    <article
      className={`taskcard ${className}`}
      style={{ "--hue": look.hue, "--tilt": tilt ? `${look.tilt}deg` : "0deg", ...style } as CSSProperties}
    >
      {index !== undefined && <span className="rank">#{index + 1}</span>}
      <div className="taskcard-body">
        <h3>{task.title}</h3>
        {task.description && <p className="desc">{task.description}</p>}
        {task.dueDate && <span className="due">Due {formatDayLong(task.dueDate)}</span>}
      </div>
      {actions && <div className="taskcard-actions">{actions}</div>}
    </article>
  );
}
