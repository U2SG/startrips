import { Hono, type Context } from "hono";
import {
  isAllowedOpenFreemapPath,
  readMapStyleAsset,
  readMapStyleSprite,
} from "../services/map-style-cache";

function respondWithMapAsset(context: Context, result: Awaited<ReturnType<typeof readMapStyleAsset>>) {
  if (!result.ok) {
    return context.json({ error: "MAP_STYLE_UNAVAILABLE", message: result.message }, 502);
  }
  return context.body(result.body, 200, {
    "content-type": result.contentType,
    "cache-control": `public, max-age=${result.maxAgeSeconds}`,
    "access-control-allow-origin": "*",
  });
}

export const mapStyleRoutes = new Hono();

mapStyleRoutes.get("/", async (context) => {
  const path = context.req.query("path")?.trim() ?? "";
  if (!isAllowedOpenFreemapPath(path)) {
    return context.json({ error: "INVALID_MAP_PATH" }, 400);
  }
  return respondWithMapAsset(context, await readMapStyleAsset(path));
});

mapStyleRoutes.get("/sprite/*", async (context) => {
  const rawPath = new URL(context.req.raw.url).pathname;
  const rest = rawPath.replace(/^\/api\/mapstyle\/sprite\//, "");
  if (!rest.startsWith("sprites/") || rest.includes("..") || rest.length > 200) {
    return context.json({ error: "INVALID_MAP_PATH" }, 400);
  }
  return respondWithMapAsset(context, await readMapStyleSprite(rest));
});
