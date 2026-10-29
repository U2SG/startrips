import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { parseJournalChapters } from "../../src/journey/dailyJournal";
import { JournalWriteError, readDailyJournal, writeDailyJournal } from "../repositories/daily-journal-repository";
import { readJsonObject } from "./json-body";
import { serverConfig } from "../config";
import { suggestJournalReading } from "../itinerary/daily-journal-recognition";
import { ItineraryRecognitionUnavailableError } from "../itinerary/itinerary-recognition";

export const dailyJournalRoutes = new Hono();
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
  if (serverConfig.intentDriver !== "http-model" || !serverConfig.intentBaseUrl || !serverConfig.intentApiKey || !serverConfig.intentModel) throw new ItineraryRecognitionUnavailableError("手记 AI 需要现有 INTENT_* 标准模型通道；目前未配置，可继续手动编辑和保存。");
  const suggestions = await suggestJournalReading(chapters, {
    baseUrl: serverConfig.intentBaseUrl, apiKey: serverConfig.intentApiKey,
    model: serverConfig.intentModel, timeoutMs: serverConfig.intentTimeoutMs,
  });
  return c.json({ suggestions });
});
