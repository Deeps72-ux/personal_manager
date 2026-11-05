/**
 * Composition root: the ONLY place that knows concrete adapters.
 *
 * It will create the adapters (SQLite repositories, Argon2 hasher, Hono HTTP),
 * inject them into the use cases through their ports, and start listening.
 * Filled in during Phase B (steps 2–6). For now it proves the server package
 * can import the shared package under plain `node` (native TypeScript).
 */
import { DAY_SECONDS } from "@pm/shared";

console.log(`server skeleton OK (a day has ${DAY_SECONDS} seconds)`);
