import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import {
  createHomeBasePeriodForAtlas,
  deleteHomeBasePeriodForAtlas,
  listHomeBasePeriodsForAtlas,
  updateHomeBasePeriodForAtlas,
  type HomeBasePeriodPatch,
  type HomeBasePeriodValues,
} from "../repositories/home-base-repository";
import { isPersistedCalendarDate } from "../../src/journey/calendarDate";
import { isHomeBaseSource } from "../../src/journey/homeBase";
import { readJsonObject } from "./json-body";

/**
 * #231: the owner/member-authorized Home Base surface.
 *
 * A dedicated route module at the HTTP level, but Atlas-owned domain data
 * underneath: the Atlas comes only from `requireAtlasAccess`, i.e. from the
 * authenticated session's active Organization. There is deliberately no
 * `/api/atlases/:atlasId/home-bases` and no global `user.home`, and an
 * `atlasId` or `organizationId` in a request body is not read by anything
 * here — the parsers below name every field they accept.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LABEL_LENGTH = 120;
export const HOME_BASE_CACHE_CONTROL = "private, no-store, max-age=0";

type HomeBaseInput = {
  label?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  startedOn?: unknown;
  endedOn?: unknown;
  source?: unknown;
};

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

/**
 * The create body. `startedOn` is required: an approximate month may be
 * normalised into a date by the caller, but an omitted start would have to
 * mean "valid from the infinite past", which V1 refuses to store.
 *
 * Whether the dates form a coherent history is NOT decided here. End before
 * start, an overlap and a second current Home are statements about the
 * recorded timeline, not about this document's syntax, so all three are
 * answered by the repository's 409 rather than by a 400 that would tell a
 * client its body was malformed.
 */
export function parseHomeBaseInput(body: HomeBaseInput): HomeBasePeriodValues | null {
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const latitude = coordinateValue(body.latitude, -90, 90);
  const longitude = coordinateValue(body.longitude, -180, 180);
  const startedOn = typeof body.startedOn === "string" ? body.startedOn.trim() : "";
  const endedOn = body.endedOn === undefined || body.endedOn === null || body.endedOn === ""
    ? null
    : typeof body.endedOn === "string"
      ? body.endedOn.trim()
      : "invalid";
  const source = body.source === undefined ? "manual" : body.source;
  if (
    !label
    || label.length > MAX_LABEL_LENGTH
    || latitude === null
    || longitude === null
    || !isPersistedCalendarDate(startedOn)
    || endedOn === "invalid"
    || (endedOn !== null && !isPersistedCalendarDate(endedOn))
    || !isHomeBaseSource(source)
  ) {
    return null;
  }
  return { label, latitude, longitude, startedOn, endedOn, source };
}

/**
 * The correction body. Every field is optional, an absent key leaves the
 * stored value alone, and an explicit `endedOn: null` reopens the period as
 * the current one. An empty document changes nothing and is refused so a
 * caller cannot mistake a no-op for a saved edit.
 */
export function parseHomeBasePatch(body: HomeBaseInput): HomeBasePeriodPatch | null {
  const patch: HomeBasePeriodPatch = {};
  if (body.label !== undefined) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > MAX_LABEL_LENGTH) return null;
    patch.label = label;
  }
  if (body.latitude !== undefined) {
    const latitude = coordinateValue(body.latitude, -90, 90);
    if (latitude === null) return null;
    patch.latitude = latitude;
  }
  if (body.longitude !== undefined) {
    const longitude = coordinateValue(body.longitude, -180, 180);
    if (longitude === null) return null;
    patch.longitude = longitude;
  }
  if (body.startedOn !== undefined) {
    const startedOn = typeof body.startedOn === "string" ? body.startedOn.trim() : "";
    if (!isPersistedCalendarDate(startedOn)) return null;
    patch.startedOn = startedOn;
  }
  if (body.endedOn !== undefined) {
    if (body.endedOn === null || body.endedOn === "") {
      patch.endedOn = null;
    } else {
      const endedOn = typeof body.endedOn === "string" ? body.endedOn.trim() : "";
      if (!isPersistedCalendarDate(endedOn)) return null;
      patch.endedOn = endedOn;
    }
  }
  if (body.source !== undefined) {
    if (!isHomeBaseSource(body.source)) return null;
    patch.source = body.source;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export const homeBaseRoutes = new Hono();

homeBaseRoutes.get("/", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  context.header("Cache-Control", HOME_BASE_CACHE_CONTROL);
  return context.json({ periods: await listHomeBasePeriodsForAtlas(atlas.id) });
});

homeBaseRoutes.post("/", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  const body = await readJsonObject(() => context.req.json());
  const input = body && parseHomeBaseInput(body);
  if (!input) {
    return context.json(
      { error: "INVALID_HOME_BASE", message: "Invalid Home Base period data" },
      400,
    );
  }
  const period = await createHomeBasePeriodForAtlas(atlas.id, input);
  if (!period) return context.json({ error: "ATLAS_NOT_FOUND" }, 404);
  context.header("Cache-Control", HOME_BASE_CACHE_CONTROL);
  return context.json({ period }, 201);
});

homeBaseRoutes.patch("/:periodId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const periodId = context.req.param("periodId");
  const body = await readJsonObject(() => context.req.json());
  const patch = body && parseHomeBasePatch(body);
  if (!patch) {
    return context.json(
      { error: "INVALID_HOME_BASE", message: "Invalid Home Base period data" },
      400,
    );
  }
  // A malformed id is answered like an unknown one: a period this Atlas does
  // not own is never distinguishable from one that does not exist.
  if (!UUID_PATTERN.test(periodId)) {
    return context.json({ error: "HOME_BASE_PERIOD_NOT_FOUND" }, 404);
  }
  const period = await updateHomeBasePeriodForAtlas(atlas.id, periodId, patch);
  if (!period) return context.json({ error: "HOME_BASE_PERIOD_NOT_FOUND" }, 404);
  context.header("Cache-Control", HOME_BASE_CACHE_CONTROL);
  return context.json({ period });
});

/**
 * `update`, not `delete`, for the same reason `shares.ts` revokes a link under
 * `update`: `delete` is owner-only in `permissions.ts`, and #231 makes Home
 * Base member-confirmed and its manual editing explicitly include removing a
 * period. Requiring the owner-only action would let a member record a mistaken
 * period and correct every field of it while being unable to withdraw it.
 *
 * Removing a period is also not destructive in the sense that action names:
 * this table is referenced by no Journey, route point or media row, so a
 * removal deletes a statement about where the member lived and nothing else.
 */
homeBaseRoutes.delete("/:periodId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const periodId = context.req.param("periodId");
  if (!UUID_PATTERN.test(periodId)) {
    return context.json({ error: "HOME_BASE_PERIOD_NOT_FOUND" }, 404);
  }
  const deleted = await deleteHomeBasePeriodForAtlas(atlas.id, periodId);
  if (!deleted) return context.json({ error: "HOME_BASE_PERIOD_NOT_FOUND" }, 404);
  return context.body(null, 204);
});
