import { uuidv7, type Change, type LogEntry, type NewChange, type Task } from "@pm/shared";
import { loadConfig, type Config } from "../src/config.ts";
import { buildContainer } from "../src/container.ts";
import type { Clock, PasswordHasher } from "../src/ports/services.ts";

/** A clock tests can move forward. */
export class FakeClock implements Clock {
  now = Date.UTC(2026, 10, 5, 12, 0, 0);
  nowMs() {
    return this.now;
  }
  advanceDays(days: number) {
    this.now += days * 24 * 60 * 60 * 1000;
  }
}

/** Instant, obviously-not-secure hasher so tests stay fast (Liskov: same port). */
export class PlainHasher implements PasswordHasher {
  async hash(password: string) {
    return `plain:${password}`;
  }
  async verify(stored: string, password: string) {
    return stored === `plain:${password}`;
  }
}

export function testContainer(overrides: Partial<Config> = {}) {
  const clock = new FakeClock();
  const config: Config = { ...loadConfig({}), dbPath: ":memory:", ...overrides };
  const c = buildContainer(config, { clock, hasher: new PlainHasher() });
  return { ...c, clock };
}

export async function newUser(c: ReturnType<typeof testContainer>, username = `u${Math.random().toString(36).slice(2, 10)}`) {
  const { user, token } = await c.useCases.signUp.execute({ username, password: "password123" });
  return { userId: user.id, token };
}

export const task = (title: string, extra: Partial<Task> = {}): Task => ({
  id: uuidv7(),
  title,
  description: null,
  dueDate: null,
  ...extra,
});

export const log = (day: string, seconds: number, taskTitle: string): LogEntry => ({ id: uuidv7(), day, seconds, taskTitle });

/** Build a Change without repeating `changeId` everywhere. */
export const ch = (c: NewChange): Change => ({ changeId: uuidv7(), ...c });
