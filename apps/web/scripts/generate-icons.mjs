/**
 * Generates the PWA icons as PNGs with zero dependencies (zlib + a tiny
 * PNG encoder). Design: indigo tile with three stacked "priority cards".
 *
 *   node apps/web/scripts/generate-icons.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dirname, "..", "public", "icons");

// ── PNG encoding ──
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── drawing (unit square coordinates, 4x4 supersampling) ──
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const TOP = [99, 102, 241]; // #6366f1
const BOTTOM = [67, 56, 202]; // #4338ca
const WHITE = [255, 255, 255];
const ACCENT = [251, 191, 36]; // amber dot on the top card

/** Returns [r,g,b,a] for a point; `inset` shrinks content for maskable icons. */
function shade(x, y, { fullBleed, inset }) {
  const bg = fullBleed || inRoundRect(x, y, 0, 0, 1, 1, 0.22);
  if (!bg) return [0, 0, 0, 0];
  // map into content box
  const s = 1 - 2 * inset;
  const u = (x - inset) / s;
  const v = (y - inset) / s;
  const cards = [
    { y0: 0.24, x0: 0.2, x1: 0.8, alpha: 1 },
    { y0: 0.44, x0: 0.24, x1: 0.76, alpha: 0.82 },
    { y0: 0.64, x0: 0.28, x1: 0.72, alpha: 0.6 },
  ];
  let color = mix(TOP, BOTTOM, y);
  for (const [i, c] of cards.entries()) {
    if (inRoundRect(u, v, c.x0, c.y0, c.x1, c.y0 + 0.13, 0.04)) {
      color = mix(color, WHITE, c.alpha);
      if (i === 0 && (u - (c.x0 + 0.08)) ** 2 + (v - (c.y0 + 0.065)) ** 2 < 0.03 ** 2) color = ACCENT;
    }
  }
  return [...color, 255];
}

function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          acc[0] += c[0] * c[3];
          acc[1] += c[1] * c[3];
          acc[2] += c[2] * c[3];
          acc[3] += c[3];
        }
      const i = (py * size + px) * 4;
      const a = acc[3] / (SS * SS);
      buf[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      buf[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      buf[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      buf[i + 3] = Math.round(a);
    }
  }
  return png(size, buf);
}

const icons = [
  ["icon-192.png", 192, { fullBleed: false, inset: 0 }],
  ["icon-512.png", 512, { fullBleed: false, inset: 0 }],
  ["icon-maskable-512.png", 512, { fullBleed: true, inset: 0.1 }], // safe zone for Android shapes
  ["apple-touch-icon.png", 180, { fullBleed: true, inset: 0.04 }],
];
mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of icons) {
  const file = join(OUT, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, render(size, opts));
  console.log("wrote", file);
}
