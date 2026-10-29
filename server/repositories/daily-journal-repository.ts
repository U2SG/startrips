import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { atlases, journeys, journeyJournals, journeyRoutePoints, mediaAssets } from "../db/app-schema";
import { lockActiveAtlas, lockActiveJourney } from "./journey-repository";
import { EMPTY_JOURNAL, type DailyJournal, type JournalChapter } from "../../src/journey/dailyJournal";
import { sameHotel, type HotelPlan } from "../itinerary/journal-hotel-tools";
import { hasExplicitHotelStay } from "../../src/journey/journalHotels";

/** Confirmed, server-signed plan; one transaction for both route and journal. */
export async function applyJournalHotels(plan: HotelPlan, atlasId: string, journeyId: string) {
  if (plan.atlasId !== atlasId || plan.journeyId !== journeyId) return null;
  return db.transaction(async tx => {
    if (!await lockActiveAtlas(tx, atlasId) || !await lockActiveJourney(tx, journeyId, atlasId)) return null;
    const [journal] = await tx.select().from(journeyJournals).where(eq(journeyJournals.journeyId, journeyId));
    const [journey] = await tx.select().from(journeys).where(eq(journeys.id, journeyId));
    const digest = createHash("sha256").update(JSON.stringify({ hotelPlan: plan })).digest("hex");
    if (journal?.lastWriteDigest === digest) return { revision: journal.revision, chapters: journal.chapters };
    if (!journal || journal.revision !== plan.journalRevision || journey.revision !== plan.journeyRevision) throw new JournalWriteError("JOURNAL_CHANGED", 409);
    const points = await tx.select().from(journeyRoutePoints).where(eq(journeyRoutePoints.journeyId, journeyId));
    const chapters = structuredClone(journal.chapters);
    const events = chapters.flatMap(c => c.events);
    let sortOrder = points.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;
    let created = false;
    // Iterate source events, not model-returned order; never sort wall clock times.
    for (const event of events) {
      const hotel = plan.hotels.find(h => h.eventId === event.id);
      if (!hotel) continue;
      if (event.routePointId || !["actual", "uncertain"].includes(event.status) || event.source !== hotel.evidence || !hasExplicitHotelStay(event.source, hotel.label)) throw new JournalWriteError("JOURNAL_CHANGED", 409);
      const matches = points.filter(p => sameHotel(p, hotel));
      if (matches.length > 1 || (hotel.existingPointId && matches[0]?.id !== hotel.existingPointId)) throw new JournalWriteError("JOURNAL_CHANGED", 409);
      let point = matches[0];
      if (!point) {
        if (points.length >= 200) throw new JournalWriteError("HOTEL_POINT_LIMIT", 400);
        [point] = await tx.insert(journeyRoutePoints).values({ id: randomUUID(), journeyId, sortOrder: sortOrder++, label: hotel.label,
          latitude: hotel.latitude, longitude: hotel.longitude, regionContext: hotel.context, placeRole: "accommodation", isStop: true, occurredAt: null }).returning();
        points.push(point); created = true;
      }
      event.routePointId = point.id; event.status = "actual";
    }
    if (created) await tx.update(journeys).set({ revision: journey.revision + 1, updatedAt: new Date() }).where(eq(journeys.id, journeyId));
    if (!plan.hotels.length) return { revision: journal.revision, chapters };
    const revision = journal.revision + 1;
    await tx.update(journeyJournals).set({ revision, chapters, lastWriteDigest: digest }).where(eq(journeyJournals.journeyId, journeyId));
    return { revision, chapters };
  });
}

export class JournalWriteError extends Error {
  constructor(public code: string, public status: 400 | 409) { super(code); }
}
export async function readDailyJournal(journeyId: string, atlasId: string): Promise<DailyJournal | null> {
  const [owner] = await db.select({ id: journeys.id }).from(journeys).innerJoin(atlases, eq(journeys.atlasId, atlases.id))
    .where(and(eq(journeys.id, journeyId), eq(journeys.atlasId, atlasId), isNull(journeys.deletionStartedAt), isNull(atlases.deletionStartedAt)));
  if (!owner) return null;
  const [row] = await db.select().from(journeyJournals).where(eq(journeyJournals.journeyId, journeyId));
  return row ? { revision: row.revision, chapters: row.chapters } : EMPTY_JOURNAL;
}
export async function writeDailyJournal(journeyId: string, atlasId: string, baseRevision: number, chapters: JournalChapter[]): Promise<DailyJournal | null> {
  return db.transaction(async (tx) => {
    if (!await lockActiveAtlas(tx, atlasId) || !await lockActiveJourney(tx, journeyId, atlasId)) return null;
    const [previous] = await tx.select().from(journeyJournals).where(eq(journeyJournals.journeyId, journeyId));
    const digest = createHash("sha256").update(JSON.stringify({ baseRevision, chapters })).digest("hex");
    // Recognize the exact last accepted request, including any server-side cleanup.
    if (previous?.lastWriteDigest === digest) return { revision: previous.revision, chapters: previous.chapters };
    const points = await tx.select({ id: journeyRoutePoints.id }).from(journeyRoutePoints).where(eq(journeyRoutePoints.journeyId, journeyId));
    const media = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.journeyId, journeyId));
    const pointIds = new Set(points.map((p) => p.id));
    const mediaIds = new Set(media.map((m) => m.id));
    const previousEvents = new Map(previous?.chapters.flatMap((c) => c.events.map((e) => [e.id, e] as const)) ?? []);
    // Deleted/moved references that this exact event already held may be cleared.
    // A newly supplied foreign reference still cannot acquire authority here.
    const cleaned = chapters.map((c) => ({ ...c, events: c.events.map((event) => {
      const prior = previousEvents.get(event.id);
      if (prior && prior.source !== event.source) throw new JournalWriteError("JOURNAL_SOURCE_CHANGED", 400);
      if ((event.routePointId && !pointIds.has(event.routePointId) && prior?.routePointId !== event.routePointId)
        || event.mediaIds.some((id) => !mediaIds.has(id) && !prior?.mediaIds.includes(id))) {
        throw new JournalWriteError("JOURNAL_FOREIGN_REFERENCE", 400);
      }
      return { ...event, routePointId: event.routePointId && pointIds.has(event.routePointId) ? event.routePointId : null,
        mediaIds: event.mediaIds.filter((id) => mediaIds.has(id)) };
    }) }));
    if (isDeepStrictEqual(previous?.chapters ?? [], cleaned)) return { revision: previous?.revision ?? 0, chapters: cleaned };
    if ((previous?.revision ?? 0) !== baseRevision) throw new JournalWriteError("JOURNAL_CHANGED", 409);
    // Existing raw evidence is immutable; deleting a chapter is explicit in the editor.
    for (const chapter of chapters) {
      const old = previous?.chapters.find((c) => c.id === chapter.id);
      if (old && (old.source !== chapter.source || old.importDate !== chapter.importDate || chapter.events.some((e) => {
        const prior = old.events.find((p) => p.id === e.id); return prior && prior.source !== e.source;
      }))) throw new JournalWriteError("JOURNAL_SOURCE_CHANGED", 400);
    }
    const revision = baseRevision + 1;
    await tx.insert(journeyJournals).values({ journeyId, revision, chapters: cleaned, lastWriteDigest: digest }).onConflictDoUpdate({ target: journeyJournals.journeyId, set: { revision, chapters: cleaned, lastWriteDigest: digest } });
    return { revision, chapters: cleaned };
  });
}
