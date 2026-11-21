// @vitest-environment jsdom
/**
 * UI flows in a simulated browser, with in-memory adapters (no server).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { todayLocal, type Change, type PullResponse } from "@pm/shared";
import { MemorySessionStore, MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, PriorityActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { AuthService, SessionHolder } from "../src/core/auth.ts";
import { ExportLogs } from "../src/core/export-logs.ts";
import type { RemoteApi } from "../src/core/ports.ts";
import { SyncEngine } from "../src/core/sync-engine.ts";
import { App } from "../src/ui/App.tsx";
import { ServicesProvider, type Services } from "../src/ui/services.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A server stand-in: accepts everything, never has anything new. */
function fakeApi(): RemoteApi & { pushed: Change[] } {
  const pushed: Change[] = [];
  const user = { id: "u1", username: "deepan" };
  const empty: PullResponse = {
    mode: "incremental",
    cursor: 1,
    hasMore: false,
    purgedBefore: null,
    timerStart: null,
    upserts: { tasks: [], placements: [], logEntries: [], priorityHistory: [] },
    deletes: { tasks: [], placements: [], logEntries: [] },
  };
  return {
    pushed,
    signUp: async (c) => ({ token: "t", user: { ...user, username: c.username } }),
    signIn: async (c) => ({ token: "t", user: { ...user, username: c.username } }),
    signOut: async () => undefined,
    push: async (changes) => {
      pushed.push(...changes);
      return { results: changes.map((c) => ({ changeId: c.changeId, status: "applied" as const })) };
    },
    pull: async () => empty,
  };
}

function renderApp() {
  const store = new MemoryStore();
  const holder = new SessionHolder();
  const api = fakeApi();
  const sync = new SyncEngine({ store, api, debounceMs: 5 });
  const saved: string[] = [];
  const services: Services = {
    store,
    holder,
    sync,
    auth: new AuthService({ api, sessions: new MemorySessionStore(), store, holder }),
    tasks: new TaskActions({ store, sync }),
    priority: new PriorityActions({ store, sync }),
    logs: new LogActions({ store, sync }),
    timer: new TimerActions({ store, sync }),
    exporter: new ExportLogs({
      store,
      writer: { writeLog: async () => new Blob(["xlsx"]) },
      saver: { save: (_b, name) => void saved.push(name) },
    }),
  };
  render(
    <ServicesProvider value={services}>
      <App />
    </ServicesProvider>,
  );
  return { services, api, saved, user: userEvent.setup() };
}

async function signUp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: "Create account" }));
  await user.type(screen.getByLabelText("Username"), "deepan");
  await user.type(screen.getByLabelText("Password"), "password123");
  await user.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByText("Personal Manager");
}

const nav = () => within(document.querySelector(".tabs-bottom") as HTMLElement);

