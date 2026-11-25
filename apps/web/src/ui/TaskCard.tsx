import type { CSSProperties, ReactNode } from "react";
import type { Task } from "@pm/shared";
import { formatDayLong } from "../core/views.ts";
import { FolderChip } from "./folder-chip.tsx";
import { cardLook } from "./colors.ts";

export { cardLook } from "./colors.ts";

export function TaskCard({
  task,
  index,
  rank,
  onRank,
  rankSet = false,
  actions,
  folder = null,
  style,
  className = "",
  tilt = true,
}: {
  task: Task;
  index?: number;
  /** The badge number (default: index + 1). */
  rank?: number;
  /** Makes the badge a button (edit the rank). */
  onRank?: () => void;
  /** The rank was typed or comes from a folder (not its plain position). */
  rankSet?: boolean;
  actions?: ReactNode;
  /** Name of the task's folder, shown under the title (null = none). */
  folder?: string | null;
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
      {index !== undefined &&
        (onRank ? (
          <button
            type="button"
            className={`rank rank-btn ${rankSet ? "rank-set" : ""}`}
            aria-label={`Rank ${rank ?? index + 1} of ${task.title}: change`}
            title="Change rank"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={onRank}
          >
            #{rank ?? index + 1}
          </button>
        ) : (
          <span className={`rank ${rankSet ? "rank-set" : ""}`}>#{rank ?? index + 1}</span>
        ))}
      <div className="taskcard-body">
        <h3>{task.title}</h3>
        <FolderChip name={folder} />
        {task.description && <p className="desc">{task.description}</p>}
        {task.dueDate && <span className="due">Due {formatDayLong(task.dueDate)}</span>}
      </div>
      {actions && <div className="taskcard-actions">{actions}</div>}
    </article>
  );
}
