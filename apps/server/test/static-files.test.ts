import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testContainer } from "./helpers.ts";

function webDir() {
  const dir = mkdtempSync(join(tmpdir(), "pm-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dir, "sw.js"), "self.x=1");
  writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(tmpdir(), "pm-secret.txt"), "secret");
  return dir;
}

describe("serving the PWA", () => {
  const c = testContainer({ webDir: webDir() });
  const get = (path: string) => c.app.request(path);

  it("serves index.html at / with no-cache and a CSP", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await r.text()).toContain("<title>app</title>");
  });

  it("caches fingerprinted assets forever, but never the service worker", async () => {
    const asset = await get("/assets/index-abc123.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("javascript");
    const sw = await get("/sw.js");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect((await get("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json");
  });

  it("falls back to the app shell for routes, 404 for missing files", async () => {
    expect(await (await get("/log/2026-11-05")).text()).toContain("<title>app</title>");
    expect((await get("/assets/missing.js")).status).toBe(404);
  });

  it("never serves files outside the web directory", async () => {
    for (const p of ["/../pm-secret.txt", "/%2e%2e/pm-secret.txt", "/assets/..%2f..%2fpm-secret.txt"]) {
      const r = await get(p);
      expect(await r.text()).not.toContain("secret");
    }
  });

  it("does not shadow the API", async () => {
    expect(await (await get("/api/health")).json()).toEqual({ ok: true });
    expect((await get("/api/nope")).status).toBe(401);
  });

  it("is off when no web dir is configured", async () => {
    const dev = testContainer();
    expect((await dev.app.request("/")).status).toBe(404);
  });
});
