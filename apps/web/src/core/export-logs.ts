import { isValidDay, type Day } from "@pm/shared";
import { ValidationError } from "./errors.ts";
import type { FileSaver, LocalStore, SpreadsheetWriter } from "./ports.ts";

/** Export LOG entries in [from, to] to an Excel file. Works offline. */
export class ExportLogs {
  private readonly deps: { store: LocalStore; writer: SpreadsheetWriter; saver: FileSaver };
  constructor(deps: { store: LocalStore; writer: SpreadsheetWriter; saver: FileSaver }) {
    this.deps = deps;
  }

  async execute(from: Day, to: Day): Promise<{ fileName: string; rows: number }> {
    if (!isValidDay(from) || !isValidDay(to)) throw new ValidationError("Pick both dates");
    if (from > to) throw new ValidationError("'From' must be on or before 'To'");
    const entries = await this.deps.store.listLogsBetween(from, to);
    const blob = await this.deps.writer.writeLog(entries);
    const fileName = `log_${from}_to_${to}.xlsx`;
    this.deps.saver.save(blob, fileName);
    return { fileName, rows: entries.length };
  }
}
