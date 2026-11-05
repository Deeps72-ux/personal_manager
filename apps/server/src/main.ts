/**
 * Process entry point: load config, build the container, listen, run
 * housekeeping, shut down cleanly on Ctrl-C / launchd stop.
 */
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { buildContainer } from "./container.ts";

const config = loadConfig();
const container = buildContainer(config);

const runCleanup = () =>
  container.useCases.cleanup
    .execute()
    .then((r) => r.changeLogRows + r.sessions > 0 && console.log("cleanup:", r))
    .catch((err) => console.error("cleanup failed:", err));
void runCleanup();
const cleanupTimer = setInterval(runCleanup, config.cleanupIntervalMs);

const server = serve({ fetch: container.app.fetch, hostname: config.host, port: config.port }, (info) => {
  // The black-box test harness reads this exact line to find the port.
  console.log(`listening on http://${info.address}:${info.port}`);
  console.log(`database: ${config.dbPath}`);
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  clearInterval(cleanupTimer);
  server.close(() => {
    container.close();
    process.exit(0);
  });
  // SSE connections stay open forever; cut them so close() can finish.
  if ("closeAllConnections" in server) server.closeAllConnections();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
