import { serve } from "@hono/node-server";
import { app } from "./app";
import { serverConfig } from "./config";
import { startUploadReconciler } from "./routes/uploads";

startUploadReconciler();

serve(
  {
    fetch: app.fetch,
    hostname: serverConfig.apiHost,
    port: serverConfig.apiPort,
  },
  (info) => {
    console.info(`Startrips API listening on ${info.address}:${info.port}`);
  },
);
