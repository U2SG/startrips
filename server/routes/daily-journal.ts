import { ShareIntentError } from "../intents/create-share-intent";
import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { parseJournalChapters } from "../../src/journey/dailyJournal";
import { applyJournalHotels, JournalWriteError, readDailyJournal, writeDailyJournal } from "../repositories/daily-journal-repository";
import { getJourneyForAtlas } from "../repositories/journey-repository";
import { createLocationSearch } from "../location/create-location-search";
import { proposeJournalHotels, signHotelPlan, verifyHotelPlan } from "../itinerary/journal-hotel-tools";
import { readJsonObject } from "./json-body";
import { serverConfig } from "../config";
import { suggestJournalReading } from "../itinerary/daily-journal-recognition";
import { configuredJournalModel, journalProviderInfo } from "../itinerary/journal-model";

export const dailyJournalRoutes = new Hono();
const hotelSearch = createLocationSearch({ driver: serverConfig.locationSearchDriver, baseUrl: serverConfig.locationSearchBaseUrl, userAgent: serverConfig.locationSearchUserAgent, fallbackBaseUrl: serverConfig.locationSearchFallbackBaseUrl });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
dailyJournalRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  await next();
});
dailyJournalRoutes.get("/:id/journal", async (c) => {
  const { atlas } = await requireAtlasAccess(c.req.raw, "read");
  if (!uuid.test(c.req.param("id"))) return c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  const journal = await readDailyJournal(c.req.param("id"), atlas.id);
  return journal ? c.json({ journal }) : c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
});
dailyJournalRoutes.put("/:id/journal", async (c) => {
  if (c.req.header("origin") !== serverConfig.appOrigin) return c.json({ error: "JOURNAL_ORIGIN_REQUIRED" }, 403);
  const { atlas } = await requireAtlasAccess(c.req.raw, "update");
  if (!uuid.test(c.req.param("id"))) return c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  const body = await readJsonObject(() => c.req.json());
  const chapters = body && parseJournalChapters(body.chapters);
  if (!chapters || typeof body?.baseRevision !== "number" || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) return c.json({ error: "INVALID_JOURNAL" }, 400);
  try {
    const journal = await writeDailyJournal(c.req.param("id"), atlas.id, body.baseRevision, chapters);
    return journal ? c.json({ journal }) : c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  } catch (error) {
    if (error instanceof JournalWriteError) return c.json({ error: error.code }, error.status);
    throw error;
  }
});
dailyJournalRoutes.post("/:id/journal/suggest", async (c) => {
  if (c.req.header("origin") !== serverConfig.appOrigin) return c.json({ error: "JOURNAL_ORIGIN_REQUIRED" }, 403);
  const { atlas } = await requireAtlasAccess(c.req.raw, "update");
  if (!uuid.test(c.req.param("id")) || !await readDailyJournal(c.req.param("id"), atlas.id)) return c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  const body = await readJsonObject(() => c.req.json());
  const chapters = body && parseJournalChapters(body.chapters);
  if (!chapters) return c.json({ error: "INVALID_JOURNAL" }, 400);
  const suggestions = await suggestJournalReading(chapters, { ...configuredJournalModel(), signal: c.req.raw.signal });
  return c.json({ suggestions });
});

dailyJournalRoutes.post("/:id/journal/hotels/preview", async c => {
  if (c.req.header("origin") !== serverConfig.appOrigin) return c.json({ error: "JOURNAL_ORIGIN_REQUIRED" }, 403);
  const { atlas } = await requireAtlasAccess(c.req.raw, "update");
  if (!uuid.test(c.req.param("id"))) return c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  const journal = await readDailyJournal(c.req.param("id"), atlas.id);
  const journey = await getJourneyForAtlas(c.req.param("id"), atlas.id);
  if (!journal || !journey) return c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  const model = configuredJournalModel();
  const { baseUrl, model: modelName } = journalProviderInfo();
  const provider = { baseUrl, model: modelName };
  const checkCurrent = async () => {
    if (!journalProviderInfo().available || journalProviderInfo().baseUrl !== provider.baseUrl)
      throw new ShareIntentError("JOURNAL_PROVIDER_CHANGED", "Journal model changed during hotel staging", 409);
    const access = await requireAtlasAccess(c.req.raw, "update");
    const current = await readDailyJournal(journey.id, atlas.id);
    const currentJourney = await getJourneyForAtlas(journey.id, atlas.id);
    if (access.atlas.id !== atlas.id || !current || current.revision !== journal.revision || !currentJourney || currentJourney.revision !== journey.revision) throw new ShareIntentError("JOURNAL_CONFLICT", "Journal changed during hotel staging", 409);
  };
  const result = await proposeJournalHotels(journal, journey.routePoints, { ...model, checkCurrent }, hotelSearch, c.req.raw.signal);
  await checkCurrent();
  return c.json({ preview: { ...result, token: signHotelPlan({ atlasId: atlas.id, journeyId: journey.id, journalRevision: journal.revision,
    journeyRevision: journey.revision, provider, expires: Date.now() + 15 * 60_000, hotels: result.hotels }, serverConfig.authSecret) } });
});
dailyJournalRoutes.post("/:id/journal/hotels/apply", async c => {
  if (c.req.header("origin") !== serverConfig.appOrigin) return c.json({ error: "JOURNAL_ORIGIN_REQUIRED" }, 403);
  const { atlas } = await requireAtlasAccess(c.req.raw, "update");
  const body = await readJsonObject(() => c.req.json());
  const plan = verifyHotelPlan(body?.token, serverConfig.authSecret);
  if (!plan || body?.confirmed !== true) return c.json({ error: "HOTEL_CONFIRMATION_REQUIRED" }, 400);
  try {
    const journal = await applyJournalHotels(plan, atlas.id, c.req.param("id"));
    return journal ? c.json({ journal, journey: await getJourneyForAtlas(c.req.param("id"), atlas.id) }) : c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
  } catch (error) { if (error instanceof JournalWriteError) return c.json({ error: error.code }, error.status); throw error; }
});
