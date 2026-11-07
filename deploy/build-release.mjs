#!/usr/bin/env node
/**
 * Builds a self-contained release in ./release:
 *
 *   release/server.mjs      the whole server in ONE file (no node_modules)
 *   release/migrations/     SQL migrations (read next to server.mjs)
 *   release/web/            the built PWA, served by the server at "/"
 *   release/backup.mjs      daily backup job
 *   release/VERSION         git commit + build time
 *
 * Usage: node deploy/build-release.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "release");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

console.log("• building the PWA");
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "-w", "@pm/web", "--silent"]);

console.log("• bundling the server");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run(npx, [
  "rolldown",
  "apps/server/src/main.ts",
  "--platform",
  "node",
  "--format",
  "esm",
  "--file",
  join(OUT, "server.mjs"),
  "--sourcemap",
]);

console.log("• copying migrations, web app, backup job");
cpSync(join(ROOT, "apps/server/src/adapters/sqlite/migrations"), join(OUT, "migrations"), { recursive: true });
cpSync(join(ROOT, "apps/web/dist"), join(OUT, "web"), { recursive: true });
cpSync(join(ROOT, "deploy/backup.mjs"), join(OUT, "backup.mjs"));

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString().trim();
  if (dirty) commit += "-dirty";
} catch {
  // not a git checkout
}
writeFileSync(join(OUT, "VERSION"), `${commit} built ${new Date().toISOString()}\n`);

for (const f of ["server.mjs", "migrations/001_init.sql", "web/index.html", "web/sw.js", "backup.mjs"]) {
  if (!existsSync(join(OUT, f))) throw new Error(`release is missing ${f}`);
}
console.log(`✓ release ready in ${OUT} (${commit})`);
