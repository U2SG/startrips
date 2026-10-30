import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { readJsonObject } from "./json-body";
import { prepareAuthorizedJournalImport } from "../itinerary/journal-import-service";
import { hash } from "../admin/journal-import";

/** One-sentence + attached source entry point, with the same use-case as offline administration. */
export const journalImportIntentRoutes = new Hono();
journalImportIntentRoutes.post("/journal-import", async c => {
  c.header("Cache-Control", "private, no-store");
  if (c.req.header("origin") !== serverConfig.appOrigin) return c.json({ error: "JOURNAL_ORIGIN_REQUIRED" }, 403);
  const { atlas, session } = await requireAtlasAccess(c.req.raw, "update");
  const body = await readJsonObject(() => c.req.json());
  if (!body || typeof body.journeyId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.journeyId)
    || typeof body.sentence !== "string" || typeof body.source !== "string" || typeof body.fallbackDate !== "string") return c.json({ error: "INVALID_IMPORT" }, 400);
  try {
  const envelope = await prepareAuthorizedJournalImport({ userId: session.user.id, email: session.user.email, atlasId: atlas.id, journeyId: body.journeyId },
    { sentence: body.sentence, source: body.source, fallbackDate: body.fallbackDate, provider: body.provider });
  return c.json({ intent: "journal-import", stage: "journal-preview", envelope, planDigest: hash(envelope),
    next: { journal: `/api/journeys/${body.journeyId}/journal`, hotels: `/api/journeys/${body.journeyId}/journal/hotels/preview` } });
  } catch (error) {
    if (error instanceof Error && ["TARGET_NOT_FOUND", "TARGET_PERMISSION_DENIED", "INVALID_TARGET"].includes(error.message)) return c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
    throw error;
  }
});
