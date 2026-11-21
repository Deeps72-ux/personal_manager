import { formatSeconds, type LogEntry } from "@pm/shared";
import type { FileSaver, SpreadsheetWriter } from "../core/ports.ts";

const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : { value: v / 100, type: Number, format: "0.0%" });
const p2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const timeCell = (t: number | null) => (t === null ? null : { value: clock(t), type: String });

const HEADER = { fontWeight: "bold" as const, backgroundColor: "#E8EAF6" };

/**
 * One sheet "Log": Day | Start | End | Task | Seconds | Duration | Deviation.
 * Start / End are blank for older logs with no time, Deviation when not scored.
 * (FOCUS is per clock hour now, not per log: see INSIGHTS.)
 */
export class XlsxLogWriter implements SpreadsheetWriter {
  async writeLog(entries: readonly LogEntry[], deviation: (e: LogEntry) => number | null): Promise<Blob> {
    // Loaded on first export only: keeps the app's startup bundle small.
    const { default: writeExcelFile } = await import("write-excel-file/universal");
    const rows = [
      [
        { value: "Day", ...HEADER },
        { value: "Start", ...HEADER },
        { value: "End", ...HEADER },
        { value: "Task", ...HEADER },
        { value: "Seconds", ...HEADER },
        { value: "Duration", ...HEADER },
        { value: "Deviation", ...HEADER },
      ],
      ...entries.map((e) => {
        const start = e.startMs ?? null;
        return [
          { value: e.day, type: String },
          timeCell(start),
          timeCell(start === null ? null : start + e.seconds * 1000),
          { value: e.taskTitle, type: String },
          { value: e.seconds, type: Number, format: "#,##0" },
          { value: formatSeconds(e.seconds), type: String },
          pct(deviation(e)),
        ];
      }),
    ];
    return writeExcelFile(rows, {
      sheet: "Log",
      columns: [{ width: 12 }, { width: 10 }, { width: 10 }, { width: 40 }, { width: 12 }, { width: 14 }, { width: 10 }],
      stickyRowsCount: 1,
    }).toBlob();
  }
}

/** Triggers a normal browser download. */
export class BrowserFileSaver implements FileSaver {
  save(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
