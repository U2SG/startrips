import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import { auth } from "./auth";
import { AtlasAccessError } from "./authorization/atlas-access";
import { serverConfig } from "./config";
import { db } from "./db/client";
import { LocationSearchUnavailableError } from "./location/location-search";
import { createAnonymousRateLimiter } from "./rate-limit";
import { atlasRoutes } from "./routes/atlases";
import { journeyRoutes } from "./routes/journeys";
import { locationRoutes } from "./routes/locations";
import { mapStyleRoutes } from "./routes/mapstyle";
import { uploadRoutes } from "./routes/uploads";
import { StorageUnavailableError } from "./storage/multipart-storage";

export const app = new Hono();

app.use("*", async (context, next) => {
  const started = performance.now();
  let failed = false;
  try {
    await next();
  } catch (error) {
    failed = true;
    console.error(
      `${context.req.method} ${context.req.path} failed`,
      error instanceof Error ? error.message : "unknown error",
    );
    throw error;
  } finally {
    if (!failed) {
      console.info(
        `${context.req.method} ${context.req.path} ${context.res.status} `
        + `${Math.round(performance.now() - started)}ms`,
      );
    }
  }
});

app.use(
  "/api/*",
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (context) => context.json({ error: "REQUEST_TOO_LARGE" }, 413),
  }),
);

app.use(
  "/api/*",
  createAnonymousRateLimiter({
    windowSeconds: serverConfig.anonymousRateLimitWindowSeconds,
    maxRequests: serverConfig.anonymousRateLimitMaxRequests,
  }),
);

app.get("/api/health", async (context) => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return context.json(
      { status: "unavailable", database: "unreachable" },
      503,
    );
  }
  return context.json({ status: "ok" });
});

app.on(["GET", "POST"], "/api/auth/*", (context) =>
  auth.handler(context.req.raw),
);

app.route("/api/atlases", atlasRoutes);
app.route("/api/journeys", journeyRoutes);
app.route("/api/locations", locationRoutes);
app.route("/api/mapstyle", mapStyleRoutes);
app.route("/api/uploads", uploadRoutes);

app.notFound((context) =>
  context.json({ error: "Not found" }, 404),
);

app.onError((error, context) => {
  if (error instanceof AtlasAccessError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status,
    );
  }
  if (error instanceof StorageUnavailableError) {
    return context.json(
      { error: "STORAGE_UNAVAILABLE", message: error.message },
      503,
    );
  }
  if (error instanceof LocationSearchUnavailableError) {
    return context.json(
      { error: "LOCATION_SEARCH_UNAVAILABLE", message: error.message },
      503,
    );
  }
  if (error instanceof SyntaxError) {
    return context.json(
      { error: "INVALID_JSON", message: "Request body is not valid JSON" },
      400,
    );
  }
  console.error("API request failed", error.message);
  return context.json({ error: "Internal server error" }, 500);
});
