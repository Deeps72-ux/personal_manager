import type { Change, ChangeResult, PushResponse } from "@pm/shared";
import type { UnitOfWork } from "../../ports/unit-of-work.ts";
import type { ChangeNotifier, Clock } from "../../ports/services.ts";
import type { ChangeHandler, ChangeHandlers } from "./change-handlers.ts";

/**
 * Applies a device's outbox, in order, in ONE transaction.
 * Order matters: "create task, then rename it" in the same push must work.
 */
export class PushChanges {
  private readonly deps: { uow: UnitOfWork; clock: Clock; notifier: ChangeNotifier; handlers: ChangeHandlers };

  constructor(deps: { uow: UnitOfWork; clock: Clock; notifier: ChangeNotifier; handlers: ChangeHandlers }) {
    this.deps = deps;
  }

  async execute(userId: string, changes: readonly Change[]): Promise<PushResponse> {
    const ctx = { userId, nowMs: this.deps.clock.nowMs() };

    const { results, cursor } = await this.deps.uow.run(async (repos) => {
      const results: ChangeResult[] = [];
      for (const change of changes) {
        // The map is keyed by op, so this lookup is type-safe per change kind.
        const handler = this.deps.handlers[change.op] as ChangeHandler<Change>;
        const r = await handler(repos, ctx, change);
        results.push({ changeId: change.changeId, ...r });
      }
      return { results, cursor: await repos.changeLog.currentSeq() };
    });

    // Notify only after COMMIT, so a poked device never pulls half a push.
    if (results.some((r) => r.status === "applied")) this.deps.notifier.notify(userId, cursor);
    return { results };
  }
}
