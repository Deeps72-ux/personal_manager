/**
 * UUIDv7 (RFC 9562): 48-bit Unix-ms timestamp + version + random bits.
 *
 * Generated ON THE DEVICE so tasks/logs can be created offline on several
 * devices at once without ever colliding. The timestamp prefix makes ids
 * roughly sortable by creation time (good for SQLite indexes).
 *
 * `now` and `randomBytes` are injectable so tests are deterministic
 * (Dependency Inversion in miniature).
 */
export function uuidv7(
  now: number = Date.now(),
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(`timestamp out of range: ${now}`);
  }
  const rand = randomBytes(10);
  const b = new Uint8Array(16);

  // bytes 0-5: big-endian milliseconds
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = 0x70 | (rand[0]! & 0x0f); // version 7
  b[7] = rand[1]!;
  b[8] = 0x80 | (rand[2]! & 0x3f); // RFC variant (10xx)
  b.set(rand.subarray(3, 10), 9);

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}
