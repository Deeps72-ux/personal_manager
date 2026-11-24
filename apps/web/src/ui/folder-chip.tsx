/**
 * The folder name on task cards outside the TASKS tab: the folder the task is
 * directly in (for nested folders, the last one), nothing at the top level.
 * A label only: it changes nothing about how the task behaves.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { Task } from "@pm/shared";
import { FolderIcon } from "./icons.tsx";
import { useLive } from "./services.tsx";

const Names = createContext<ReadonlyMap<string, string> | null>(null);

/** Loads the folder names once for every card below it. */
export function FolderNamesProvider({ children }: { children: ReactNode }) {
  const names = useLive(async (s) => new Map((await s.store.listFolders()).map((f) => [f.id, f.name])), []);
  return <Names.Provider value={names ?? null}>{children}</Names.Provider>;
}

/** Name of the folder `task` is in, or null (top level, or its folder is gone). */
export function useFolderName(): (task: Task) => string | null {
  const names = useContext(Names);
  return (task) => (task.folderId && names?.get(task.folderId)) || null;
}

export function FolderChip({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <span className="folder-chip" title={name}>
      <FolderIcon />
      <span className="folder-chip-name">{name}</span>
    </span>
  );
}
