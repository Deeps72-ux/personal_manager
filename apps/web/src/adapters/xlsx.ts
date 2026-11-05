import { formatSeconds, type LogEntry } from "@pm/shared";
import type { FileSaver, SpreadsheetWriter } from "../core/ports.ts";

const HEADER = { fontWeight: "bold" as const, backgroundColor: "#E8EAF6" };

/** One sheet "Log": Day | Task | Seconds | Duration. */
export class XlsxLogWriter implements SpreadsheetWriter {
  async writeLog(entries: readonly LogEntry[]): Promise<Blob> {
    // Loaded on first export only: keeps the app's startup bundle small.
    const { default: writeExcelFile } = await import("write-excel-file/universal");
    const rows = [
      [
        { value: "Day", ...HEADER },
        { value: "Task", ...HEADER },
        { value: "Seconds", ...HEADER },
        { value: "Duration", ...HEADER },
      ],
      ...entries.map((e) => [
        { value: e.day, type: String },
        { value: e.taskTitle, type: String },
        { value: e.seconds, type: Number, format: "#,##0" },
        { value: formatSeconds(e.seconds), type: String },
      ]),
    ];
    return writeExcelFile(rows, {
      sheet: "Log",
      columns: [{ width: 12 }, { width: 40 }, { width: 12 }, { width: 14 }],
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
