import { describe, expect, it } from "vitest";
import readXlsxFile from "read-excel-file/node";
import { uuidv7 } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { XlsxLogWriter } from "../src/adapters/xlsx.ts";
import { ExportLogs } from "../src/core/export-logs.ts";
import { ValidationError } from "../src/core/errors.ts";

describe("Excel export", () => {
  it("exports only the date range, sorted, and the file reads back correctly", async () => {
    const store = new MemoryStore();
    await store.write(async (tx) => {
      for (const [day, seconds, title] of [
        ["2026-10-31", 5, "before range"],
        ["2026-11-02", 27, "Task7"],
        ["2026-11-01", 28_800, "Sleep"],
        ["2026-11-30", 60, "last day"],
        ["2026-12-01", 5, "after range"],
      ] as const) {
        await tx.putLog({ id: uuidv7(), day, seconds, taskTitle: title });
      }
    });
    let saved: { blob: Blob; name: string } | null = null;
    const exporter = new ExportLogs({
      store,
      writer: new XlsxLogWriter(),
      saver: { save: (blob, name) => void (saved = { blob, name }) },
    });

    const r = await exporter.execute("2026-11-01", "2026-11-30");
    expect(r).toEqual({ fileName: "log_2026-11-01_to_2026-11-30.xlsx", rows: 3 });
    const file = saved as unknown as { blob: Blob; name: string };
    const sheets = (await readXlsxFile(Buffer.from(await file.blob.arrayBuffer()))) as unknown as {
      sheet: string;
      data: unknown[][];
    }[];
    expect(sheets.map((s) => s.sheet)).toEqual(["Log"]);
    expect(sheets[0]!.data).toEqual([
      ["Day", "Task", "Seconds", "Duration"],
      ["2026-11-01", "Sleep", 28800, "8h"],
      ["2026-11-02", "Task7", 27, "27s"],
      ["2026-11-30", "last day", 60, "1m"],
    ]);
  });

  it("validates the range", async () => {
    const exporter = new ExportLogs({
      store: new MemoryStore(),
      writer: new XlsxLogWriter(),
      saver: { save: () => undefined },
    });
    await expect(exporter.execute("2026-11-30", "2026-11-01")).rejects.toThrow(ValidationError);
    await expect(exporter.execute("", "2026-11-01")).rejects.toThrow(ValidationError);
  });
});
