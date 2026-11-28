// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayLocal } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { chipText } from "../src/core/views.ts";
import { ServicesProvider, type Services } from "../src/ui/services.tsx";
import { formatElapsed } from "../src/ui/timer-store.ts";
import { clampView, DOUBLE_TAP_MS, MIN_VIEW_MS, tickTimes } from "../src/ui/SplitBar.tsx";
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
    fireEvent.change(bar()!, { target: { value: "" } });
    fireEvent.click(card("Gym"));
    expect(barText()).toBe("Gym;");
    expect((bar() as HTMLInputElement).selectionStart).toBe(4);
    fireEvent.change(bar()!, { target: { value: "" } });
    fireEvent.click(card("Read"));
    expect(barText()).toBe("Read;");
  });

  it("typing narrows the cards to the matching tasks, best match first", async () => {
    await openWithTasks(undefined, "Gym", "Read a book", "Spread sheet", "Write");
    fireEvent.change(bar()!, { target: { value: "rea" } });
    const items = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["Read a book", "Spread sheet"]);
    fireEvent.change(bar()!, { target: { value: "zzz" } });
    expect(screen.queryByRole("list", { name: "Tasks" })).toBeNull();
    expect(screen.getByText(/No matching tasks/)).toBeTruthy();
    fireEvent.change(bar()!, { target: { value: "" } });
    expect(within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("button")).toHaveLength(4);
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
  /** The bar is `px` wide on screen (jsdom has no layout). */
  const layout = (px: number) =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: px,
      bottom: 50,
      width: px,
      height: 50,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  const viewport = () => document.querySelector<HTMLElement>(".splitbar-viewport")!;
  const tapAt = (x: number) => {
    fireEvent.pointerDown(viewport(), { pointerId: 1, clientX: x, button: 0, pointerType: "touch" });
    fireEvent.pointerUp(viewport(), { pointerId: 1, clientX: x, button: 0, pointerType: "touch" });
  };
  const doubleTapAt = async (x: number) => {
    tapAt(x);
    await wait(80);
    tapAt(x);
  };
  /** Each piece as "length label", from its accessible name. */
  const pieces = () =>
    [...document.querySelectorAll<HTMLElement>(".split-piece")].map((b) =>
      b.getAttribute("aria-label")!.replace(/^\S+ to \S+, (.*?): (.*)$/, "$1 $2"),
    );
  const pieceInput = () => screen.getByRole("textbox", { name: /^What did you do/ });
  afterEach(() => vi.restoreAllMocks());

  it("opens as one piece typed into straight away; double-tap cuts, tap picks, ✓ logs every labeled piece", async () => {
    const app = await renderTimer(T0 - 2 * 3_600_000);
    enter();
    await wait(400); // past the ghost-tap guard
    layout(1200); // 2 hours: 100 px per 10 minutes
    expect(pieces()).toEqual(["2h unlogged"]);
    expect(bar()).not.toBeNull(); // the whole time, picked: type right away

    await doubleTapAt(600); // 11:00 UTC−… : one hour in
    await doubleTapAt(902); // snapped to the minute: 30 minutes later
    expect(pieces()).toEqual(["1h unlogged", "30m unlogged", "30m unlogged"]);
    expect(screen.queryByRole("textbox")).toBeNull(); // after a cut nothing is picked

    tapAt(700); // one tap: picks the piece after a moment
    expect(screen.queryByRole("textbox")).toBeNull();
    await wait(DOUBLE_TAP_MS + 10);
    fireEvent.change(pieceInput(), { target: { value: "Lunch" } });
    tapAt(100);
    await wait(DOUBLE_TAP_MS + 10);
    fireEvent.change(pieceInput(), { target: { value: "Reading;" } });
    expect(pieces()).toEqual(["1h Reading;", "30m Lunch", "30m unlogged"]);

    await act(async () => void fireEvent.click(ok()));
    const logs = (await app.store.listLogsForDay(DAY0)).sort((a, b) => a.startMs! - b.startMs!);
    expect(logs.map((l) => [l.taskTitle, l.startMs, l.seconds])).toEqual([
      ["Reading", T0 - 2 * 3_600_000, 3600],
      ["Lunch", T0 - 3_600_000, 1800],
    ]);
    expect(await app.store.timerStart()).toBe(Date.now());
    expect(queryButton()).not.toBeNull(); // back to the button
  });

  it("a divider drags (its time and both lengths float above it) and, onto a neighbour, merges into that piece", async () => {
    await renderTimer(T0 - 60 * 60_000);
    enter();
    await wait(400);
    layout(600); // 1 hour: 10 px per minute
    await doubleTapAt(300);
    fireEvent.click(document.querySelectorAll<HTMLElement>(".split-piece")[0]!); // keyboard-style pick
    fireEvent.change(pieceInput(), { target: { value: "Reading" } });
    fireEvent.click(document.querySelectorAll<HTMLElement>(".split-piece")[1]!);
    fireEvent.change(pieceInput(), { target: { value: "Lunch" } });

    const handle = () => screen.getByRole("button", { name: /^Divider at/ });
    await act(async () => void fireEvent.pointerDown(handle(), { pointerId: 2, clientX: 300, button: 0 }));
    await act(async () => void fireEvent.pointerMove(handle(), { pointerId: 2, clientX: 400 }));
    expect(pieces()).toEqual(["40m Reading", "20m Lunch"]);
    expect(document.querySelector(".split-drag-tip")!.textContent).toMatch(/← 40m · 20m →/);
    await act(async () => void fireEvent.pointerUp(handle(), { pointerId: 2, clientX: 400 }));
    expect(document.querySelector(".split-drag-tip")).toBeNull();

    // Onto the right edge: the two become one, with the label of the piece dragged into.
    await act(async () => void fireEvent.pointerDown(handle(), { pointerId: 3, clientX: 400, button: 0 }));
    await act(async () => void fireEvent.pointerMove(handle(), { pointerId: 3, clientX: 598 }));
    expect(document.querySelector(".split-drag-tip")!.textContent).toBe("Release to merge");
    await act(async () => void fireEvent.pointerUp(handle(), { pointerId: 3, clientX: 598 }));
    expect(pieces()).toEqual(["1h Lunch"]);
  });

  it("keyboard: / cuts a piece in two, arrows move a divider a minute (Shift: 15), Delete merges", async () => {
    await renderTimer(T0 - 10 * 60_000);
    enter();
    await wait(400);
    fireEvent.keyDown(document.querySelector(".split-piece")!, { key: "/" });
    expect(pieces()).toEqual(["5m unlogged", "5m unlogged"]);
    const handle = () => screen.getByRole("button", { name: /^Divider at/ });
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(pieces()).toEqual(["6m unlogged", "4m unlogged"]);
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(pieces()).toEqual(["9m unlogged", "1m unlogged"]); // stops 1 minute before the end
    fireEvent.keyDown(handle(), { key: "Delete" });
    expect(pieces()).toEqual(["10m unlogged"]);
  });

  it("a cut is nudged a minute away from an edge; under 2 minutes nothing can be cut", async () => {
    await renderTimer(T0 - 10 * 60_000);
    enter();
    await wait(400);
    layout(1000);
    await doubleTapAt(5); // 3 seconds in: nudged to 1 minute
    expect(pieces()[0]).toBe("1m unlogged");
    await doubleTapAt(50); // inside the 1-minute piece: too short to cut
    expect(pieces()).toHaveLength(2);
  });
});

describe("split bar zoom", () => {
  it("never shows less than 15 minutes, nor more than the span; ticks get finer as it zooms in", () => {
    const span = { start: 0, end: 86_400_000 };
    expect(clampView({ start: 1000, end: 2000 }, span)).toEqual({ start: 1000, end: 1000 + MIN_VIEW_MS });
    expect(clampView({ start: -5, end: 99_999_999 }, span)).toEqual(span);
    expect(clampView({ start: 0, end: 60_000 }, { start: 0, end: 120_000 })).toEqual({ start: 0, end: 120_000 });
    const d = new Date(2026, 10, 7).getTime();
    const day = tickTimes({ start: d, end: d + 86_400_000 }, 600);
    const quarter = tickTimes({ start: d, end: d + MIN_VIEW_MS }, 600);
    expect(day[1]! - day[0]!).toBe(3 * 3_600_000);
    expect(quarter[1]! - quarter[0]!).toBe(2 * 60_000);
    expect(tickTimes({ start: d, end: d + MIN_VIEW_MS }, 1200)[1]! - quarter[0]!).toBe(60_000);
  });
});
