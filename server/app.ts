import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auth } from "./auth";
import { AtlasAccessError } from "./authorization/atlas-access";
import { atlasRoutes } from "./routes/atlases";
import { journeyRoutes } from "./routes/journeys";
import { locationRoutes } from "./routes/locations";
import { uploadRoutes } from "./routes/uploads";
import { LocationSearchUnavailableError } from "./location/location-search";
import { StorageUnavailableError } from "./storage/multipart-storage";

export const app = new Hono();

app.use(
  "/api/*",
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (context) => context.json({ error: "REQUEST_TOO_LARGE" }, 413),
  }),
);

app.get("/api/health", (context) =>
  context.json({ status: "ok" }),
);

app.on(["GET", "POST"], "/api/auth/*", (context) =>
  auth.handler(context.req.raw),
);

app.route("/api/atlases", atlasRoutes);
app.route("/api/journeys", journeyRoutes);
app.route("/api/locations", locationRoutes);
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
  console.error("API request failed", error.message);
  return context.json({ error: "Internal server error" }, 500);
});
