// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayLocal } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { chipText } from "../src/core/views.ts";
import { ServicesProvider, type Services } from "../src/ui/services.tsx";
import { formatElapsed } from "../src/ui/timer-store.ts";
import { TimerView } from "../src/ui/TimerView.tsx";

const T0 = new Date("2026-11-07T10:00:00Z").getTime();
const DAY0 = todayLocal(new Date(T0));
const display = () => {
  const el = document.querySelector<HTMLElement>(".timer-display");
  return el && !el.hidden ? el : null;
};
const button = () => screen.getByRole("button", { name: "Timer" });
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const queryButton = () => screen.queryByRole("button", { name: "Timer" });
const bar = () => screen.queryByRole("textbox", { name: "What did you do?" });
const ok = () => screen.getByRole("button", { name: "Log it" });
const cancel = () => screen.getByRole("button", { name: "Cancel" });
const enter = () => fireEvent.pointerEnter(button());

/** Renders the timer; `startedAt` seeds the start kept in the local store. */
async function renderTimer(startedAt?: number) {
  const store = new MemoryStore();
  const sync = { requestSync: () => undefined };
  const logs = new LogActions({ store, sync });
  const tasks = new TaskActions({ store, sync });
  const timer = new TimerActions({ store, sync });
  if (startedAt !== undefined) await timer.restart(startedAt);
  render(
    <ServicesProvider value={{ store, logs, timer } as unknown as Services}>
      <TimerView />
    </ServicesProvider>,
  );
  await act(async () => undefined); // let the start load
  return { store, tasks, timer };
}
const card = (title: string) => screen.getByRole("button", { name: title });
const barText = () => (bar() as HTMLInputElement).value;
async function logIt(text: string) {
  fireEvent.change(bar()!, { target: { value: text } });
  await act(async () => void fireEvent.click(ok()));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("formatElapsed", () => {
  it("pads to HH:MM:SS and lets hours run past 24", async () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(3_723_000)).toBe("01:02:03");
    expect(formatElapsed(27 * 3_600_000 + 5_000)).toBe("27:00:05");
    expect(formatElapsed(-5)).toBe("00:00:00");
  });
});

