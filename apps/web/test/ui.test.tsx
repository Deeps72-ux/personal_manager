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
    upserts: { tasks: [], placements: [], logEntries: [] },
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

    await waitFor(() => expect(api.pushed.map((c) => c.op)).toEqual(["createTask", "createTask", "deleteTask"]));
  });

  it("LOG: calendar → day → pick card → seconds; blocks over 24h; delete entry", async () => {
    const { user, services } = renderApp();
    await signUp(user);
    await services.tasks.create({ title: "Sleep" });
    await services.tasks.create({ title: "Task7" });

    await user.click(nav().getByRole("button", { name: /Log/ }));
    await user.click(await screen.findByRole("gridcell", { name: new RegExp(`^${todayLocal()}`) }));

    await user.click(screen.getByRole("button", { name: "Sleep" }));
    await user.type(screen.getByLabelText("Seconds for Sleep"), "8*60*60");
    expect(screen.getByText("= 28,800 s (8h)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add" }));
    const entries = () => within(document.querySelector(".entries") as HTMLElement);
    await waitFor(() => expect(entries().getByText("28,800 s")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Task7" }));
    await user.type(screen.getByLabelText("Seconds for Task7"), "17h");
    expect(screen.getByText(/Over 24 hours: only 57,600 s/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toHaveProperty("disabled", true);
    await user.clear(screen.getByLabelText("Seconds for Task7"));
    await user.type(screen.getByLabelText("Seconds for Task7"), "27");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(entries().getByText("27 s")).toBeTruthy());
    expect(screen.getByText(/28,827 s/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete Task7 entry" }));
    await waitFor(() => expect(entries().queryByText("27 s")).toBeNull());

    // back to the calendar: today shows its total
    await user.click(screen.getByRole("button", { name: "Back to calendar" }));
    expect(await screen.findByRole("gridcell", { name: `${todayLocal()}, 8h logged` })).toBeTruthy();
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
