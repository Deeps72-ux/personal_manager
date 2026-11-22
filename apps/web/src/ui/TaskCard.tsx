import type { CSSProperties, ReactNode } from "react";
import type { Task } from "@pm/shared";
import { formatDayLong } from "../core/views.ts";
import { cardLook } from "./colors.ts";

export { cardLook } from "./colors.ts";

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
