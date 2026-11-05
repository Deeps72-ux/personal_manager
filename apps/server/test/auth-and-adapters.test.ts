import { describe, expect, it } from "vitest";
import { Argon2PasswordHasher } from "../src/adapters/crypto/argon2-password-hasher.ts";
import { RateLimiter } from "../src/adapters/http/rate-limiter.ts";
import { openDatabase, migrate } from "../src/adapters/sqlite/database.ts";
import { FakeClock, newUser, testContainer } from "./helpers.ts";

describe("auth use cases", () => {
  it("sign up, sign in, authenticate, sign out", async () => {
    const c = testContainer();
    const up = await c.useCases.signUp.execute({ username: "deepan", password: "password123" });
    const me = await c.useCases.authenticate.execute(up.token);
    expect(me).toEqual(up.user);

    const inn = await c.useCases.signIn.execute({ username: "deepan", password: "password123" });
    expect(inn.token).not.toBe(up.token); // each device gets its own session
    await c.useCases.signOut.execute(up.token);
    await expect(c.useCases.authenticate.execute(up.token)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(c.useCases.authenticate.execute(inn.token)).resolves.toEqual(up.user); // other device unaffected
  });

  it("rejects duplicate usernames and wrong passwords / unknown users the same way", async () => {
    const c = testContainer();
    await c.useCases.signUp.execute({ username: "deepan", password: "password123" });
    await expect(c.useCases.signUp.execute({ username: "deepan", password: "x".repeat(8) })).rejects.toMatchObject({
      code: "username_taken",
    });
    await expect(c.useCases.signIn.execute({ username: "deepan", password: "nope-nope" })).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await expect(c.useCases.signIn.execute({ username: "ghost", password: "nope-nope" })).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  it("sign-up can be disabled", async () => {
    const c = testContainer({ allowSignUp: false });
    await expect(c.useCases.signUp.execute({ username: "deepan", password: "password123" })).rejects.toMatchObject({
      code: "signup_disabled",
    });
  });

  it("sessions expire after the TTL, slide on use, and cleanup removes them", async () => {
    const c = testContainer({ sessionTtlDays: 10 });
    const { token } = await newUser(c);
    c.clock.advanceDays(9);
    await c.useCases.authenticate.execute(token); // slides expiry to day 19
    c.clock.advanceDays(9);
    await expect(c.useCases.authenticate.execute(token)).resolves.toBeTruthy(); // day 18: still valid
    c.clock.advanceDays(11);
    await expect(c.useCases.authenticate.execute(token)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await c.useCases.cleanup.execute()).sessions).toBe(1);
  });
});

describe("Argon2PasswordHasher", () => {
  const hasher = new Argon2PasswordHasher({ memoryKiB: 1024, passes: 1, parallelism: 1 }); // small for speed

  it("hashes in PHC format with a random salt and verifies", async () => {
    const a = await hasher.hash("correct horse");
    const b = await hasher.hash("correct horse");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    expect(a).not.toBe(b);
    expect(await hasher.verify(a, "correct horse")).toBe(true);
    expect(await hasher.verify(a, "correct horsE")).toBe(false);
    expect(await hasher.verify("garbage", "x")).toBe(false);
  });

  it("verifies hashes made with different parameters (upgradeable)", async () => {
    const strong = await new Argon2PasswordHasher().hash("pw-pw-pw-pw");
    expect(await hasher.verify(strong, "pw-pw-pw-pw")).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("allows max hits per window, then blocks until the window resets", () => {
    const clock = new FakeClock();
    const rl = new RateLimiter({ max: 2, windowMs: 60_000, clock });
    expect([rl.hit("k"), rl.hit("k"), rl.hit("k")]).toEqual([true, true, false]);
    expect(rl.hit("other")).toBe(true);
    clock.now += 60_000;
    expect(rl.hit("k")).toBe(true);
  });
});

describe("migrations", () => {
  it("are applied once and re-running is a no-op", () => {
    const db = openDatabase(":memory:");
    const version = () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version()).toBe(1);
    migrate(db);
    expect(version()).toBe(1);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(["change_log", "log_entries", "placements", "sessions", "sqlite_sequence", "tasks", "users"]);
  });
});
