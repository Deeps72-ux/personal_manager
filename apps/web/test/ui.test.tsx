// @vitest-environment jsdom
/**
 * UI flows in a simulated browser, with in-memory adapters (no server).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { todayLocal, type Change, type PullResponse } from "@pm/shared";
import { MemorySessionStore, MemoryStore } from "../src/adapters/memory-store.ts";
import { FolderActions, LogActions, PriorityActions, SlotActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { AuthService, SessionHolder } from "../src/core/auth.ts";
import { ExportLogs } from "../src/core/export-logs.ts";
import type { RemoteApi } from "../src/core/ports.ts";
import { SyncEngine } from "../src/core/sync-engine.ts";
import { App } from "../src/ui/App.tsx";
import { ServicesProvider, type Services } from "../src/ui/services.tsx";
import { rankedList } from "../src/core/views.ts";

afterEach(() => {
  vi.restoreAllMocks();
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
    upserts: { tasks: [], placements: [], logEntries: [], priorityHistory: [], folders: [], prioritySlots: [], hiddenActivities: [] },
    deletes: { tasks: [], placements: [], logEntries: [], folders: [], prioritySlots: [], hiddenActivities: [] },
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
  const priority = new PriorityActions({ store, sync });
  const services: Services = {
    store,
    holder,
    sync,
    auth: new AuthService({ api, sessions: new MemorySessionStore(), store, holder }),
    tasks: new TaskActions({ store, sync }),
    folders: new FolderActions({ store, sync }),
    priority,
    slots: new SlotActions({ store, sync, priority }),
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

  it("TASKS folders: create, open, add inside, path back, Move to…, rename, remove with everything in it", async () => {
    const { user, api } = renderApp();
    await signUp(user);
    await user.click(nav().getByRole("button", { name: /Tasks/ }));

    await user.click(screen.getByRole("button", { name: /New folder/ }));
    await user.type(screen.getByLabelText("New folder name"), "Work{Enter}");
    await user.click(await screen.findByRole("button", { name: "Open Work, 0 tasks" }));
    expect(screen.getByText("No tasks or folders yet.")).toBeTruthy();

    await user.type(screen.getByLabelText("Title"), "inside");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByText("inside");
    await user.click(screen.getByRole("button", { name: /New folder/ }));
    await user.type(screen.getByLabelText("New folder name"), "Deep{Enter}");
    await screen.findByRole("button", { name: "Open Deep, 0 tasks" });

    // The path leads back to the top level; the folder count includes its sub-folders.
    const path = within(screen.getByRole("navigation", { name: "Folder path" }));
    await user.click(path.getByRole("button", { name: "Tasks" }));
    await screen.findByRole("button", { name: "Open Work, 1 task" });
    expect(screen.queryByText("inside")).toBeNull();

    // A duplicate name next to it is refused.
    await user.click(screen.getByRole("button", { name: /New folder/ }));
    await user.type(screen.getByLabelText("New folder name"), "work{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("already a folder");
    await user.keyboard("{Escape}");

    // Move to…: a top-level task into Work › Deep.
    await user.type(screen.getByLabelText("Title"), "loose");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.click(await screen.findByRole("button", { name: "Move loose" }));
    const dialog = within(screen.getByRole("dialog", { name: "Move loose" }));
    expect((dialog.getByRole("button", { name: /Tasks/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(dialog.getByRole("button", { name: "Deep" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByRole("button", { name: "Open Work, 2 tasks" });

    await user.click(screen.getByRole("button", { name: "Rename Work" }));
    const field = screen.getByLabelText("Rename Work");
    await user.clear(field);
    await user.type(field, "Job{Enter}");
    await screen.findByRole("button", { name: "Open Job, 2 tasks" });

    // Remove asks first and says what goes with it.
    await user.click(screen.getByRole("button", { name: "Remove Job" }));
    expect(screen.getByText("Deletes 2 folders and 2 tasks")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText("No tasks yet. Add your first one above.");

    // Other tabs never saw folders: the priority list is simply empty again.
    await user.click(nav().getByRole("button", { name: /Priority/ }));
    expect(document.querySelectorAll(".stack-item").length).toBe(0);
    await waitFor(() =>
      expect(api.pushed.map((c) => c.op).filter((op) => op !== "recordPriority")).toEqual([
        "createFolder",
        "createTask",
        "createFolder",
        "createTask",
        "setTaskFolder",
        "renameFolder",
        "deleteTask",
        "deleteTask",
        "deleteFolder",
        "deleteFolder",
      ]),
    );
  });

  it("cards outside TASKS show the task's own folder (the last one when nested); top-level tasks show none", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    const work = await services.folders.create("Work");
    const deep = await services.folders.create("Deep", work);
    await services.tasks.create({ title: "nested", folderId: deep });
    await services.tasks.create({ title: "loose" });

    await user.click(nav().getByRole("button", { name: /Priority/ }));
    const nested = await screen.findByRole("button", { name: /^\d+\. nested$/ });
    await waitFor(() => expect(nested.querySelector(".folder-chip")?.textContent).toBe("Deep"));
    expect(screen.getByRole("button", { name: /^\d+\. loose$/ }).querySelector(".folder-chip")).toBeNull();

    // Renaming the folder updates the card.
    await services.folders.rename(deep, "Deeper");
    await waitFor(() => expect(nested.querySelector(".folder-chip")?.textContent).toBe("Deeper"));
  });

  it("PRIORITY: tap a card's # to type a rank; cards can share it; clear goes back to the position", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    for (const t of ["C", "B", "A"]) await services.tasks.create({ title: t });
    await user.click(nav().getByRole("button", { name: /Priority/ }));
    await user.click(await screen.findByRole("button", { name: "Rank 3 of C: change" }));
    const dialog = within(screen.getByRole("dialog", { name: "Rank of C" }));
    await user.type(dialog.getByLabelText("Rank"), "1");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const badges = () => [...document.querySelectorAll(".stack-item")].map((li) => li.getAttribute("aria-label"));
    await waitFor(() => expect(badges()).toEqual(["1. A", "1. C", "2. B"]));

    await user.click(screen.getByRole("button", { name: "Rank 1 of C: change" }));
    await user.type(screen.getByLabelText("Rank"), "{Backspace}9");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("from 1 to 3");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(badges()).toEqual(["1. A", "2. B", "3. C"]));
  });

  it("PRIORITY: schedule a list for a future slot: leave a task out, save; overlaps are refused", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    for (const t of ["C", "B", "A"]) await services.tasks.create({ title: t });
    await user.click(nav().getByRole("button", { name: /Priority/ }));
    await user.click(await screen.findByRole("button", { name: "Scheduled priority lists" }));
    let dialog = within(screen.getByRole("dialog", { name: "Scheduled priority lists" }));
    expect(dialog.getByText("Nothing scheduled.")).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: /New scheduled list/ }));
    dialog = within(screen.getByRole("dialog", { name: "Scheduled priority lists" }));
    await user.click(dialog.getByRole("button", { name: "Leave B out" }));
    expect(dialog.getByRole("button", { name: "Add B" })).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(dialog.queryByRole("button", { name: "Save" })).toBeNull());
    const [slot] = await services.store.listSlots();
    expect(slot!.list.entries.map((e) => `${e.title}${e.rank}`)).toEqual(["A1", "C2"]);
    expect(slot!.startMs).toBeGreaterThan(Date.now());
    expect(screen.getByText(/Next scheduled list/)).toBeTruthy();

    // The same times again: refused, naming the clash.
    await user.click(dialog.getByRole("button", { name: /New scheduled list/ }));
    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Overlaps the scheduled list/);
  });

  it("LOG → a day → Priority: each list in force with its time; open one to restore it (✓ still needed) or schedule it again", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    for (const t of ["C", "B", "A"]) await services.tasks.create({ title: t });
    const day = todayLocal();
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const at = (h: number) => new Date(y, m - 1, d, h).getTime();
    await services.priority.confirm(at(0) - 1000); // A B C since yesterday
    const c = (await services.store.listTasks()).find((t) => t.title === "C")!;
    await services.priority.move(c.id, 0);
    await services.priority.confirm(Math.min(at(4), Date.now() - 1000)); // C A B

    await user.click(nav().getByRole("button", { name: /Log/ }));
    await user.click(await screen.findByRole("gridcell", { name: new RegExp(`^${day}`) }));
    await user.click(screen.getByRole("tab", { name: "Priority" }));
    const rows = within(await screen.findByRole("list", { name: "Priority lists" }));
    const items = rows.getAllByRole("button");
    expect(items.map((b) => b.querySelector(".prio-top")!.textContent)).toEqual(["#1 A · +2 more", "#1 C · +2 more"]);
    expect(items[0]!.querySelector(".prio-time")!.textContent).toMatch(/^00:00–/);
    expect(items[1]!.querySelector(".prio-time")!.textContent).toMatch(/– now$/);

    await user.click(items[0]!);
    let dialog = within(screen.getByRole("dialog", { name: "Priority list" }));
    expect(dialog.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["#1A", "#2B", "#3C"]);
    await user.click(dialog.getByRole("button", { name: "Restore as current" }));
    await user.click(dialog.getByRole("button", { name: "Restore" }));
    await screen.findByText(/Restored as your current list/);
    const history = (await services.store.listHistory()).length;
    const shown = rankedList(await services.store.listTasks(), await services.store.listPlacements(), await services.store.listFolders());
    expect(shown.map((x) => x.task.title)).toEqual(["A", "B", "C"]);
    expect((await services.store.listHistory()).length).toBe(history);
    await user.click(dialog.getByRole("button", { name: "Close" }));

    // Schedule it again: the slot editor opens filled with that list.
    await user.click(rows.getAllByRole("button")[1]!);
    dialog = within(screen.getByRole("dialog", { name: "Priority list" }));
    await user.click(dialog.getByRole("button", { name: "Schedule this list again" }));
    const editor = within(screen.getByRole("dialog", { name: "Scheduled priority lists" }));
    await user.click(editor.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Scheduled priority lists" })).toBeNull());
    const [slot] = await services.store.listSlots();
    expect(slot!.list.entries.map((e) => e.title)).toEqual(["C", "A", "B"]);
  });

  it("TASKS: new tasks and folders go to the very top, above older folders", async () => {
    const { user } = renderApp();
    await signUp(user);
    await user.click(nav().getByRole("button", { name: /Tasks/ }));
    await user.click(screen.getByRole("button", { name: /New folder/ }));
    await user.type(screen.getByLabelText("New folder name"), "Work{Enter}");
    await screen.findByRole("button", { name: "Open Work, 0 tasks" });
    await user.type(screen.getByLabelText("Title"), "first");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.type(screen.getByLabelText("Title"), "second");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByText("second");
    const rows = () =>
      [...document.querySelectorAll(".itemlist .folder-name, .itemlist .taskcard h3")].map((n) => n.textContent);
    await waitFor(() => expect(rows()).toEqual(["second", "first", "Work"]));
  });

  it("TASKS remembers the open folder on this device", async () => {
    const { user } = renderApp();
    await signUp(user);
    await user.click(nav().getByRole("button", { name: /Tasks/ }));
    await user.click(screen.getByRole("button", { name: /New folder/ }));
    await user.type(screen.getByLabelText("New folder name"), "Work{Enter}");
    await user.click(await screen.findByRole("button", { name: "Open Work, 0 tasks" }));
    await user.click(nav().getByRole("button", { name: /Priority/ }));
    await user.click(nav().getByRole("button", { name: /Tasks/ }));
    expect(await screen.findByText("New task in Work")).toBeTruthy();
  });

  it("LOG: the day's 24 hours as a split bar: pick exact ranges, label them, save; each log shows its priority slices", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    await services.tasks.create({ title: "Sleep" });
    await services.tasks.create({ title: "Task7" }); // list: Task7, Sleep
    const day = todayLocal();
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const at = (h: number) => new Date(y, m - 1, d, h).getTime();
    await services.priority.confirm(at(0) - 1000); // Task7 is #1 from before midnight
    const sleep = (await services.store.listTasks()).find((t) => t.title === "Sleep")!;
    await services.priority.move(sleep.id, 0);
    await services.priority.confirm(at(4)); // Sleep is #1 from 04:00

    await user.click(nav().getByRole("button", { name: /Log/ }));
    await user.click(await screen.findByRole("gridcell", { name: new RegExp(`^${day}`) }));

    // The bar is 2400 px wide on screen: 100 px per hour (jsdom has no layout).
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 2400,
      bottom: 50,
      width: 2400,
      height: 50,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const rows = () =>
      [...document.querySelectorAll<HTMLElement>(".split-piece")].map((b) =>
        b.getAttribute("aria-label")!.replace(/^(\S+) to (\S+), .*?: (.*)$/, "$1–$2 $3"),
      );
    await waitFor(() => expect(rows()).toEqual(["00:00–00:00 unlogged"]));
    const viewport = () => document.querySelector<HTMLElement>(".splitbar-viewport")!;
    const doubleTap = (x: number) => {
      for (let k = 0; k < 2; k++) {
        fireEvent.pointerDown(viewport(), { pointerId: 1, clientX: x, button: 0, pointerType: "touch" });
        fireEvent.pointerUp(viewport(), { pointerId: 1, clientX: x, button: 0, pointerType: "touch" });
      }
    };
    doubleTap(800); // 08:00
    doubleTap(850); // 08:30
    await waitFor(() => expect(rows()).toEqual(["00:00–08:00 unlogged", "08:00–08:30 unlogged", "08:30–00:00 unlogged"]));
    const piece = (i: number) => document.querySelectorAll<HTMLElement>(".split-piece")[i]!;
    fireEvent.click(piece(0)); // pick (keyboard-style click: at once)
    await user.click(screen.getByRole("button", { name: "Sleep" })); // tap a card to fill the picked piece
    fireEvent.click(piece(1));
    await user.type(screen.getByLabelText("Activity from 08:00 to 08:30"), "Task7");
    expect(rows()).toEqual(["00:00–08:00 Sleep;", "08:00–08:30 Task7", "08:30–00:00 unlogged"]);
    expect(await services.store.listLogsForDay(day)).toEqual([]); // nothing saved yet

    await user.click(screen.getByRole("button", { name: "Log 2 pieces" }));
    const entries = () => within(document.querySelector(".entries") as HTMLElement);
    // Sleep ran under two confirmed orders: one slice each, with that order's #1 and its own score.
    await waitFor(() => expect(entries().getByText("00:00–04:00")).toBeTruthy());
    // One entry per log; under Sleep, each confirmed order in force while it ran, with its own score.
    const text = [...document.querySelectorAll(".entries > .entry")].map((li) => li.textContent);
    expect(text).toHaveLength(2);
    expect(text[0]).toContain("00:00–08:00Sleep");
    const sleepSlices = [...document.querySelectorAll(".entry-slices li")].map((li) => li.textContent);
    expect(sleepSlices).toEqual(["00:00–04:00 priority: Task7 · deviation 33.3%", "04:00–08:00 priority: Sleep · deviation 0%"]);
    expect(text[1]).toContain("08:00–08:30");
    expect(text[1]).toContain("priority: Sleep · deviation 33.3%");
    // Logged time is locked on the bar now.
    await waitFor(() => expect(rows()[0]).toBe("00:00–08:30 Sleep / Task7"));
    expect(piece(0).getAttribute("aria-disabled")).toBe("true");
    // Coloured: each entry has its activity's swatch.
    expect(document.querySelectorAll(".entries .swatch").length).toBe(2);

    await user.click(screen.getByRole("button", { name: "Delete Task7 entry" }));
    await waitFor(() => expect(entries().queryByText("08:00–08:30")).toBeNull());

    // back to the calendar: today shows its total
    await user.click(screen.getByRole("button", { name: "Back to calendar" }));
    const cell = await screen.findByRole("gridcell", { name: `${day}, 8h logged` });
    // Its strip shows the day's logs in their colours, on the clock.
    const strip = [...cell.querySelectorAll<HTMLElement>(".dbar-piece")].map((p) => [p.style.left, p.style.width]);
    expect(strip).toEqual([["0%", `${(8 / 24) * 100}%`]]);
  });

  it("PRIORITY: ✓ is pressable only when the order differs from the confirmed one", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    for (const t of ["B", "A"]) await services.tasks.create({ title: t });
    await user.click(nav().getByRole("button", { name: /Priority/ }));
    const confirm = await screen.findByRole("button", { name: "Confirm this priority order" });
    expect(screen.getByText(/Nothing confirmed yet/)).toBeTruthy();
    await user.click(confirm);
    await waitFor(() => expect(screen.getByRole("button", { name: "Priority order confirmed" })).toHaveProperty("disabled", true));
    expect((await services.store.listHistory()).map((h) => [h.titles, h.confirmed])).toEqual([[["A", "B"], true]]);
    const b = (await services.store.listTasks()).find((t) => t.title === "B")!;
    await services.priority.move(b.id, 0);
    expect(await screen.findByText(/Order changed: scores still use the last confirmed order/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm this priority order" })).toHaveProperty("disabled", false);
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
    await services.logs.add("2025-12-31", 60, "old", new Date(2025, 11, 31, 9).getTime());

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
