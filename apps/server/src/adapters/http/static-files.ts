/**
 * Serves the built PWA (apps/web/dist) from the same origin as /api, so the
 * app and its data share one URL (required for the PWA + offline storage).
 *
 * Cache rules matter for updates:
 *   /assets/*  → fingerprinted file names → cache forever
 *   everything else (index.html, sw.js, manifest, icons) → revalidate
 *              so a new release is picked up on the next visit.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Same-origin only. 'unsafe-inline' for styles is needed by React's style
 * attributes (card colours, drag transforms); scripts stay 'self' only.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function staticFiles(root: string) {
  const base = normalize(root + sep);

  async function file(path: string): Promise<{ body: Buffer; type: string } | null> {
    // Resolve inside root only: "/../../etc/passwd" can never escape.
    const full = normalize(join(base, decodeURIComponent(path)));
    if (!full.startsWith(base)) return null;
    try {
      if (!(await stat(full)).isFile()) return null;
      return { body: await readFile(full), type: TYPES[extname(full)] ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }

  return async (c: Context) => {
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    let f = await file(path);
    let isIndex = path === "/index.html";
    // Client-side routes fall back to the app shell; missing assets are real 404s.
    if (!f && !extname(path)) {
      f = await file("/index.html");
      isIndex = true;
    }
    if (!f) return c.text("Not found", 404);

    c.header("content-type", f.type);
    c.header(
      "cache-control",
      path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
    if (isIndex) c.header("content-security-policy", CSP);
    if (path === "/sw.js") c.header("service-worker-allowed", "/");
    return c.body(new Uint8Array(f.body));
  };
}
