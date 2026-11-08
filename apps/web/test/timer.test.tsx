// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayLocal } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions } from "../src/core/actions.ts";
import { ServicesProvider, type Services } from "../src/ui/services.tsx";
import { formatElapsed, readTimerStart } from "../src/ui/timer-store.ts";
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

function renderTimer() {
  const store = new MemoryStore();
  const logs = new LogActions({ store, sync: { requestSync: () => undefined } });
  render(
    <ServicesProvider value={{ store, logs } as unknown as Services}>
      <TimerView />
    </ServicesProvider>,
  );
  return { store };
}
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
  it("pads to HH:MM:SS and lets hours run past 24", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(3_723_000)).toBe("01:02:03");
    expect(formatElapsed(27 * 3_600_000 + 5_000)).toBe("27:00:05");
    expect(formatElapsed(-5)).toBe("00:00:00");
  });
});

describe("TimerView", () => {
  it("is just an unlabelled button: no text on screen until hover/touch", () => {
    renderTimer();
    expect(button().textContent).toBe("");
    expect(display()).toBeNull();
    expect(bar()).toBeNull();
  });

  it("hover replaces the button with a fixed time, a text bar and ✓ / ✕ under it", () => {
    localStorage.setItem("pm.timer.startedAt", String(T0 - 65_000));
    renderTimer();
    enter();
    expect(queryButton()).toBeNull();
    expect(display()?.textContent).toBe("00:01:05");
    expect(bar()).toBe(document.activeElement);
    expect(bar()!.compareDocumentPosition(ok()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // under the bar
    expect((ok() as HTMLButtonElement).disabled).toBe(true); // nothing typed yet
    wait(5_000);
    expect(display()?.textContent).toBe("00:01:05"); // does not tick
  });

  it("touch opens it too", () => {
    renderTimer();
    fireEvent.pointerDown(button());
    expect(bar()).not.toBeNull();
  });

  it("✕ (without typing) hides everything, brings the button back and restarts the count", async () => {
    const { store } = renderTimer();
    enter();
    wait(4_000);
    fireEvent.click(cancel());
    expect(bar()).toBeNull();
    expect(display()).toBeNull();
    expect(queryButton()).not.toBeNull();
    expect(readTimerStart()).toBe(T0 + 4_000);
    expect(await store.listLogsForDay(DAY0)).toEqual([]);

    wait(90_000);
    enter();
    expect(display()?.textContent).toBe("00:01:30");
  });

  it("ignores a ghost tap on ✕ right after the opening touch", () => {
    renderTimer();
    fireEvent.pointerDown(button());
    fireEvent.click(cancel());
    expect(bar()).not.toBeNull();
  });

  it("Escape works like ✕", () => {
    renderTimer();
    enter();
    fireEvent.keyDown(bar()!, { key: "Escape" });
    expect(bar()).toBeNull();
    expect(queryButton()).not.toBeNull();
  });

  it("✓ logs the time until now under the typed text, then restarts the count", async () => {
    localStorage.setItem("pm.timer.startedAt", String(T0 - 600_000));
    const { store } = renderTimer();
    enter();
    wait(20_000); // typing takes time; it is counted
    await logIt("Reading");
    expect(await store.listLogsForDay(DAY0)).toMatchObject([{ seconds: 620, taskTitle: "Reading" }]);
    expect(bar()).toBeNull();
    expect(queryButton()).not.toBeNull();
    expect(readTimerStart()).toBe(T0 + 20_000);
  });

  it("✓ splits a span that crosses midnight between the two days", async () => {
    const start = new Date(2026, 10, 5, 23, 0).getTime(); // local 23:00
    vi.setSystemTime(new Date(2026, 10, 6, 1, 30)); // local 01:30 next day
    localStorage.setItem("pm.timer.startedAt", String(start));
    const { store } = renderTimer();
    enter();
    expect(display()?.textContent).toBe("02:30:00");
    await logIt("Night work");
    expect(await store.listLogsForDay("2026-11-05")).toMatchObject([{ seconds: 3600, taskTitle: "Night work" }]);
    expect(await store.listLogsForDay("2026-11-06")).toMatchObject([{ seconds: 5400, taskTitle: "Night work" }]);
  });

  it("a refused log keeps the bar and the text, and shows why", async () => {
    renderTimer();
    enter(); // first ever use: 0 s to log
    await logIt("Too quick");
    expect(screen.getByRole("alert").textContent).toMatch(/second/);
    expect((bar() as HTMLInputElement).value).toBe("Too quick");
  });

  it("keyboard: Space opens it; Enter in the bar logs", async () => {
    localStorage.setItem("pm.timer.startedAt", String(T0 - 3_000));
    const { store } = renderTimer();
    fireEvent.keyDown(button(), { key: " " });
    fireEvent.change(bar()!, { target: { value: "Typing" } });
    await act(async () => void fireEvent.submit((bar() as HTMLInputElement).form!));
    expect(await store.listLogsForDay(DAY0)).toMatchObject([{ seconds: 3, taskTitle: "Typing" }]);
  });
});
