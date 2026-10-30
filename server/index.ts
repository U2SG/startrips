import { startJournalImportWorker } from "./itinerary/journal-import-jobs";
import { serve } from "@hono/node-server";
import { app } from "./app";
import { serverConfig } from "./config";
import { pool } from "./db/client";
import { startMapStyleCacheSweeper } from "./services/map-style-cache";
import { startUploadReconciler } from "./services/multipart-uploads";
import { startCoverRevealReconciler } from "./services/cover-reveal";
import { startJourneyDeletionReconciler } from "./services/delete-journey";
import { startPreviewReconciler } from "./services/media-preview";
import { startPreviewBackfill } from "./services/media-preview-backfill";
import { startRouteSnappingReconciler } from "./services/route-snapping";

startUploadReconciler();
startJourneyDeletionReconciler();
startPreviewReconciler();
startPreviewBackfill();
startCoverRevealReconciler();
startMapStyleCacheSweeper();
const journalImports = startJournalImportWorker();
const routeSnapping = startRouteSnappingReconciler();

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
  // Abort the in-flight snapping step and let it settle before the pool closes.
  const snappingDrained = Promise.all([routeSnapping.stop(), journalImports.stop()]);
  server.close(() => {
    void snappingDrained.then(() => pool.end()).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