describe("TimerView", () => {
  it("is just an unlabelled button: no text on screen until hover/touch", async () => {
    await renderTimer();
    expect(button().textContent).toBe("");
    expect(display()).toBeNull();
    expect(bar()).toBeNull();
  });

  it("hover replaces the button with a fixed time, a text bar and ✓ / ✕ under it", async () => {
    await renderTimer(T0 - 65_000);
    enter();
    expect(queryButton()).toBeNull();
    expect(display()?.textContent).toBe("00:01:05");
    expect(bar()).toBe(document.activeElement);
    expect(bar()!.compareDocumentPosition(ok()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // under the bar
    expect((ok() as HTMLButtonElement).disabled).toBe(true); // nothing typed yet
    wait(5_000);
    expect(display()?.textContent).toBe("00:01:05"); // does not tick
  });

  it("carries over a start kept in localStorage by the older version, then removes it", async () => {
    localStorage.setItem("pm.timer.startedAt", String(T0 - 90_000));
    const { store } = await renderTimer();
    expect(await store.timerStart()).toBe(T0 - 90_000);
    expect(localStorage.getItem("pm.timer.startedAt")).toBeNull();
    enter();
    expect(display()?.textContent).toBe("00:01:30");
  });

  it("touch opens it too", async () => {
    await renderTimer();
    fireEvent.pointerDown(button());
    expect(bar()).not.toBeNull();
  });

  it("✕ (without typing) hides everything, brings the button back and restarts the count", async () => {
    const { store } = await renderTimer();
    enter();
    wait(4_000);
    await act(async () => void fireEvent.click(cancel()));
    expect(bar()).toBeNull();
    expect(display()).toBeNull();
    expect(queryButton()).not.toBeNull();
    expect(await store.timerStart()).toBe(T0 + 4_000);
    expect(await store.listLogsForDay(DAY0)).toEqual([]);

    wait(90_000);
    enter();
    expect(display()?.textContent).toBe("00:01:30");
  });

  it("ignores a ghost tap on ✕ right after the opening touch", async () => {
    await renderTimer();
    fireEvent.pointerDown(button());
    fireEvent.click(cancel());
    expect(bar()).not.toBeNull();
  });

  it("Escape works like ✕", async () => {
    await renderTimer();
    enter();
    fireEvent.keyDown(bar()!, { key: "Escape" });
    expect(bar()).toBeNull();
    expect(queryButton()).not.toBeNull();
  });

  it("✓ logs the time until now under the typed text, then restarts the count", async () => {
    const { store } = await renderTimer(T0 - 600_000);
    enter();
    wait(20_000); // typing takes time; it is counted
    await logIt("Reading");
    expect(await store.listLogsForDay(DAY0)).toMatchObject([{ seconds: 620, taskTitle: "Reading" }]);
    expect(bar()).toBeNull();
    expect(queryButton()).not.toBeNull();
    expect(await store.timerStart()).toBe(T0 + 20_000);
  });

  it("✓ splits a span that crosses midnight between the two days", async () => {
    const start = new Date(2026, 10, 5, 23, 0).getTime(); // local 23:00
    vi.setSystemTime(new Date(2026, 10, 6, 1, 30)); // local 01:30 next day
    const { store } = await renderTimer(start);
    enter();
    expect(display()?.textContent).toBe("02:30:00");
    await logIt("Night work");
    expect(await store.listLogsForDay("2026-11-05")).toMatchObject([{ seconds: 3600, taskTitle: "Night work" }]);
    expect(await store.listLogsForDay("2026-11-06")).toMatchObject([{ seconds: 5400, taskTitle: "Night work" }]);
  });

  it("a refused log keeps the bar and the text, and shows why", async () => {
    await renderTimer();
    enter(); // first ever use: 0 s to log
    await logIt("Too quick");
    expect(screen.getByRole("alert").textContent).toMatch(/second/);
    expect((bar() as HTMLInputElement).value).toBe("Too quick");
  });

  it("a save that throws re-enables ✓, keeps the text and shows an error", async () => {
    const { timer } = await renderTimer(T0 - 60_000);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(timer, "logAndRestart").mockRejectedValueOnce(new Error("PrematureCommitError"));
    enter();
    await logIt("Maintenance");
    expect(screen.getByRole("alert").textContent).toMatch(/Could not save/);
    expect(barText()).toBe("Maintenance");
    expect((ok() as HTMLButtonElement).disabled).toBe(false);
    await logIt("Maintenance"); // retry works
    expect(bar()).toBeNull();
    spy.mockRestore();
  });

  it("keyboard: Space opens it; Enter in the bar logs", async () => {
    const { store } = await renderTimer(T0 - 3_000);
    fireEvent.keyDown(button(), { key: " " });
    fireEvent.change(bar()!, { target: { value: "Typing" } });
    await act(async () => void fireEvent.submit((bar() as HTMLInputElement).form!));
    expect(await store.listLogsForDay(DAY0)).toMatchObject([{ seconds: 3, taskTitle: "Typing" }]);
  });
});

describe("chipText", () => {
  it("is exactly the title and its closing ';'", () => {
    expect(chipText(" Gym ")).toBe("Gym;");
  });
});

describe("TimerView task cards", () => {
  async function openWithTasks(startedAt: number | undefined, ...titles: string[]) {
    const app = await renderTimer(startedAt);
    for (const t of [...titles].reverse()) await act(() => app.tasks.create({ title: t, description: "d" }));
    enter();
    await act(async () => undefined); // let the live task list load
    wait(400); // past the ghost-tap guard
    return app;
  }

  it("lists every task, title only, in priority order, below ✓ / ✕", async () => {
    await openWithTasks(undefined, "Gym", "Read", "Write");
    const items = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["Gym", "Read", "Write"]);
    expect(cancel().compareDocumentPosition(items[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("d")).toBeNull(); // no description
  });

  it("tapping a card makes the bar exactly `title;` (one activity per log)", async () => {
    await openWithTasks(undefined, "Gym", "Read");
    fireEvent.change(bar()!, { target: { value: "something" } });
    fireEvent.click(card("Gym"));
    expect(barText()).toBe("Gym;");
    expect((bar() as HTMLInputElement).selectionStart).toBe(4);
    fireEvent.click(card("Read"));
    expect(barText()).toBe("Read;");
  });

  it("typing after the ';' is blocked with a message; the text stays as it was", async () => {
    await openWithTasks(undefined, "Gym");
    fireEvent.change(bar()!, { target: { value: "Reading;" } });
    fireEvent.change(bar()!, { target: { value: "Reading;G" } });
    expect(barText()).toBe("Reading;");
    expect(screen.getByRole("alert").textContent).toMatch(/One activity per log/);
    fireEvent.change(bar()!, { target: { value: "Reading; " } }); // spaces are fine
    expect(barText()).toBe("Reading; ");
  });

  it("logs one activity, the ';' added if left out", async () => {
    const { store } = await openWithTasks(T0 - 60_000, "Gym", "Read");
    fireEvent.change(bar()!, { target: { value: "Gym" } });
    await act(async () => void fireEvent.click(ok()));
    const all = await store.listLogsForDay(DAY0);
    expect(all.map((l) => [l.taskTitle, l.source, l.startMs])).toEqual([["Gym", "timer", T0 - 60_000]]);
  });

  it("lists the priority list, then the waiting queue (offered, never scored)", async () => {
    const app = await renderTimer();
    for (const t of ["C", "B", "A"]) await act(() => app.tasks.create({ title: t }));
    const { PriorityActions } = await import("../src/core/actions.ts");
    const priority = new PriorityActions({ store: app.store, sync: { requestSync: () => undefined } });
    const c = (await app.store.listTasks()).find((t) => t.title === "C")!;
    await act(() => priority.enqueue(c.id));
    enter();
    await act(async () => undefined);
    const items = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["A", "B", "C"]);
  });
});

describe("TimerView split bar", () => {
  it("✂ cuts the time in two; each piece gets its own activity (or none) and ✓ logs them all", async () => {
    const app = await renderTimer(T0 - 2 * 3_600_000);
    enter();
    await wait(400); // past the ghost-tap guard
    fireEvent.click(screen.getByRole("button", { name: "Split the time" }));
    const rows = () => [...document.querySelectorAll(".split-row")].map((r) => r.querySelector(".split-row-label")!.textContent);
    expect(rows()).toEqual(["unlogged", "unlogged"]);
    const piece = () => screen.getByRole("textbox", { name: "What did you do in this piece?" });
    fireEvent.change(piece(), { target: { value: "Lunch" } }); // the new (second) piece is picked
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>(".split-row")[0]!);
    fireEvent.change(piece(), { target: { value: "Reading;" } });
    expect(rows()).toEqual(["Reading;", "Lunch"]);

    // A third piece left unlogged: cut the last one again, leave it empty.
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>(".split-row")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Split this piece" }));
    expect(rows()).toEqual(["Reading;", "Lunch", "unlogged"]);

    await act(async () => void fireEvent.click(ok()));
    const logs = (await app.store.listLogsForDay(DAY0)).sort((a, b) => a.startMs! - b.startMs!);
    expect(logs.map((l) => [l.taskTitle, l.startMs, l.seconds])).toEqual([
      ["Reading", T0 - 2 * 3_600_000, 3600],
      ["Lunch", T0 - 3_600_000, 1800],
    ]);
    expect(await app.store.timerStart()).toBe(T0 + 400);
    expect(queryButton()).not.toBeNull(); // back to the button
  });

  it("dividers move with the arrow keys, one minute at a time (Shift: 15), never under a minute", async () => {
    await renderTimer(T0 - 10 * 60_000);
    enter();
    await wait(400);
    fireEvent.click(screen.getByRole("button", { name: "Split the time" }));
    const handle = () => screen.getByRole("button", { name: /^Divider at/ });
    const lens = () => [...document.querySelectorAll(".split-row-len")].map((r) => r.textContent);
    expect(lens()).toEqual(["5m", "5m"]);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(lens()).toEqual(["6m", "4m"]);
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(lens()).toEqual(["9m", "1m"]); // stops 1 minute before the end
    fireEvent.keyDown(handle(), { key: "Delete" });
    expect(lens()).toEqual(["10m"]);
  });
});
