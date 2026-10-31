import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/client";
import { atlases, journeys, journeyRoutePoints, mediaAssets } from "../db/app-schema";
import { member, organization, user } from "../db/auth-schema";
import { applyImport, checkRollback, hash, previewImport, type Target } from "../admin/journal-import";
import { readDailyJournal, writeDailyJournal } from "../repositories/daily-journal-repository";
import { previewJournalImport } from "../../src/journey/dailyJournal";

const userId = randomUUID(), org = randomUUID(), email = `${userId}@example.test`;
let atlasId: string;
const source = "2028-06-01\n实际：她在虚构花园散步。";
beforeAll(async () => {
  await db.insert(user).values({ id: userId, name: "Synthetic", email });
  await db.insert(organization).values({ id: org, name: "Synthetic", slug: org, createdAt: new Date() });
  await db.insert(member).values({ id: randomUUID(), userId, organizationId: org, role: "owner", createdAt: new Date() });
  const [atlas] = await db.insert(atlases).values({ organizationId: org, title: "Synthetic" }).returning(); atlasId = atlas.id;
});
afterAll(async () => {
  if (atlasId) await db.delete(atlases).where(eq(atlases.id, atlasId));
  await db.delete(organization).where(eq(organization.id, org)); await db.delete(user).where(eq(user.id, userId));
  await pool.end();
});
async function fixture() {
  const [journey] = await db.insert(journeys).values({ atlasId, title: "Synthetic", startedOn: "2028-06-01", createdByUserId: userId }).returning();
  const target: Target = { userId, email, atlasId, journeyId: journey.id };
  const [point] = await db.insert(journeyRoutePoints).values({ journeyId: journey.id, sortOrder: 0, label: "Synthetic garden", latitude: 1, longitude: 2, isStop: true }).returning();
  const assets = await db.insert(mediaAssets).values(["deleted", "kept"].map(label => ({ journeyId: journey.id, storageDriver: "disabled" as const, storageKey: randomUUID(), fileName: `${label}.jpg`, mimeType: "image/jpeg", bytes: 1, uploadedByUserId: userId }))).returning();
  const chapters = previewJournalImport(source, "2028-06-01");
  Object.assign(chapters[0].events[0], { status: "actual", routePointId: point.id, mediaIds: assets.map(a => a.id), text: "手改正文仍须保留", edited: true });
  const before = (await writeDailyJournal(journey.id, atlasId, 0, chapters))!;
  return { target, point, assets, before };
}

it.each([false, true])("signs dead-reference cleanup before apply, including cleanup-only replay=%s", async duplicate => {
  const f = await fixture();
  await db.delete(mediaAssets).where(eq(mediaAssets.id, f.assets[0].id));
  await db.delete(journeyRoutePoints).where(eq(journeyRoutePoints.id, f.point.id));
  const plan = await previewImport(f.target, duplicate ? source : "2028-06-02\n实际：她继续记录。", "2028-06-01");
  expect(plan.plan.before).toEqual(f.before);
  expect(plan.plan.after.chapters[0].events[0]).toEqual({ ...f.before.chapters[0].events[0], routePointId: null, mediaIds: [f.assets[1].id] });
  expect(plan.plan.after.revision).toBe(f.before.revision + 1);
  expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(f.before);
  const backup = vi.fn(async envelope => {
    expect(envelope.plan.before).toEqual(f.before);
    expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(f.before);
  });
  expect(await applyImport(plan, hash(plan), backup)).toEqual({ state: "applied", revision: plan.plan.after.revision });
  expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(plan.plan.after);
  expect(await applyImport(plan, hash(plan), backup)).toMatchObject({ state: "already-applied" });
  expect(backup).toHaveBeenCalledOnce();
  expect(await checkRollback(plan)).toMatchObject({ eligible: true });
});

it.each(["media", "point"])("rejects %s removal after preview before backup or write", async kind => {
  const f = await fixture();
  const plan = await previewImport(f.target, "2028-06-02\n实际：她继续记录。", "2028-06-01");
  if (kind === "media") await db.delete(mediaAssets).where(eq(mediaAssets.id, f.assets[0].id));
  else await db.delete(journeyRoutePoints).where(eq(journeyRoutePoints.id, f.point.id));
  const backup = vi.fn(async () => {});
  await expect(applyImport(plan, hash(plan), backup)).rejects.toThrow("JOURNAL_CHANGED");
  expect(backup).not.toHaveBeenCalled();
  expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(f.before);
});

it("continues rejecting new foreign references and changed source", async () => {
  const f = await fixture(), other = await fixture();
  for (const patch of [{ routePointId: other.point.id }, { mediaIds: [other.assets[0].id] }, { source: "替换了原文" }]) {
    const chapters = structuredClone(f.before.chapters); Object.assign(chapters[0].events[0], patch);
    await expect(writeDailyJournal(f.target.journeyId, atlasId, f.before.revision, chapters)).rejects.toThrow(/JOURNAL_(FOREIGN_REFERENCE|SOURCE_CHANGED)/);
  }
  expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(f.before);
});

it.each(["media", "point"])("keeps validated %s ownership locked during backup and releases it after commit", async kind => {
  const f = await fixture();
  const plan = await previewImport(f.target, "2028-06-02\n实际：她继续记录。", "2028-06-01");
  const other = await pool.connect();
  const statement = kind === "media" ? "DELETE FROM media_assets WHERE id = $1" : "DELETE FROM journey_route_points WHERE id = $1";
  const id = kind === "media" ? f.assets[0].id : f.point.id;
  try {
    const result = await applyImport(plan, hash(plan), async () => {
      await other.query("BEGIN");
      // A separate connection attempts the real deletion during the backup.
      // It must be blocked by the write transaction, not merely fail later.
      await other.query("SET LOCAL lock_timeout = '100ms'");
      try { await expect(other.query(statement, [id])).rejects.toMatchObject({ code: "55P03" }); }
      finally { await other.query("ROLLBACK"); }
    });
    expect(result.state).toBe("applied");
    expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(plan.plan.after);
    expect((await other.query(statement, [id])).rowCount).toBe(1);
  } finally { other.release(); }
});
