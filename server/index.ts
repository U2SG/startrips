import { serve } from "@hono/node-server";
import { app } from "./app";
import { serverConfig } from "./config";
import { pool } from "./db/client";
import { startMapStyleCacheSweeper } from "./routes/mapstyle";
import { startUploadReconciler } from "./routes/uploads";
import { startJourneyDeletionReconciler } from "./services/delete-journey";

startUploadReconciler();
startJourneyDeletionReconciler();
startMapStyleCacheSweeper();

const server = serve(
  {
    fetch: app.fetch,
    hostname: serverConfig.apiHost,
    port: serverConfig.apiPort,
  },
  (info) => {
    console.info(`Startrips API listening on ${info.address}:${info.port}`);
  },
);

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; draining connections`);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
