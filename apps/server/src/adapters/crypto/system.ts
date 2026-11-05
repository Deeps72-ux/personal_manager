import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "@pm/shared";
import type { Clock, IdGenerator, TokenService } from "../../ports/services.ts";

export class SystemClock implements Clock {
  nowMs() {
    return Date.now();
  }
}

export class UuidV7Generator implements IdGenerator {
  newId() {
    return uuidv7();
  }
}

/**
 * 256-bit random tokens. The server stores only SHA-256(token): a leaked
 * database cannot be used to log in. (A fast hash is fine here because the
 * token is random, unlike a password.)
 */
export class RandomTokenService implements TokenService {
  generate() {
    return randomBytes(32).toString("base64url");
  }

  hash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
}
