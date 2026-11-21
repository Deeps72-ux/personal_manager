// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { localDay } from "../src/core/insights.ts";
import { InsightsView } from "../src/ui/InsightsView.tsx";
import { ServicesProvider, type Services } from "../src/ui/services.tsx";

const NOW = new Date(2026, 10, 19, 18, 0).getTime(); // Thu 19 Nov 2026, local

/** Hour-long TIMER logs of "A" starting at `starts`; A is #1 of 2 until `swap`, then #2 of 2. */
async function renderWith(starts: number[], swap = Infinity) {
  const store = new MemoryStore();
  await store.write(async (tx) => {
    for (const t of starts) {
      await tx.putLog({
        id: uuidv7(t),
        day: localDay(t),
        seconds: 3600,
        taskTitle: "A",
        focus: null,
        deviation: null,
        startMs: t,
        source: "timer",
      });
    }
    await tx.putSnapshot({ id: uuidv7(0), at: 0, titles: ["A", "B"] });
    if (swap !== Infinity) await tx.putSnapshot({ id: uuidv7(swap), at: swap, titles: ["B", "A"] });
  });
  render(
    <ServicesProvider value={{ store } as unknown as Services}>
      <InsightsView />
    </ServicesProvider>,
  );
  await act(async () => undefined);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InsightsView", () => {
  it("plots this week's hours and logs, and moves back and forth", async () => {
    const swap = new Date(2026, 10, 19, 0).getTime();
    await renderWith(
      [
        new Date(2026, 10, 18, 10).getTime(), // A was top: 0%
        new Date(2026, 10, 19, 9, 30).getTime(), // after the swap: A is #2 of 2 → 33.3%
        new Date(2026, 10, 10, 9).getTime(), // last week
      ],
      swap,
    );
    // Focus: 18th 10–11 (no switch), 19th 9–10 and 10–11 (half gap) → 3 hours this week.
    expect(screen.getByRole("img", { name: "Focus over time, 3 points" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Deviation over time, 2 points" })).toBeTruthy();
    const stats = () => [...document.querySelectorAll(".stat-value")].map((e) => e.textContent);
    // focus weighted by logged seconds: (3600·100 + 1800·50 + 1800·50) / 7200 = 75
    expect(stats()).toEqual(["75%", "16.7%", "2"]);

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Earlier" })));
    expect(screen.getByRole("img", { name: "Focus over time, 1 points" })).toBeTruthy();
    expect(stats()).toEqual(["100%", "0%", "1"]);

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Now" })));
    expect(screen.getByRole("img", { name: "Focus over time, 3 points" })).toBeTruthy();
  });

  it("zooms with the wheel / buttons and pans by dragging; presets come back", async () => {
    await renderWith([new Date(2026, 10, 19, 9).getTime()]);
    const svg = () => screen.getByRole("img", { name: /^Focus over time/ });
    const heading = () => document.querySelector(".insights-range")!.textContent;
    const week = heading();

    await act(async () => void fireEvent.wheel(svg(), { deltaY: -400, clientX: 300 })); // zoom in
    expect(heading()).not.toBe(week);
    expect(screen.getByRole("button", { name: "Week" }).getAttribute("aria-pressed")).toBe("false");

    for (let i = 0; i < 12; i++) await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Zoom in" })));
    expect(heading()).toMatch(/\d\d:\d\d:\d\d – \d\d:\d\d:\d\d$/); // seconds once narrow
    expect(document.querySelector(".chart .axis:last-of-type")).toBeTruthy();

    const before = heading();
    await act(async () => {
      fireEvent.pointerDown(svg(), { pointerId: 1, clientX: 300, button: 0, pointerType: "mouse" });
      fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 100, pointerType: "mouse" });
      fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 100, pointerType: "mouse" });
    });
    expect(heading()).not.toBe(before); // dragged left = later

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Week" })));
    expect(heading()).toBe(week);
  });

  it("explains an empty period", async () => {
    await renderWith([]);
    expect(screen.getByText(/Nothing scored in this period/)).toBeTruthy();
  });
});
