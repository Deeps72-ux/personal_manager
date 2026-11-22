import { isValidDay, type Day, type LogEntry } from "@pm/shared";
import { ValidationError } from "./errors.ts";
import { logSlices } from "./insights.ts";
import type { FileSaver, LocalStore, SpreadsheetWriter } from "./ports.ts";

/**
 * Export LOG entries in [from, to] to an Excel file. Works offline. A log
 * that ran under more than one confirmed priority order is written as one
 * row per slice, each with its own deviation.
 */
export class ExportLogs {
  private readonly deps: { store: LocalStore; writer: SpreadsheetWriter; saver: FileSaver };
  constructor(deps: { store: LocalStore; writer: SpreadsheetWriter; saver: FileSaver }) {
    this.deps = deps;
  }

  async execute(from: Day, to: Day): Promise<{ fileName: string; rows: number }> {
    if (!isValidDay(from) || !isValidDay(to)) throw new ValidationError("Pick both dates");
    if (from > to) throw new ValidationError("'From' must be on or before 'To'");
    const entries = await this.deps.store.listLogsBetween(from, to);
    const history = await this.deps.store.listHistory();
    const deviation = new Map<LogEntry, number | null>();
    const rows = entries.flatMap((e): LogEntry[] => {
      const slices = logSlices(e, history);
      if (slices.length === 0) {
        deviation.set(e, e.deviation ?? null);
        return [e];
      }
      return slices.map((s) => {
        const row = { ...e, startMs: s.start, seconds: Math.round((s.end - s.start) / 1000) };
        deviation.set(row, s.deviation);
        return row;
      });
    });
    const blob = await this.deps.writer.writeLog(rows, (e) => deviation.get(e) ?? null);
    const fileName = `log_${from}_to_${to}.xlsx`;
    this.deps.saver.save(blob, fileName);
    return { fileName, rows: rows.length };
  }
}
