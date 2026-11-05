import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Row shape returned by node:sqlite. */
export type Row = Record<string, unknown>;

/** `SELECT ... WHERE x IN (?, ?, ...)` in chunks, to stay under SQLite's variable limit. */
export function selectIn(
  db: DatabaseSync,
  sqlWithIn: (placeholders: string) => string,
  fixedParams: readonly SQLInputValue[],
  values: readonly string[],
): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    const sql = sqlWithIn(chunk.map(() => "?").join(", "));
    out.push(...(db.prepare(sql).all(...fixedParams, ...chunk) as Row[]));
  }
  return out;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}
