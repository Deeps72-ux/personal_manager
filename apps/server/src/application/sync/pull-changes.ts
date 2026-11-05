import type { PullResponse } from "@pm/shared";
import type { ChangeLogEntry, Repositories, SyncedTable } from "../../ports/repositories.ts";
import type { UnitOfWork } from "../../ports/unit-of-work.ts";

/**
 * "What changed after my cursor?"
 *
 * snapshot when:
 *   - cursor = 0                (first sync on this device)
 *   - cursor < floor            (offline so long that history was cleaned up)
 *   - cursor > currentSeq       (server DB was restored from an older backup)
 * otherwise incremental, paged by `pageSize` change_log rows.
 */
export class PullChanges {
  private readonly deps: { uow: UnitOfWork; pageSize: number };

  constructor(deps: { uow: UnitOfWork; pageSize: number }) {
    this.deps = deps;
  }

  async execute(userId: string, cursor: number): Promise<PullResponse> {
    return this.deps.uow.run(async (repos) => {
      const [current, floor, user] = [
        await repos.changeLog.currentSeq(),
        await repos.changeLog.floor(),
        await repos.users.findById(userId),
      ];
      const purgedBefore = user?.purgedBefore ?? null;

      if (cursor === 0 || cursor < floor || cursor > current) {
        return {
          mode: "snapshot",
          cursor: current,
          hasMore: false,
          purgedBefore,
          upserts: {
            tasks: await repos.tasks.listAll(userId),
            placements: await repos.placements.listAll(userId),
            logEntries: await repos.logs.listAll(userId),
          },
          deletes: { tasks: [], placements: [], logEntries: [] },
        };
      }

      const rows = await repos.changeLog.listAfter(userId, cursor, this.deps.pageSize + 1);
      const hasMore = rows.length > this.deps.pageSize;
      const page = hasMore ? rows.slice(0, this.deps.pageSize) : rows;
      // When this is the last page we can jump straight to the global seq;
      // the transaction guarantees nothing for this user lies in between.
      const nextCursor = hasMore ? page.at(-1)!.seq : Math.max(cursor, current);

      return { mode: "incremental", cursor: nextCursor, hasMore, purgedBefore, ...(await materialize(repos, userId, page)) };
    });
  }
}

/** Collapse a page to the LAST op per row, then load current rows for upserts. */
async function materialize(repos: Repositories, userId: string, page: readonly ChangeLogEntry[]) {
  const last = new Map<string, ChangeLogEntry>();
  for (const e of page) last.set(`${e.table}:${e.rowId}`, e);

  const ids = (table: SyncedTable, op: "upsert" | "delete") =>
    [...last.values()].filter((e) => e.table === table && e.op === op).map((e) => e.rowId);

  // An upserted row may be missing if it was deleted after this page; its
  // delete arrives on the next page, so skipping it here is correct.
  return {
    upserts: {
      tasks: await repos.tasks.getMany(userId, ids("tasks", "upsert")),
      placements: await repos.placements.getMany(userId, ids("placements", "upsert")),
      logEntries: await repos.logs.getMany(userId, ids("log_entries", "upsert")),
    },
    deletes: {
      tasks: ids("tasks", "delete"),
      placements: ids("placements", "delete"),
      logEntries: ids("log_entries", "delete"),
    },
  };
}
