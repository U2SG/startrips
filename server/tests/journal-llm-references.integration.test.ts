import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/client";
import { atlases, journeys, journeyRoutePoints, mediaAssets } from "../db/app-schema";
import { member, organization, user } from "../db/auth-schema";
import { applyImport, hash, type Target } from "../admin/journal-import";
import { readDailyJournal, writeDailyJournal } from "../repositories/daily-journal-repository";
import { previewJournalImport } from "../../src/journey/dailyJournal";

import { serverConfig } from "../config";
import { journalImportDependencies, prepareAuthorizedJournalImport, journalProviderInfo } from "../itinerary/journal-import-service";
import { submitJournalJob, runJournalJob, readJournalJob } from "../itinerary/journal-import-jobs";
const provider = { baseUrl: "https://synthetic-model.example.test/v1", model: "synthetic" };
const prior = { intentDriver: serverConfig.intentDriver, intentBaseUrl: serverConfig.intentBaseUrl, intentApiKey: serverConfig.intentApiKey, intentModel: serverConfig.intentModel };
const inputSource = "2028-06-02\n实际：她继续记录。";
const answer = () => Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "stage_journal_import", arguments: JSON.stringify({ chapters: [{ firstLine: 0, lastLine: 1, date: "2028-06-02", dateEnd: null, dateEvidence: "2028-06-02", events: [{ line: 1, evidence: "实际：她继续记录。", status: "actual", localDate: null, dateEvidence: null, time: null, timeEnd: null, timeEvidence: null, reading: "她继续记录。", questions: [] }] }] }) } }] } }] });
async function modelAnswer(mode: "sync" | "job") {
  const response = answer();
  if (mode === "sync") return response;
  const payload = await response.json();
  const call = payload.choices[0].message.tool_calls[0];
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const input = () => ({ source: inputSource, sentence: "导入手记", fallbackDate: "2028-06-01", provider: journalProviderInfo() });
const userId = randomUUID(), org = randomUUID(), email = `${userId}@example.test`;
let atlasId: string;
const source = "2028-06-01\n实际：她在虚构花园散步。";
beforeAll(async () => {
  Object.assign(serverConfig, { intentDriver: "http-model", intentBaseUrl: provider.baseUrl, intentApiKey: "mock-only", intentModel: provider.model });
  await db.insert(user).values({ id: userId, name: "Synthetic", email });
  await db.insert(organization).values({ id: org, name: "Synthetic", slug: org, createdAt: new Date() });
  await db.insert(member).values({ id: randomUUID(), userId, organizationId: org, role: "owner", createdAt: new Date() });
  const [atlas] = await db.insert(atlases).values({ organizationId: org, title: "Synthetic" }).returning(); atlasId = atlas.id;
});
afterAll(async () => {
  Object.assign(serverConfig, prior); journalImportDependencies.fetcher = undefined;
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


async function prepare(mode: "sync" | "job", target: Target) {
  if (mode === "sync") return prepareAuthorizedJournalImport(target, input());
  const id = randomUUID();
  await submitJournalJob(target, id, input());
  await runJournalJob();
  const row = await readJournalJob(target, id);
  expect(row.status, JSON.stringify(row.error)).toBe("completed");
  return row.envelope;
}
it.each(["sync", "job"] as const)("%s preview seals normalized references and preserves the original backup and manual text", async mode => {
  const f = await fixture();
  await db.delete(mediaAssets).where(eq(mediaAssets.id, f.assets[0].id));
  await db.delete(journeyRoutePoints).where(eq(journeyRoutePoints.id, f.point.id));
  const fetcher = vi.fn(async () => modelAnswer(mode)); journalImportDependencies.fetcher = fetcher;
  const envelope = await prepare(mode, f.target);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(envelope.plan.before).toEqual(f.before);
  expect(envelope.plan.after.chapters[0].events[0]).toEqual({ ...f.before.chapters[0].events[0], routePointId: null, mediaIds: [f.assets[1].id] });
  expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(f.before);
  const backup = vi.fn(async saved => { expect(saved.plan.before).toEqual(f.before); });
  expect((await applyImport(envelope, hash(envelope), backup)).state).toBe("applied");
  expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(envelope.plan.after);
  expect((await applyImport(envelope, hash(envelope), backup)).state).toBe("already-applied");
  expect(backup).toHaveBeenCalledOnce();
});
it.each(["sync", "job"] as const)("%s refuses a journal changed while the model was responding", async mode => {
  const f = await fixture();
  const changed = structuredClone(f.before.chapters); changed[0].events[0].text = "后来手改的内容";
  journalImportDependencies.fetcher = vi.fn(async () => {
    await writeDailyJournal(f.target.journeyId, atlasId, f.before.revision, changed);
    return modelAnswer(mode);
  });
  if (mode === "sync") await expect(prepareAuthorizedJournalImport(f.target, input())).rejects.toThrow("JOURNAL_CHANGED");
  else {
    const id = randomUUID(); await submitJournalJob(f.target, id, input()); await runJournalJob();
    const row = await readJournalJob(f.target, id);
    expect(row.status).toBe("failed"); expect(row.error.error).toBe("JOURNAL_CHANGED"); expect(row.envelope).toBeNull();
  }
  expect((await readDailyJournal(f.target.journeyId, atlasId))!.chapters).toEqual(changed);
});
it.each(["sync", "job"] as const)("%s rechecks membership after the model returns", async mode => {
  const f = await fixture();
  journalImportDependencies.fetcher = vi.fn(async () => {
    await db.update(member).set({ role: "viewer" }).where(eq(member.userId, userId));
    return modelAnswer(mode);
  });
  try {
    if (mode === "sync") await expect(prepareAuthorizedJournalImport(f.target, input())).rejects.toThrow("TARGET_PERMISSION_DENIED");
    else {
      const id = randomUUID(); await submitJournalJob(f.target, id, input()); await runJournalJob();
      const { rows } = await pool.query("SELECT status,error,envelope FROM journal_import_jobs WHERE id=$1", [id]);
      expect(rows[0].status).toBe("failed"); expect(rows[0].error.error).toBe("TARGET_PERMISSION_DENIED"); expect(rows[0].envelope).toBeNull();
    }
    expect(await readDailyJournal(f.target.journeyId, atlasId)).toEqual(f.before);
  } finally { await db.update(member).set({ role: "owner" }).where(eq(member.userId, userId)); }
});
