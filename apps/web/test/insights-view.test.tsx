// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { InsightsView } from "../src/ui/InsightsView.tsx";
import { ServicesProvider, type Services } from "../src/ui/services.tsx";

const NOW = new Date(2026, 10, 19, 18, 0).getTime(); // Thu 19 Nov 2026, local

async function renderWith(rows: { t: number; day: string; focus: number; deviation: number | null }[]) {
  const store = new MemoryStore();
  await store.write(async (tx) => {
    for (const r of rows) {
      await tx.putLog({ id: uuidv7(r.t), day: r.day, seconds: 600, taskTitle: "A;X;", focus: r.focus, deviation: r.deviation });
    }
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
  it("plots this week's ✓ logs and moves back and forth", async () => {
    await renderWith([
      { t: new Date(2026, 10, 18, 10).getTime(), day: "2026-11-18", focus: 50, deviation: 20 },
      { t: new Date(2026, 10, 19, 9).getTime(), day: "2026-11-19", focus: 100, deviation: 0 },
      { t: new Date(2026, 10, 10, 9).getTime(), day: "2026-11-10", focus: 25, deviation: 60 },
    ]);
    expect(screen.getByRole("img", { name: "Focus over time, 2 points" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Deviation over time, 2 points" })).toBeTruthy();
    const stats = () => [...document.querySelectorAll(".stat-value")].map((e) => e.textContent);
    expect(stats()).toEqual(["75%", "10%", "2"]); // averages (equal durations), count

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Previous week" })));
    expect(screen.getByRole("img", { name: "Focus over time, 1 points" })).toBeTruthy();
    expect(stats()).toEqual(["25%", "60%", "1"]);

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Now" })));
    expect(screen.getByRole("img", { name: "Focus over time, 2 points" })).toBeTruthy();
  });

  it("explains an empty period", async () => {
    await renderWith([]);
    expect(screen.getByText(/No TIMER logs in this period/)).toBeTruthy();
  });
});
