// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, readTimerStart } from "../src/ui/timer-store.ts";
import { TimerView } from "../src/ui/TimerView.tsx";

const T0 = new Date("2026-11-07T10:00:00Z").getTime();
const display = () => {
  const el = document.querySelector<HTMLElement>(".timer-display");
  return el && !el.hidden ? el : null;
};
const button = () => screen.getByRole("button", { name: "Timer" });
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const enter = () => fireEvent.pointerEnter(button());
const leave = () => fireEvent.pointerLeave(button());

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
    render(<TimerView />);
    expect(button().textContent).toBe("");
    expect(document.querySelector(".timer")?.textContent).toBe("");
    expect(display()).toBeNull();
  });

  it("hover/touch shows ONE fixed time above the button; it does not tick", () => {
    localStorage.setItem("pm.timer.startedAt", String(T0 - 65_000));
    render(<TimerView />);
    enter();
    expect(display()?.textContent).toBe("00:01:05");
    expect(display()?.nextElementSibling).toBe(button()); // above the button
    wait(5_000); // still holding
    expect(display()?.textContent).toBe("00:01:05");
  });

  it("leaving hides the time and restarts the count from 0 at that moment", () => {
    render(<TimerView />);
    enter();
    wait(4_000);
    leave();
    expect(display()).toBeNull();
    expect(readTimerStart()).toBe(T0 + 4_000);

    wait(90_000);
    enter();
    expect(display()?.textContent).toBe("00:01:30");
  });

  it("a cancelled touch (e.g. the OS takes over) also counts as leaving", () => {
    render(<TimerView />);
    enter();
    wait(1_000);
    fireEvent.pointerCancel(button());
    expect(display()).toBeNull();
    expect(readTimerStart()).toBe(T0 + 1_000);
  });

  it("switching tabs or blurring without a hover does not reset the count", () => {
    localStorage.setItem("pm.timer.startedAt", String(T0 - 10_000));
    const view = render(<TimerView />);
    fireEvent.blur(button());
    view.unmount();
    expect(readTimerStart()).toBe(T0 - 10_000);
  });

  it("keyboard: hold Space to see the time, release to reset", () => {
    localStorage.setItem("pm.timer.startedAt", String(T0 - 3_000));
    render(<TimerView />);
    fireEvent.keyDown(button(), { key: " " });
    expect(display()?.textContent).toBe("00:00:03");
    fireEvent.keyUp(button(), { key: " " });
    expect(display()).toBeNull();
    expect(readTimerStart()).toBe(T0);
  });
});
