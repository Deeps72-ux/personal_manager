// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayLocal } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { insertTitle } from "../src/core/views.ts";
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

  it("keyboard: Space opens it; Enter in the bar logs", async () => {
    const { store } = await renderTimer(T0 - 3_000);
    fireEvent.keyDown(button(), { key: " " });
    fireEvent.change(bar()!, { target: { value: "Typing" } });
    await act(async () => void fireEvent.submit((bar() as HTMLInputElement).form!));
    expect(await store.listLogsForDay(DAY0)).toMatchObject([{ seconds: 3, taskTitle: "Typing" }]);
  });
});

describe("insertTitle", () => {
  it("puts title; at the cursor and moves the cursor after the ;", async () => {
    expect(insertTitle("", 0, "Gym", 200)).toEqual({ ok: true, text: "Gym;", cursor: 4 });
    expect(insertTitle("Gym;", 4, "Read", 200)).toEqual({ ok: true, text: "Gym;Read;", cursor: 9 });
    expect(insertTitle("ab", 1, "X", 200)).toEqual({ ok: true, text: "aX;b", cursor: 3 });
    expect(insertTitle("ab", 99, "X", 200)).toMatchObject({ text: "abX;" });
  });

  it("does nothing if that title is already in the bar", async () => {
    expect(insertTitle("Gym;Read;", 0, "Read", 200)).toEqual({ ok: false, reason: "present" });
    expect(insertTitle("notes Gym; more", 0, "Gym", 200)).toEqual({ ok: false, reason: "present" });
    // a longer title that merely ends the same way does not count
    expect(insertTitle("Big Gym;", 8, "Gym", 200)).toEqual({ ok: false, reason: "present" }); // after a space: whole entry
    expect(insertTitle("BigGym;", 7, "Gym", 200)).toMatchObject({ ok: true, text: "BigGym;Gym;" });
  });

  it("refuses when the result would be over the limit", async () => {
    expect(insertTitle("x".repeat(196), 196, "Gym", 200)).toMatchObject({ ok: true });
    expect(insertTitle("x".repeat(197), 197, "Gym", 200)).toEqual({ ok: false, reason: "too-long" });
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

  it("tapping cards types title; at the cursor; tapping again does nothing", async () => {
    await openWithTasks(undefined, "Gym", "Read");
    fireEvent.click(card("Gym"));
    fireEvent.click(card("Read"));
    expect(barText()).toBe("Gym;Read;");
    expect((bar() as HTMLInputElement).selectionStart).toBe(9);
    fireEvent.click(card("Gym"));
    expect(barText()).toBe("Gym;Read;");
  });

  it("the user can type and edit around inserted titles", async () => {
    await openWithTasks(undefined, "Gym");
    fireEvent.change(bar()!, { target: { value: "morning " } });
    (bar() as HTMLInputElement).setSelectionRange(0, 0);
    fireEvent.click(card("Gym"));
    expect(barText()).toBe("Gym;morning ");
    fireEvent.change(bar()!, { target: { value: "morning " } }); // backspaced it out (cursor at end)
    fireEvent.click(card("Gym")); // so it can be added again
    expect(barText()).toBe("morning Gym;");
  });

  it("a tap that would go over 200 characters is refused with a message", async () => {
    await openWithTasks(undefined, "Gym");
    fireEvent.change(bar()!, { target: { value: "x".repeat(198) } });
    fireEvent.click(card("Gym"));
    expect(barText()).toBe("x".repeat(198));
    expect(screen.getByRole("alert").textContent).toMatch(/200/);
  });

  it("logs the whole bar as one entry", async () => {
    const { store } = await openWithTasks(T0 - 60_000, "Gym", "Read");
    fireEvent.click(card("Gym"));
    fireEvent.click(card("Read"));
    await act(async () => void fireEvent.click(ok()));
    const all = await store.listLogsForDay(DAY0);
    expect(all.map((l) => l.taskTitle)).toEqual(["Gym;Read;"]);
  });
});
