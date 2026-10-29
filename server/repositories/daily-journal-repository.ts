import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { atlases, journeys, journeyJournals, journeyRoutePoints, mediaAssets } from "../db/app-schema";
import { lockActiveAtlas, lockActiveJourney } from "./journey-repository";
import { EMPTY_JOURNAL, type DailyJournal, type JournalChapter } from "../../src/journey/dailyJournal";

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
    // A replay is harmless even after a lost response. Compare before the stale revision guard.
    if (isDeepStrictEqual(previous?.chapters ?? [], chapters)) return { revision: previous?.revision ?? 0, chapters };
    if ((previous?.revision ?? 0) !== baseRevision) throw new JournalWriteError("JOURNAL_CHANGED", 409);
    const points = await tx.select({ id: journeyRoutePoints.id }).from(journeyRoutePoints).where(eq(journeyRoutePoints.journeyId, journeyId));
    const media = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.journeyId, journeyId));
    const pointIds = new Set(points.map((p) => p.id));
    const mediaIds = new Set(media.map((m) => m.id));
    if (chapters.some((c) => c.events.some((e) => (e.routePointId !== null && !pointIds.has(e.routePointId)) || e.mediaIds.some((id) => !mediaIds.has(id))))) {
      throw new JournalWriteError("JOURNAL_FOREIGN_REFERENCE", 400);
    }
    // Existing raw evidence is immutable; deleting a chapter is explicit in the editor.
    for (const chapter of chapters) {
      const old = previous?.chapters.find((c) => c.id === chapter.id);
      if (old && (old.source !== chapter.source || chapter.events.some((e) => {
        const prior = old.events.find((p) => p.id === e.id); return prior && prior.source !== e.source;
      }))) throw new JournalWriteError("JOURNAL_SOURCE_CHANGED", 400);
    }
    const revision = baseRevision + 1;
    await tx.insert(journeyJournals).values({ journeyId, revision, chapters }).onConflictDoUpdate({ target: journeyJournals.journeyId, set: { revision, chapters } });
    return { revision, chapters };
  });
}
