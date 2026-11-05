/**
 * Non-persistence ports: anything the core needs from "the outside world".
 * Injecting them (instead of calling Date.now / crypto directly) keeps use
 * cases deterministic and testable.
 */

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  newId(): string;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(storedHash: string, password: string): Promise<boolean>;
}

/** Login tokens: random secret for the device, only a hash is stored. */
export interface TokenService {
  generate(): string;
  hash(token: string): string;
}

/** Tells connected devices "user X has new changes up to `cursor`". */
export interface ChangeNotifier {
  notify(userId: string, cursor: number): void;
}
