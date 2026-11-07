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
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  setVisibility("visible");
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
  it("shows only an unlabelled button until tapped, then a live HH:MM:SS above it", () => {
    render(<TimerView />);
    expect(button().textContent).toBe("");
    expect(document.querySelector(".timer")?.textContent).toBe("");
    expect(display()).toBeNull();

    advance(65_000);
    fireEvent.click(button());
    expect(display()?.textContent).toBe("00:01:05");
    expect(display()?.nextElementSibling).toBe(button()); // time sits above the button
    advance(2_000);
    expect(display()?.textContent).toBe("00:01:07");

    fireEvent.click(button()); // hide again; the count keeps going underneath
    expect(display()).toBeNull();
  });

  it("leaving the screen hides the time and restarts the count from that moment", () => {
    const first = render(<TimerView />);
    advance(10_000);
    fireEvent.click(button());
    expect(display()?.textContent).toBe("00:00:10");

    first.unmount(); // switched to another tab
    expect(readTimerStart()).toBe(T0 + 10_000);

    advance(90_000); // away for 1m30s
    render(<TimerView />);
    expect(display()).toBeNull();
    fireEvent.click(button());
    expect(display()?.textContent).toBe("00:01:30");
  });

  it("the app going to the background also counts as leaving", () => {
    render(<TimerView />);
    advance(5_000);
    fireEvent.click(button());

    setVisibility("hidden");
    expect(display()).toBeNull();
    advance(3_000);
    setVisibility("visible");

    fireEvent.click(button());
    expect(display()?.textContent).toBe("00:00:03");
  });
});
