import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import type { PasswordHasher } from "../../ports/services.ts";

export interface Argon2Params {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

/** OWASP recommended minimum for Argon2id (19 MiB, 2 passes, 1 lane). */
export const OWASP_ARGON2: Argon2Params = { memoryKiB: 19_456, passes: 2, parallelism: 1 };

const TAG_LENGTH = 32;

function derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      "argon2id",
      { message: password, nonce: salt, parallelism: p.parallelism, tagLength: TAG_LENGTH, memory: p.memoryKiB, passes: p.passes },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

/**
 * Stores hashes in the standard PHC format:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 * Parameters live inside each hash, so they can be raised later without
 * breaking existing passwords.
 */
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly params: Argon2Params;

  constructor(params: Argon2Params = OWASP_ARGON2) {
    this.params = params;
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, this.params);
    const { memoryKiB: m, passes: t, parallelism: p } = this.params;
    return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(key)}`;
  }

  async verify(stored: string, password: string): Promise<boolean> {
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
    if (!match) return false;
    const [, m, t, p, salt, hash] = match;
    const expected = Buffer.from(hash!, "base64");
    const actual = await derive(password, Buffer.from(salt!, "base64"), {
      memoryKiB: Number(m),
      passes: Number(t),
      parallelism: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
