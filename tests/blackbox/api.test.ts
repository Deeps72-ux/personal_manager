/**
 * Black-box: HTTP behaviour of auth, validation and infrastructure.
 * Talks to a real server process over HTTP only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, Device, uniqueUsername } from "./client.ts";
import { startServer, type RunningServer } from "@pm/test-server";

let server: RunningServer;
beforeAll(async () => {
  server = await startServer({ SSE_HEARTBEAT_MS: "200" });
});
afterAll(() => server.stop());

describe("health + unknown routes", () => {
  it("health is public", async () => {
    expect(await new Api(server.baseUrl).request("GET", "/api/health")).toEqual({ status: 200, body: { ok: true } });
  });

  it("protected and unknown endpoints need a token", async () => {
    const api = new Api(server.baseUrl);
    for (const [m, p] of [
      ["GET", "/api/me"],
      ["GET", "/api/sync/pull?cursor=0"],
      ["POST", "/api/sync/push"],
      ["GET", "/api/nope"],
    ] as const) {
      expect((await api.request(m, p)).status).toBe(401);
    }
  });

  it("unknown endpoints are 404 once signed in", async () => {
    const api = new Api(server.baseUrl);
    await api.signUp(uniqueUsername());
    expect(await api.request("GET", "/api/nope")).toMatchObject({ status: 404, body: { error: "not_found" } });
  });
});

describe("sign up / sign in", () => {
  it("full flow: sign up → me → sign in on a 2nd device → sign out only that device", async () => {
    const name = uniqueUsername("Flow");
    const phone = new Api(server.baseUrl);
    const up = await phone.signUp(name);
    expect(up.user.username).toBe(name.toLowerCase());
    expect((await phone.request("GET", "/api/me")).body).toEqual(up.user);

    const laptop = new Api(server.baseUrl);
    await laptop.signIn(name.toUpperCase()); // usernames are case-insensitive
    expect((await laptop.request("POST", "/api/auth/signout")).status).toBe(204);
    expect((await laptop.request("GET", "/api/me")).status).toBe(401);
    expect((await phone.request("GET", "/api/me")).status).toBe(200);
  });

  it("duplicate username → 409", async () => {
    const name = uniqueUsername();
    await new Api(server.baseUrl).signUp(name);
    const r = await new Api(server.baseUrl).request("POST", "/api/auth/signup", { username: name, password: "password123" });
    expect(r).toMatchObject({ status: 409, body: { error: "username_taken" } });
  });

  it("wrong password and unknown user look identical (401 invalid_credentials)", async () => {
    const name = uniqueUsername();
    await new Api(server.baseUrl).signUp(name);
    const api = new Api(server.baseUrl);
    const wrong = await api.request("POST", "/api/auth/signin", { username: name, password: "wrong-password" });
    const ghost = await api.request("POST", "/api/auth/signin", { username: "ghost-" + name, password: "wrong-password" });
    expect(wrong).toEqual(ghost);
    expect(wrong).toMatchObject({ status: 401, body: { error: "invalid_credentials" } });
  });

  it.each([
    [{ username: "ab", password: "password123" }],
    [{ username: "has space", password: "password123" }],
    [{ username: "okname", password: "short" }],
    [{ username: "okname" }],
    [{ username: "okname", password: "password123", admin: true }],
  ])("invalid credentials payload → 400 %j", async (payload) => {
    const r = await new Api(server.baseUrl).request("POST", "/api/auth/signup", payload);
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });

  it("malformed JSON → 400", async () => {
    const r = await new Api(server.baseUrl).request("POST", "/api/auth/signup", undefined, "{nope");
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });

  it("a forged token is rejected", async () => {
    const api = new Api(server.baseUrl);
    api.token = "forged-token";
    expect((await api.request("GET", "/api/me")).status).toBe(401);
  });
});

describe("sync endpoint validation", () => {
  it("rejects bad pushes and bad cursors with 400", async () => {
    const api = new Api(server.baseUrl);
    await api.signUp(uniqueUsername());
    const bad = [
      { changes: [] },
      { changes: [{ changeId: "x", op: "createTask" }] },
      { changes: [{ op: "dropTable" }] },
    ];
    for (const body of bad) expect((await api.request("POST", "/api/sync/push", body)).status).toBe(400);
    expect((await api.request("GET", "/api/sync/pull?cursor=-1")).status).toBe(400);
    expect((await api.request("GET", "/api/sync/pull?cursor=abc")).status).toBe(400);
  });

  it("rejects bodies over the size limit with 413", async () => {
    const api = new Api(server.baseUrl);
    await api.signUp(uniqueUsername());
    const r = await api.request("POST", "/api/sync/push", undefined, `{"pad":"${"x".repeat(5 * 1024 * 1024)}"}`);
    expect(r).toMatchObject({ status: 413, body: { error: "payload_too_large" } });
  });
});

describe("rate limiting", () => {
  it("blocks repeated sign-in attempts for one account", async () => {
    const limited = await startServer({ AUTH_RATE_LIMIT_MAX: "3" });
    try {
      const api = new Api(limited.baseUrl);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const password = `wrong-guess-${i}`; // valid shape, so it reaches the limiter
        statuses.push((await api.request("POST", "/api/auth/signin", { username: "victim", password })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.stop();
    }
  });
});

describe("persistence", () => {
  it("data and sessions survive a server restart", async () => {
    let s = await startServer({}, undefined);
    const keepDir = s.dataDir;
    try {
      const api = new Api(s.baseUrl);
      await api.signUp(uniqueUsername());
      const d = new Device(api, "mac");
      d.createTask("Survives restart");
      await d.sync();

      s = await s.restart();
      const again = new Device(Object.assign(new Api(s.baseUrl), { token: api.token }), "mac-again");
      await again.sync();
      expect(again.priorityTitles()).toEqual(["Survives restart"]);
    } finally {
      await s.stop();
      (await import("node:fs")).rmSync(keepDir, { recursive: true, force: true });
    }
  });
});

describe("server-sent events", () => {
  /** Opens the SSE stream and resolves with each parsed `changed` event. */
  async function openEvents(api: Api) {
    const ctrl = new AbortController();
    const res = await fetch(`${api.baseUrl}/api/sync/events`, {
      headers: { authorization: `Bearer ${api.token}` },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let pings = 0;
    const next = async (): Promise<{ type: string; cursor: number }> => {
      for (;;) {
        const sep = buf.indexOf("\n\n");
        if (sep >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (block.startsWith(":")) {
            pings++;
            continue;
          }
          const data = block.split("\n").find((l) => l.startsWith("data:"));
          if (data) return JSON.parse(data.slice(5).trim());
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed");
        buf += decoder.decode(value, { stream: true });
      }
    };
    return { next, close: () => ctrl.abort(), pings: () => pings };
  }

  it("needs a token", async () => {
    const res = await fetch(`${server.baseUrl}/api/sync/events`);
    expect(res.status).toBe(401);
  });

  it("sends the current cursor on connect, then a poke when ANOTHER device pushes", async () => {
    const name = uniqueUsername();
    const phone = new Api(server.baseUrl);
    await phone.signUp(name);
    const laptop = new Api(server.baseUrl);
    await laptop.signIn(name);

    const events = await openEvents(phone);
    const first = await events.next();
    expect(first.type).toBe("changed");

    const d = new Device(laptop, "laptop");
    d.createTask("Poke me");
    await d.sync();

    const poke = await events.next();
    expect(poke.type).toBe("changed");
    expect(poke.cursor).toBeGreaterThan(first.cursor);
    events.close();
  });

  it("does not poke other users", async () => {
    const alice = new Api(server.baseUrl);
    await alice.signUp(uniqueUsername("alice"));
    const bob = new Api(server.baseUrl);
    await bob.signUp(uniqueUsername("bob"));

    const events = await openEvents(alice);
    await events.next(); // initial
    const d = new Device(bob, "bob");
    d.createTask("Bob's");
    await d.sync();

    // Wait past a couple of heartbeats: only pings may arrive, never a poke.
    const raced = await Promise.race([
      events.next().then(() => "poked"),
      new Promise((r) => setTimeout(() => r("quiet"), 700)),
    ]);
    expect(raced).toBe("quiet");
    expect(events.pings()).toBeGreaterThan(0);
    events.close();
  });
});
