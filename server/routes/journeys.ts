import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import {
  createJourneyForAtlas,
  getJourneyForAtlas,
  JourneyRouteChangedError,
  listJourneysForAtlas,
  restoreJourneyForAtlas,
  setJourneyCoverForAtlas,
  updateJourneyForAtlas,
  type JourneyValues,
} from "../repositories/journey-repository";
import { deleteJourneyWithStorage } from "../services/delete-journey";

const MAX_ROUTE_POINTS = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHT_EFFECT_IDS = new Set(["rainbow", "aurora", "sunset", "nebula"]);
export const JOURNEY_CACHE_CONTROL = "private, no-store, max-age=0";

type JourneyInput = {
  title?: unknown;
  startedOn?: unknown;
  endedOn?: unknown;
  note?: unknown;
  lightColor?: unknown;
  lightEffect?: unknown;
  revision?: unknown;
  routePoints?: unknown;
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

function coordinateValue(value: unknown, minimum: number, maximum: number) {
  if (
    (typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && !value.trim())
  ) {
    return null;
  }
  const coordinate = Number(value);
  return Number.isFinite(coordinate)
    && coordinate >= minimum
    && coordinate <= maximum
    ? coordinate
    : null;
}

export function parseJourneyInput(body: JourneyInput): JourneyValues | null {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const startedOn = typeof body.startedOn === "string" ? body.startedOn.trim() : "";
  const endedOn = body.endedOn === null || body.endedOn === ""
    ? null
    : typeof body.endedOn === "string"
      ? body.endedOn.trim()
      : "invalid";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const lightColor = typeof body.lightColor === "string"
    ? body.lightColor.trim()
    : "#f4ce73";
  const lightEffect = body.lightEffect === undefined || body.lightEffect === null || body.lightEffect === ""
    ? null
    : typeof body.lightEffect === "string" && LIGHT_EFFECT_IDS.has(body.lightEffect)
      ? body.lightEffect
      : undefined;
  const revision = body.revision === undefined
    ? undefined
    : typeof body.revision === "number"
      && Number.isSafeInteger(body.revision)
      && body.revision >= 1
      ? body.revision
      : null;
  if (
    !title
    || title.length > 80
    || !validDate(startedOn)
    || (endedOn !== null && !validDate(endedOn))
    || (endedOn !== null && endedOn < startedOn)
    || note.length > 2000
    || !/^#[0-9a-fA-F]{6}$/.test(lightColor)
    || (body.lightEffect !== undefined && lightEffect === undefined)
    || revision === null
    || !Array.isArray(body.routePoints)
    || body.routePoints.length < 1
    || body.routePoints.length > MAX_ROUTE_POINTS
  ) {
    return null;
  }

  let previousOccurredAt = "";
  const routePoints: JourneyValues["routePoints"] = [];
  for (const rawPoint of body.routePoints) {
    if (!rawPoint || typeof rawPoint !== "object") return null;
    const point = rawPoint as Record<string, unknown>;
    const id = point.id === undefined
      ? undefined
      : typeof point.id === "string" && UUID_PATTERN.test(point.id)
        ? point.id
        : null;
    const latitude = coordinateValue(point.latitude, -90, 90);
    const longitude = coordinateValue(point.longitude, -180, 180);
    const label = typeof point.label === "string" ? point.label.trim() : "";
    const isStop = point.isStop === true;
    const occurredAt = point.occurredAt === null || point.occurredAt === ""
      ? null
      : typeof point.occurredAt === "string"
        ? new Date(point.occurredAt)
        : new Date(Number.NaN);
    if (
      id === null
      || latitude === null
      || longitude === null
      || label.length > 120
      || (isStop && !label)
      || (occurredAt !== null && Number.isNaN(occurredAt.valueOf()))
    ) {
      return null;
    }
    if (occurredAt) {
      const canonical = occurredAt.toISOString();
      if (previousOccurredAt && canonical < previousOccurredAt) return null;
      previousOccurredAt = canonical;
    }
    routePoints.push({ id, latitude, longitude, label, isStop, occurredAt });
  }

  const persistedIds = routePoints.flatMap((point) => point.id ? [point.id] : []);
  if (new Set(persistedIds).size !== persistedIds.length) return null;

  return { title, startedOn, endedOn, note, lightColor, lightEffect, revision, routePoints };
}

export const journeyRoutes = new Hono();

journeyRoutes.get("/", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", JOURNEY_CACHE_CONTROL);
  return context.json({ journeys: await listJourneysForAtlas(atlas.id) });
});

journeyRoutes.get("/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", JOURNEY_CACHE_CONTROL);
  const journey = await getJourneyForAtlas(context.req.param("id"), atlas.id);
  if (!journey) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  return context.json({ journey });
});

journeyRoutes.post("/", async (context) => {
  const { atlas, session } = await requireAtlasAccess(context.req.raw, "create");
  const input = parseJourneyInput(await context.req.json<JourneyInput>());
  if (!input) {
    return context.json(
      { error: "INVALID_JOURNEY", message: "Invalid journey data" },
      400,
    );
  }
  if (input.revision !== undefined || input.routePoints.some((point) => point.id)) {
    return context.json(
      { error: "INVALID_JOURNEY", message: "New journey points cannot have ids" },
      400,
    );
  }
  const journey = await createJourneyForAtlas(atlas.id, session.user.id, input);
  if (!journey) return context.json({ error: "ATLAS_NOT_FOUND" }, 404);
  return context.json({ journey }, 201);
});

journeyRoutes.patch("/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const input = parseJourneyInput(await context.req.json<JourneyInput>());
  if (!input) {
    return context.json(
      { error: "INVALID_JOURNEY", message: "Invalid journey data" },
      400,
    );
  }
  let journey;
  try {
    journey = await updateJourneyForAtlas(context.req.param("id"), atlas.id, input);
  } catch (error) {
    if (error instanceof JourneyRouteChangedError) {
      return context.json(
        { error: "JOURNEY_ROUTE_CHANGED", message: "Journey route changed; reopen it before saving" },
        409,
      );
    }
    throw error;
  }
  if (!journey) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  return context.json({ journey });
});

journeyRoutes.delete("/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "delete");
  const journey = await deleteJourneyWithStorage(context.req.param("id"), atlas.id);
  if (!journey) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  return context.body(null, 204);
});

journeyRoutes.post("/:id/restore", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "delete");
  const journey = await restoreJourneyForAtlas(context.req.param("id"), atlas.id);
  if (!journey) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  return context.json({ journey });
});

// #14: set or clear the journey's explicit cover media. A dedicated lightweight
// endpoint avoids overwriting any other journey field through the full update.
journeyRoutes.patch("/:id/cover", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const body = await context.req.json<{ coverMediaAssetId?: unknown }>();
  const coverMediaAssetId = body.coverMediaAssetId === null
    || body.coverMediaAssetId === undefined
    ? null
    : typeof body.coverMediaAssetId === "string" && UUID_PATTERN.test(body.coverMediaAssetId)
      ? body.coverMediaAssetId
      : "invalid";
  if (coverMediaAssetId === "invalid") {
    return context.json(
      { error: "INVALID_COVER", message: "Invalid cover media asset" },
      400,
    );
  }
  const journey = await setJourneyCoverForAtlas(
    context.req.param("id"),
    atlas.id,
    coverMediaAssetId,
  );
  if (!journey) return context.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  return context.json({ journey });
});
