import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RoutingWorker } from "../routing/github-worker";

/** One callback carries one item: three 4,000-point candidates fit comfortably. */
export const ROUTING_WORKER_RESULTS_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Machine callback of the GitHub Actions routing worker. Authenticated only by
 * the HMAC over the raw body (no session, no Atlas). Without a configured
 * worker it does not exist.
 */
export function createRoutingWorkerRoutes(worker: Pick<RoutingWorker, "receive"> | null) {
  const routes = new Hono();
  routes.post(
    "/results",
    bodyLimit({
      maxSize: ROUTING_WORKER_RESULTS_MAX_BYTES,
      onError: (context) => context.json({ error: "REQUEST_TOO_LARGE" }, 413),
    }),
    async (context) => {
      if (!worker) return context.json({ error: "Not found" }, 404);
      const raw = new Uint8Array(await context.req.arrayBuffer());
      const { status, body } = worker.receive(raw, context.req.header("X-Startrips-Signature"));
      context.header("Cache-Control", "no-store");
      return context.json(body, status);
    },
  );
  return routes;
}
