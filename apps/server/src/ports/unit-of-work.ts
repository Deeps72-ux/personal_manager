import type { Repositories } from "./repositories.ts";

/**
 * Runs `work` atomically: all writes commit together or none do.
 * Implementations must also serialize units of work, so two requests never
 * interleave inside one transaction.
 */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
