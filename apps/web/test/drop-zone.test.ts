/** Where a drag lands in the TASKS tab: recent area, folders block, tasks block, or into a folder. */
import { describe, expect, it } from "vitest";
import type { Folder, Task } from "@pm/shared";
import { buildFolderTree } from "../src/core/folders.ts";
import { dropZone } from "../src/ui/TasksView.tsx";

const folder = (id: string, rank: string, top = false): Folder => ({ id, name: id, parentId: null, rank, top });
const task = (id: string, rank: string, top = false): Task => ({
  id,
  title: id,
  description: null,
  dueDate: null,
  folderId: null,
  folderRank: rank,
  folderTop: top,
});

// recentT, recentF | F1, F2 | T1, T2
const tree = buildFolderTree(
  [folder("recentF", "a1", true), folder("F1", "a0"), folder("F2", "a1")],
  [task("recentT", "a0", true), task("T1", "a0"), task("T2", "a1")],
);
const asTask = (id: string) => ({ kind: "task" as const, id });
const asFolder = (id: string) => ({ kind: "folder" as const, id });

describe("dropZone", () => {
  it("next to a recent row, any item can go before or after it", () => {
    expect(dropZone(tree, null, asTask("T1"), "folder:recentF", 0.9)).toEqual({ target: "folder:recentF", zone: "after" });
    expect(dropZone(tree, null, asFolder("F2"), "task:recentT", 0.2)).toEqual({ target: "task:recentT", zone: "before" });
  });

  it("a task over an older folder goes into it; over a task, before or after", () => {
    expect(dropZone(tree, null, asTask("T2"), "folder:F2", 0.1)).toEqual({ target: "folder:F2", zone: "into" });
    expect(dropZone(tree, null, asTask("T2"), "task:T1", 0.2)).toEqual({ target: "task:T1", zone: "before" });
  });

  it("a folder over an older task has nowhere to land; over a folder: edges reorder, middle goes in", () => {
    expect(dropZone(tree, null, asFolder("F1"), "task:T1", 0.5)).toBeNull();
    expect(dropZone(tree, null, asFolder("F1"), "folder:F2", 0.9)).toEqual({ target: "folder:F2", zone: "after" });
    expect(dropZone(tree, null, asFolder("F1"), "folder:F2", 0.5)).toEqual({ target: "folder:F2", zone: "into" });
  });

  it("above the very first row, a task can go above the folders", () => {
    const plain = buildFolderTree([folder("F1", "a0")], [task("T1", "a0")]);
    expect(dropZone(plain, null, asTask("T1"), "folder:F1", 0.1)).toEqual({ target: "folder:F1", zone: "before" });
    expect(dropZone(plain, null, asTask("T1"), "folder:F1", 0.9)).toEqual({ target: "folder:F1", zone: "into" });
  });
});