describe("PWA UI", () => {
  it("shows validation errors on the auth screen", async () => {
    const { user } = renderApp();
    await user.type(await screen.findByLabelText("Username"), "ab");
    await user.type(screen.getByLabelText("Password"), "password123");
    // bypass native minLength so our own validation message shows
    (document.querySelector("form") as HTMLFormElement).noValidate = true;
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "username must be at least 3 characters");
  });

  it("TASKS → PRIORITY: new tasks appear on top; remove asks first", async () => {
    const { user, api } = renderApp();
    await signUp(user);

    await user.click(nav().getByRole("button", { name: /Tasks/ }));
    await user.type(screen.getByLabelText("Title"), "first");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.type(screen.getByLabelText("Title"), "second");
    await user.type(screen.getByLabelText(/Description/), "with notes");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByText("with notes");

    await user.click(nav().getByRole("button", { name: /Priority/ }));
    await screen.findByLabelText("1. second");
    const items = [...document.querySelectorAll(".stack-item")];
    expect(items.map((li) => li.getAttribute("aria-label"))).toEqual(["1. second", "2. first"]);

    await user.click(nav().getByRole("button", { name: /Tasks/ }));
    await user.click(screen.getByRole("button", { name: "Remove first" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("first")).toBeNull());

    await waitFor(() =>
      expect(api.pushed.map((c) => c.op).filter((op) => op !== "recordPriority")).toEqual([
        "createTask",
        "createTask",
        "deleteTask",
      ]),
    );
  });

  it("LOG: calendar → day → pick card → duration → accept the proposed slot; refuses what cannot fit", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    await services.tasks.create({ title: "Sleep" });
    await services.tasks.create({ title: "Task7" });

    await user.click(nav().getByRole("button", { name: /Log/ }));
    await user.click(await screen.findByRole("gridcell", { name: new RegExp(`^${todayLocal()}`) }));

    await user.click(screen.getByRole("button", { name: "Sleep" }));
    await user.type(screen.getByLabelText("Seconds for Sleep"), "8*60*60");
    expect(screen.getByText("= 28,800 s (8h)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Find a slot" }));
    expect(await screen.findByText(/00:00 – 08:00/)).toBeTruthy(); // asks first
    expect(await services.store.listLogsForDay(todayLocal())).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    const entries = () => within(document.querySelector(".entries") as HTMLElement);
    await waitFor(() => expect(entries().getByText("00:00–08:00")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Task7" }));
    await user.type(screen.getByLabelText("Seconds for Task7"), "17h");
    expect(screen.getByText(/No free slot that long: the longest is 16h/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find a slot" })).toHaveProperty("disabled", true);
    await user.clear(screen.getByLabelText("Seconds for Task7"));
    await user.type(screen.getByLabelText("Seconds for Task7"), "30m");
    await user.click(screen.getByRole("button", { name: "Find a slot" }));
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() => expect(entries().getByText("08:00–08:30")).toBeTruthy());
    expect(screen.getByText("8h 30m")).toBeTruthy(); // logged so far

    await user.click(screen.getByRole("button", { name: "Delete Task7 entry" }));
    await waitFor(() => expect(entries().queryByText("08:00–08:30")).toBeNull());

    // back to the calendar: today shows its total
    await user.click(screen.getByRole("button", { name: "Back to calendar" }));
    expect(await screen.findByRole("gridcell", { name: `${todayLocal()}, 8h logged` })).toBeTruthy();
  });

  it("PRIORITY: the waiting queue opens as a pipeline, oldest at the bottom, and the icon heats up", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    for (const t of ["C", "B", "A"]) await services.tasks.create({ title: t });
    const id = async (title: string) => (await services.store.listTasks()).find((t) => t.title === title)!.id;
    await services.priority.enqueue(await id("B"), Date.now() - 125 * 60_000); // waiting over 2 h
    await services.priority.enqueue(await id("C"), Date.now() - 60_000);

    await user.click(nav().getByRole("button", { name: /Priority/ }));
    await screen.findByLabelText("1. A");
    expect([...document.querySelectorAll(".stack-item")].map((li) => li.getAttribute("aria-label"))).toEqual(["1. A"]);
    const icon = screen.getByRole("button", { name: /Waiting queue: 2 tasks, oldest waiting 2h/ });
    expect(icon.className).toMatch(/pulsing/); // past one hour

    await user.click(icon);
    const dialog = within(screen.getByRole("dialog", { name: "Waiting queue" }));
    expect([...document.querySelectorAll(".queue-card-title")].map((e) => e.textContent)).toEqual(["C", "B"]);
    expect(dialog.getByLabelText(/^B, first in line/)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("two overlapping timer logs (devices that were apart): the user keeps one", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    const day = todayLocal();
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const at = (h: number) => new Date(y, m - 1, d, h).getTime();
    const timerLog = (id: string, title: string, start: number) => ({
      id,
      day,
      seconds: 3600,
      taskTitle: title,
      focus: null,
      deviation: null,
      startMs: start,
      source: "timer" as const,
    });
    await services.store.write(async (tx) => {
      await tx.putLog(timerLog("0190a000-0000-7000-8000-000000000001", "Phone run", at(1)));
      await tx.putLog(timerLog("0190a000-0000-7000-8000-000000000002", "Laptop run", at(1) + 1800_000));
    });
    const alert = await screen.findByText(/Two timer logs overlap/);
    expect(alert).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Keep Laptop run/ }));
    await waitFor(() => expect(screen.queryByText(/overlap/)).toBeNull());
    expect((await services.store.listLogsForDay(day)).map((l) => l.taskTitle)).toEqual(["Laptop run"]);
  });

  it("export and purge tools", async () => {
    const { user, saved, services } = renderApp();
    await signUp(user);
    await services.logs.add("2025-12-31", 60, "old");

    await user.click(nav().getByRole("button", { name: /Log/ }));
    await user.click(screen.getByRole("button", { name: "Export / clean up" }));
    await user.click(screen.getByRole("button", { name: "Download .xlsx" }));
    expect(await screen.findByText(/Saved log_.*\.xlsx/)).toBeTruthy();
    expect(saved).toHaveLength(1);

    const input = screen.getByLabelText("Delete logs before");
    await user.type(input, "2026-01-01");
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete permanently" }));
    expect(await screen.findByText(/Deleted all logs before 2026-01-01/)).toBeTruthy();
    expect(await services.store.listLogsBetween("2000-01-01", "2100-01-01")).toEqual([]);
  });

  it("appearance switch: per device, remembered, System clears it", async () => {
    const { user } = renderApp();
    await signUp(user);
    await user.click(screen.getByRole("button", { name: "Account" }));
    const group = within(screen.getByRole("group", { name: "Appearance" }));
    expect(group.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(group.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("pm.theme")).toBe("dark");

    await user.click(group.getByRole("button", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    await user.click(group.getByRole("button", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("pm.theme")).toBeNull();
  });

  it("sign out warns when changes are not yet synced", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    services.sync.stop(); // keep changes pending
    await services.tasks.create({ title: "unsynced" });
    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/not synced yet/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign out anyway" }));
    expect(await screen.findByRole("tab", { name: "Sign in" })).toBeTruthy();
    expect(await services.store.listTasks()).toEqual([]);
  });
});
