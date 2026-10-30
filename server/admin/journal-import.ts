/** Offline administrative entry point. Never exposed as an HTTP route. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { atlases, journeys, journeyJournals } from "../db/app-schema";
import { user, member } from "../db/auth-schema";
import { hasAtlasPermission } from "../authorization/permissions";
import { serverConfig } from "../config";
import { lockActiveAtlas, lockActiveJourney } from "../repositories/journey-repository";
import { writeDailyJournal } from "../repositories/daily-journal-repository";
import { parseJournalChapters, previewJournalImport, type DailyJournal } from "../../src/journey/dailyJournal";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Target = { userId: string; email: string; atlasId: string; journeyId: string };
type Plan = { version: 1; target: Target; sourceHash: string; before: DailyJournal; after: DailyJournal; expires: number };
export type Envelope = { plan: Plan; signature: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const fail = (code: string): never => { throw new Error(code); };
const sign = (plan: Plan) => createHmac("sha256", serverConfig.authSecret).update(JSON.stringify(plan)).digest("hex");
export function validateEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== "object") return fail("INVALID_PLAN");
  const e = value as Envelope;
  if (!e.plan || typeof e.signature !== "string" || !/^[a-f0-9]{64}$/.test(e.signature)
    || !timingSafeEqual(Buffer.from(e.signature, "hex"), Buffer.from(sign(e.plan), "hex"))) return fail("INVALID_PLAN");
  const p = e.plan;
  if (p.version !== 1 || !parseJournalChapters(p.before?.chapters) || !parseJournalChapters(p.after?.chapters)
    || !Number.isSafeInteger(p.before.revision) || p.before.revision < 0 || p.after.revision !== p.before.revision + (hash(p.before.chapters) === hash(p.after.chapters) ? 0 : 1)) return fail("INVALID_PLAN");
  return e;
}
export async function inspectAccount(email: string) {
  if (typeof email !== "string" || !email || email.length > 320) return fail("INVALID_ACCOUNT");
  return db.select({ userId: user.id, email: user.email, role: member.role, atlasId: atlases.id, atlasTitle: atlases.title,
    journeyId: journeys.id, journeyTitle: journeys.title, startedOn: journeys.startedOn, endedOn: journeys.endedOn })
    .from(user).innerJoin(member, eq(member.userId, user.id)).innerJoin(atlases, eq(atlases.organizationId, member.organizationId))
    .innerJoin(journeys, eq(journeys.atlasId, atlases.id))
    .where(and(eq(user.email, email), isNull(atlases.deletionStartedAt), isNull(journeys.deletionStartedAt)));
}
async function lockedTarget(tx: Tx, target: Target) {
  if (!target || Object.values(target).some(v => typeof v !== "string" || !v)
    || !target.email || !target.userId || !target.atlasId || !target.journeyId) return fail("INVALID_TARGET");
  // Lock in the same Atlas/Journey order as existing writes; hold membership through commit.
  await tx.execute(sql`set local lock_timeout = '5s'`);
  await tx.execute(sql`set local statement_timeout = '15s'`);
  if (!await lockActiveAtlas(tx, target.atlasId) || !await lockActiveJourney(tx, target.journeyId, target.atlasId)) return fail("TARGET_NOT_FOUND");
  const rows = await tx.select({ role: member.role }).from(member)
    .innerJoin(user, eq(user.id, member.userId)).innerJoin(atlases, eq(atlases.organizationId, member.organizationId))
    .where(and(eq(user.id, target.userId), eq(user.email, target.email), eq(atlases.id, target.atlasId))).for("share", { of: [member, user] });
  if (rows.length !== 1 || !hasAtlasPermission(rows[0].role, "update")) return fail("TARGET_PERMISSION_DENIED");
  const [row] = await tx.select().from(journeyJournals).where(eq(journeyJournals.journeyId, target.journeyId));
  return row ? { revision: row.revision, chapters: row.chapters } : { revision: 0, chapters: [] };
}
export async function previewImport(target: Target, source: string, fallbackDate: string): Promise<Envelope> {
  return db.transaction(async tx => {
    const before = await lockedTarget(tx, target);
    let chapters;
    try { chapters = previewJournalImport(source, fallbackDate, before.chapters); } catch { return fail("INVALID_IMPORT"); }
    const plan: Plan = { version: 1, target, sourceHash: hash(source), before,
      after: { revision: before.revision + (hash(chapters) === hash(before.chapters) ? 0 : 1), chapters }, expires: Date.now() + 24 * 60 * 60_000 };
    return { plan, signature: sign(plan) };
  });
}
export async function applyImport(value: unknown, expectedDigest: string, backup: (envelope: Envelope) => Promise<void>) {
  const e = validateEnvelope(value);
  if (hash(e) !== expectedDigest) return fail("PLAN_DIGEST_MISMATCH");
  if (e.plan.expires < Date.now()) return fail("PLAN_EXPIRED");
  return db.transaction(async tx => {
    const current = await lockedTarget(tx, e.plan.target);
    if (hash(current) === hash(e.plan.after)) return { state: "already-applied", revision: current.revision };
    if (hash(current) !== hash(e.plan.before)) return fail("JOURNAL_CHANGED");
    // Durable private backup must finish before any domain write, or transaction aborts.
    await backup(e);
    const saved = await writeDailyJournal(e.plan.target.journeyId, e.plan.target.atlasId, current.revision, e.plan.after.chapters, tx);
    if (!saved || hash(saved) !== hash(e.plan.after)) return fail("SAVE_MISMATCH");
    return { state: "applied", revision: saved.revision };
  });
}
export async function checkRollback(value: unknown) {
  const e = validateEnvelope(value);
  return db.transaction(async tx => {
    const current = await lockedTarget(tx, e.plan.target);
    return { eligible: hash(current) === hash(e.plan.after), currentRevision: current.revision, expectedRevision: e.plan.after.revision,
      backupDigest: hash(e), restoredChapterCount: e.plan.before.chapters.length };
  });
}
