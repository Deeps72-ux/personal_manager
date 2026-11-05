/**
 * Black-box: multi-device sync scenarios from design Step 4.
 * Each test = one user on several simulated devices (mac, windows, phone),
 * editing "offline" (queued), then syncing in a chosen order.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, Device, uniqueUsername, userWithDevices } from "./client.ts";
import { startServer, type RunningServer } from "./harness.ts";

let server: RunningServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.stop());

const devices = (...names: string[]) => userWithDevices(server.baseUrl, ...names);

async function syncAll(...ds: Device[]) {
  for (const d of ds) await d.sync();
  for (const d of ds) await d.sync(); // second round: everyone sees everyone
}

function expectConverged(...ds: Device[]) {
  const [first, ...rest] = ds;
  for (const d of rest) expect(d.state(), `${d.name} vs ${first!.name}`).toEqual(first!.state());
}

describe("basic propagation", () => {
  it("a task created on the phone appears on mac and windows", async () => {
    const [phone, mac, win] = await devices("phone", "mac", "windows");
    phone.createTask("Gym", { description: "legs day", dueDate: "2026-11-10" });
    await syncAll(phone, mac, win);
    expect(mac.priorityTitles()).toEqual(["Gym"]);
    expect([...win.tasks.values()][0]).toMatchObject({ title: "Gym", description: "legs day", dueDate: "2026-11-10" });
    expectConverged(phone, mac, win);
  });

  it("new tasks always land at the top, on every device", async () => {
    const [mac, phone] = await devices("mac", "phone");
    mac.createTask("first");
    await syncAll(mac, phone);
    phone.createTask("second");
    await syncAll(phone, mac);
    mac.createTask("third");
    await syncAll(mac, phone);
    expect(phone.priorityTitles()).toEqual(["third", "second", "first"]);
    expectConverged(mac, phone);
  });
});

describe("conflicts (both devices offline, then sync)", () => {
  it("field-level merge: title on phone + due date on laptop → both kept", async () => {
    const [phone, laptop] = await devices("phone", "laptop");
    const gym = phone.createTask("Gym");
    await syncAll(phone, laptop);

    phone.updateTask(gym.id, { title: "Workout" });
    laptop.updateTask(gym.id, { dueDate: "2026-11-10" });
    await syncAll(phone, laptop);

    expect(laptop.tasks.get(gym.id)).toMatchObject({ title: "Workout", dueDate: "2026-11-10" });
    expectConverged(phone, laptop);
  });

  it("same field on both: the edit that reaches the server last wins", async () => {
    const [phone, laptop] = await devices("phone", "laptop");
    const gym = phone.createTask("Gym");
    await syncAll(phone, laptop);

    phone.updateTask(gym.id, { title: "Workout" });
    laptop.updateTask(gym.id, { title: "Exercise" });
    await phone.sync(); // phone arrives first
    await laptop.sync(); // laptop arrives last → wins
    await phone.sync();
    expect(phone.tasks.get(gym.id)!.title).toBe("Exercise");
    expectConverged(phone, laptop);
  });

  it("delete wins over an offline edit", async () => {
    const [mac, phone] = await devices("mac", "phone");
    const gym = mac.createTask("Gym");
    await syncAll(mac, phone);

    mac.deleteTask(gym.id);
    phone.updateTask(gym.id, { title: "Gym!!" });
    phone.moveTask(gym.id, 0);
    await mac.sync();
    await phone.sync();
    expect(phone.lastPush!.results.map((r) => (r.status === "ignored" ? r.reason : r.status))).toEqual([
      "deleted",
      "deleted",
    ]);
    await syncAll(mac, phone);
    expect(phone.tasks.has(gym.id)).toBe(false);
    expectConverged(mac, phone);
  });

  it("concurrent drag-and-drop of different cards converges to one order", async () => {
    const [mac, phone] = await devices("mac", "phone");
    for (const t of ["D", "C", "B", "A"]) mac.createTask(t); // top→bottom: A B C D
    await syncAll(mac, phone);
    expect(phone.priorityTitles()).toEqual(["A", "B", "C", "D"]);

    const id = (d: Device, title: string) => [...d.tasks.values()].find((t) => t.title === title)!.id;
    mac.moveTask(id(mac, "D"), 0); // mac: D A B C
    phone.moveTask(id(phone, "A"), 3); // phone: B C D A
    await syncAll(mac, phone);

    expectConverged(mac, phone);
    // Each drag changed only its own card: D went to the top, A to the bottom.
    expect(mac.priorityTitles()).toEqual(["D", "B", "C", "A"]);
  });

  it("concurrent drag of the SAME card: last move wins, everyone agrees", async () => {
    const [mac, phone] = await devices("mac", "phone");
    for (const t of ["C", "B", "A"]) mac.createTask(t);
    await syncAll(mac, phone);
    const c = [...mac.tasks.values()].find((t) => t.title === "C")!.id;

    mac.moveTask(c, 0); // C A B
    phone.moveTask(c, 1); // A C B
    await mac.sync();
    await phone.sync(); // phone last → wins
    await mac.sync();
    expect(mac.priorityTitles()).toEqual(["A", "C", "B"]);
    expectConverged(mac, phone);
  });

  it("two offline devices adding tasks at the top: no loss, same order everywhere", async () => {
    const [mac, phone] = await devices("mac", "phone");
    mac.createTask("existing");
    await syncAll(mac, phone);

    mac.createTask("from mac");
    phone.createTask("from phone"); // both pick the same "top" rank offline
    await syncAll(mac, phone);

    expect(mac.priorityTitles()).toHaveLength(3);
    expect(mac.priorityTitles().at(-1)).toBe("existing");
    expectConverged(mac, phone);
    // ...and dropping a card between the tied pair still works
    const ex = [...mac.tasks.values()].find((t) => t.title === "existing")!.id;
    mac.moveTask(ex, 1);
    await syncAll(mac, phone);
    expectConverged(mac, phone);
    expect(mac.priorityTitles()).toHaveLength(3);
  });
});

describe("LOG", () => {
  it("logs sync, can repeat the same task in a day, and survive task deletion", async () => {
    const [phone, win] = await devices("phone", "windows");
    const t7 = phone.createTask("Task7");
    phone.createLog("2026-11-05", 28_800, "Sleep");
    phone.createLog("2026-11-05", 27, "Task7");
    phone.createLog("2026-11-05", 33, "Task7");
    await syncAll(phone, win);
    expect(win.dayTitles("2026-11-05")).toEqual(["27s Task7", "28800s Sleep", "33s Task7"]);

    win.deleteTask(t7.id);
    await syncAll(win, phone);
    expect(phone.tasks.size).toBe(0);
    expect(phone.dayTitles("2026-11-05")).toHaveLength(3); // logs untouched
    expectConverged(phone, win);
  });

  it("deleting a log entry removes it everywhere", async () => {
    const [phone, mac] = await devices("phone", "mac");
    const e = phone.createLog("2026-11-05", 60, "Email");
    phone.createLog("2026-11-05", 120, "Read");
    await syncAll(phone, mac);
    mac.deleteLog(e.id);
    await syncAll(mac, phone);
    expect(phone.dayTitles("2026-11-05")).toEqual(["120s Read"]);
  });

  it("purge + purge guard: an offline device cannot resurrect purged days", async () => {
    const [mac, phone] = await devices("mac", "phone");
    mac.createLog("2025-12-01", 100, "old");
    mac.createLog("2026-01-02", 100, "new");
    await syncAll(mac, phone);

    phone.createLog("2025-12-20", 3600, "Reading"); // phone offline, in its outbox
    mac.purgeLogsBefore("2026-01-01");
    await mac.sync();
    await phone.sync();

    expect(phone.lastPush!.results[0]).toMatchObject({ status: "ignored", reason: "purged" });
    await syncAll(mac, phone);
    expect([...phone.logs.values()].map((l) => l.taskTitle)).toEqual(["new"]);
    expect(phone.purgedBefore).toBe("2026-01-01");
    expectConverged(mac, phone);
  });

  it("server stores > 24h for a day if two offline devices both log (UI-only rule)", async () => {
    const [mac, phone] = await devices("mac", "phone");
    mac.createLog("2026-11-05", 72_000, "mac 20h");
    phone.createLog("2026-11-05", 72_000, "phone 20h");
    await syncAll(mac, phone);
    const total = [...mac.logs.values()].reduce((s, l) => s + l.seconds, 0);
    expect(total).toBe(144_000);
  });
});

describe("robustness", () => {
  it("resending a push after a lost reply changes nothing (idempotent)", async () => {
    const [mac, phone] = await devices("mac", "phone");
    mac.createTask("Gym");
    mac.createLog("2026-11-05", 10, "Gym");
    const outbox = [...mac.outbox];
    await mac.sync();
    // Simulate: reply was lost, device sends the same changes again.
    const r = await mac.api.request("POST", "/api/sync/push", { changes: outbox });
    expect(r.status).toBe(200);
    await syncAll(mac, phone);
    expect(phone.tasks.size).toBe(1);
    expect(phone.logs.size).toBe(1);
  });

  it("a brand-new device gets everything via snapshot", async () => {
    const [mac] = await devices("mac");
    mac.createTask("a");
    mac.createTask("b");
    mac.createLog("2026-11-05", 5, "a");
    await mac.sync();
    const fresh = new Device(Object.assign(new Api(server.baseUrl), { token: mac.api.token }), "new-phone");
    await fresh.sync();
    expectConverged(mac, fresh);
  });

  it("users are isolated: another account sees nothing and cannot edit my rows", async () => {
    const [mine] = await devices("mine");
    const secret = mine.createTask("my secret");
    mine.createLog("2026-11-05", 99, "private");
    await mine.sync();

    const otherApi = new Api(server.baseUrl);
    await otherApi.signUp(uniqueUsername("intruder"));
    const intruder = new Device(otherApi, "intruder");
    await intruder.sync();
    expect(intruder.tasks.size + intruder.logs.size).toBe(0);

    intruder.outbox.push({ changeId: secret.id.replace(/.$/, "0"), op: "deleteTask", taskId: secret.id });
    await intruder.sync();
    expect(intruder.lastPush!.results[0]).toMatchObject({ status: "ignored", reason: "notFound" });
    await mine.sync();
    expect(mine.priorityTitles()).toEqual(["my secret"]);
  });
});
