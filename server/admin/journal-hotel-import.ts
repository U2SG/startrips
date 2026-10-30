import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { journeyJournals } from "../db/app-schema";
import { serverConfig } from "../config";
import { getJourneyForAtlas } from "../repositories/journey-repository";
import { applyJournalHotels } from "../repositories/daily-journal-repository";
import { proposeJournalHotels, signHotelPlan, verifyHotelPlan, type HotelPlan } from "../itinerary/journal-hotel-tools";
import { journalImportModel } from "../itinerary/journal-import-service";
import { createLocationSearch } from "../location/create-location-search";
import type { LocationSearch } from "../location/location-search";
import type { IntentModelOptions } from "../intents/intent-model-request";
import { hash, lockedTarget, validateEnvelope, type Target } from "./journal-import";
import type { DailyJournal } from "../../src/journey/dailyJournal";

type HotelCheckpoint = { version: 2; target: Target; journalPlanDigest: string; token: string; before: DailyJournal;
  journeyBefore: Pick<NonNullable<Awaited<ReturnType<typeof getJourneyForAtlas>>>, "id" | "atlasId" | "revision" | "routePoints" | "startedOn" | "endedOn">; questions: string[] };
export type HotelEnvelope = { checkpoint: HotelCheckpoint; signature: string };
const sign = (checkpoint: HotelCheckpoint) => createHmac("sha256", serverConfig.authSecret).update(JSON.stringify(checkpoint)).digest("hex");
const fail = (code: string): never => { throw new Error(code); };
export async function previewImportedHotels(value: unknown, provider: unknown, dependencies?: { model: IntentModelOptions; search: LocationSearch }): Promise<HotelEnvelope> {
  const e = validateEnvelope(value);
  const before = await db.transaction(tx => lockedTarget(tx, e.plan.target));
  if (hash(before) !== hash(e.plan.after)) return fail("JOURNAL_STAGE_NOT_CURRENT");
  const journey = await getJourneyForAtlas(e.plan.target.journeyId, e.plan.target.atlasId);
  if (!journey) return fail("TARGET_NOT_FOUND");
  const search = dependencies?.search ?? createLocationSearch({ driver: serverConfig.locationSearchDriver, baseUrl: serverConfig.locationSearchBaseUrl,
    userAgent: serverConfig.locationSearchUserAgent, fallbackBaseUrl: serverConfig.locationSearchFallbackBaseUrl });
  const model = dependencies?.model ?? journalImportModel(provider);
  if (!e.plan.provider) return fail("JOURNAL_PROVIDER_CHANGED");
  if(e.plan.provider.baseUrl.startsWith("provider:")) {
    const bound=journalImportModel(e.plan.provider);
    if(bound.baseUrl!==model.baseUrl||bound.model!==model.model)return fail("JOURNAL_PROVIDER_CHANGED");
  } else if(e.plan.provider.baseUrl!==model.baseUrl||e.plan.provider.model!==model.model)return fail("JOURNAL_PROVIDER_CHANGED");
  const scoped = { ...before, chapters: before.chapters.filter(c => e.plan.importedChapterIds.includes(c.id)) };
  const result = await proposeJournalHotels(scoped, journey.routePoints, model, search);
  const token = signHotelPlan({ atlasId: e.plan.target.atlasId, journeyId: journey.id, journalRevision: before.revision,
    journeyRevision: journey.revision, expires: Date.now() + 15 * 60_000, hotels: result.hotels }, serverConfig.authSecret);
  const checkpoint: HotelCheckpoint = { version: 2, target: e.plan.target, journalPlanDigest: hash(e), token, before,
    journeyBefore: JSON.parse(JSON.stringify({ id: journey.id, atlasId: journey.atlasId, revision: journey.revision, routePoints: journey.routePoints, startedOn: journey.startedOn, endedOn: journey.endedOn })), questions: result.questions };
  return { checkpoint, signature: sign(checkpoint) };
}
export async function applyImportedHotels(value: unknown, expectedDigest: string, backup: (e: HotelEnvelope) => Promise<void>) {
  const e = value as HotelEnvelope;
  if (!e?.checkpoint || e.checkpoint.version !== 2 || typeof e.signature !== "string" || !/^[a-f0-9]{64}$/.test(e.signature)
    || !timingSafeEqual(Buffer.from(e.signature, "hex"), Buffer.from(sign(e.checkpoint), "hex")) || hash(e) !== expectedDigest) return fail("INVALID_HOTEL_CHECKPOINT");
  // Outer signature authenticates the stored token even after expiry, for receipt lookup ONLY.
  let plan: HotelPlan;
  try { plan = JSON.parse(Buffer.from(e.checkpoint.token.split(".")[0], "base64url").toString("utf8")); } catch { return fail("INVALID_HOTEL_CHECKPOINT"); }
  const { target } = e.checkpoint;
  if (plan.atlasId !== target.atlasId || plan.journeyId !== target.journeyId) return fail("INVALID_HOTEL_CHECKPOINT");
  return db.transaction(async tx => {
    const current = await lockedTarget(tx, target);
    const [receipt] = await tx.select({ digest: journeyJournals.lastWriteDigest }).from(journeyJournals).where(eq(journeyJournals.journeyId, target.journeyId));
    const digest = createHash("sha256").update(JSON.stringify({ hotelPlan: plan })).digest("hex");
    if (receipt?.digest === digest) return { state: "hotels-already-applied", revision: current.revision, unresolved: e.checkpoint.questions.length };
    if (!verifyHotelPlan(e.checkpoint.token, serverConfig.authSecret)) return fail("HOTEL_PLAN_EXPIRED_OR_INVALID");
    if (hash(current) !== hash(e.checkpoint.before)) return fail("JOURNAL_CHANGED");
    if (!plan.hotels.length) return { state: e.checkpoint.questions.length ? "hotels-unresolved" : "no-hotels", revision: current.revision, unresolved: e.checkpoint.questions.length };
    await backup(e);
    const saved = await applyJournalHotels(plan, target.atlasId, target.journeyId, tx);
    if (!saved) return fail("TARGET_NOT_FOUND");
    return { state: e.checkpoint.questions.length ? "hotels-partial" : "hotels-applied", revision: saved.revision, unresolved: e.checkpoint.questions.length };
  });
}
