import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, journeys, journeyJournals, mediaAssets } from "../db/app-schema";
import { organization as authOrganizations, rateLimit, user as authUsers, member } from "../db/auth-schema";
import { db, pool } from "../db/client";
import { createJourneyForAtlas } from "../repositories/journey-repository";
import { previewJournalImport, type DailyJournal } from "../../src/journey/dailyJournal";
const TEST_ORIGIN = "http://127.0.0.1:5173";
const atlasIds: string[] = [], authOrganizationIds: string[] = [], authUserEmails: string[] = [];
function authHeaders(cookie?: string) { return { "content-type": "application/json", origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}) }; }
async function createAuthenticatedAtlas(label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "test-only-password-123";
  authUserEmails.push(email);
  await db.delete(rateLimit);
  const signUp = await app.request(`${TEST_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: label, email, password }),
  });
  expect(signUp.status).toBe(200);
  const token = await createEmailVerificationToken(serverConfig.authSecret, email);
  const verification = await app.request(
    `${TEST_ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    { headers: authHeaders() },
  );
  expect(verification.status).toBe(200);

  const signIn = await app.request(`${TEST_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email, password }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0];
  expect(cookie).toBeTruthy();
  const { user } = await signIn.json() as { user: { id: string } };

  const orgResponse = await app.request(
    `${TEST_ORIGIN}/api/auth/organization/create`,
    {
      method: "POST",
      headers: authHeaders(cookie!),
      body: JSON.stringify({
        name: `${label} Atlas`,
        slug: `${label.toLowerCase()}-${randomUUID()}`,
      }),
    },
  );
  expect(orgResponse.status).toBe(200);
  const organization = await orgResponse.json() as { id: string };
  authOrganizationIds.push(organization.id);

  const bootstrap = await app.request(`${TEST_ORIGIN}/api/atlases/bootstrap`, {
    method: "POST",
    headers: authHeaders(cookie!),
    body: JSON.stringify({ title: `${label} Atlas`, dedication: "private" }),
  });
  expect([200, 201]).toContain(bootstrap.status);
  const payload = await bootstrap.json() as { atlas: { id: string } };
  atlasIds.push(payload.atlas.id);
  return { cookie: cookie!, userId: user.id, atlasId: payload.atlas.id };
}

let owner: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let other: typeof owner;
let journeyId: string;
let pointId: string;
let foreignPointId: string;
let otherJourneyId: string;
let foreignMediaId: string;
const chapters = previewJournalImport("2027-04-03\n23:30 她出发\n18:20 她抵达\n计划公园取消\n长文：" + "沿途记录。".repeat(1200), "2027-04-03");
function request(path = "", method = "GET", cookie = owner.cookie, body?: unknown) {
  return app.request(`${TEST_ORIGIN}/api/journeys/${journeyId}/journal${path}`, { method, headers: authHeaders(cookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  owner = await createAuthenticatedAtlas("journal-owner"); other = await createAuthenticatedAtlas("journal-other");
  const input = { title: "虚构旅程", startedOn: "2027-04-03", endedOn: null, note: "", lightColor: "#ffffff", routePoints: [{ latitude: 1, longitude: 2, label: "虚构地点", isStop: true, occurredAt: null }] };
  const journey = await createJourneyForAtlas(owner.atlasId, owner.userId, input);
  const foreign = await createJourneyForAtlas(other.atlasId, other.userId, input);
  journeyId = journey!.id; pointId = journey!.routePoints[0].id; foreignPointId = foreign!.routePoints[0].id; otherJourneyId = foreign!.id;
  const [media] = await db.insert(mediaAssets).values({ journeyId: otherJourneyId, storageDriver: "disabled", storageKey: randomUUID(), fileName: "fiction.jpg", mimeType: "image/jpeg", bytes: 1, uploadedByUserId: other.userId }).returning();
  foreignMediaId = media.id;
});
afterAll(async () => {
  if (atlasIds.length) await db.delete(atlases).where(inArray(atlases.id, atlasIds));
  if (authOrganizationIds.length) await db.delete(authOrganizations).where(inArray(authOrganizations.id, authOrganizationIds));
  if (authUserEmails.length) await db.delete(authUsers).where(inArray(authUsers.email, authUserEmails));
  await pool.end();
});
describe("private daily journal API and PostgreSQL", () => {
  it("starts empty for existing journeys; denies unauthenticated, other-account reads and writes", async () => {
    expect(await (await request()).json()).toEqual({ journal: { revision: 0, chapters: [] } });
    expect((await request()).headers.get("cache-control")).toContain("no-store");
    expect((await request("", "GET", "")).status).toBe(401);
    const crossOrigin = await app.request(`${TEST_ORIGIN}/api/journeys/${journeyId}/journal`, {
      method: "PUT", headers: { ...authHeaders(owner.cookie), origin: "https://untrusted.example.test" },
      body: JSON.stringify({ baseRevision: 0, chapters }),
    });
    expect(crossOrigin.status).toBe(403);
    for (const method of ["GET", "PUT", "POST"]) {
      expect((await request(method === "POST" ? "/suggest" : "", method, other.cookie, method === "GET" ? undefined : { baseRevision: 0, chapters })).status).toBe(404);
    }
  });
  it("round trips long text and local evidence with no media; duplicate concurrent save writes once", async () => {
    chapters[0].events[1].localTime = "23:30";
    chapters[0].events[2].localTime = "18:20";
    chapters[0].events[3].status = "cancelled";
    const payload = { baseRevision: 0, chapters };
    const responses = await Promise.all([request("", "PUT", owner.cookie, payload), request("", "PUT", owner.cookie, payload)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    for (const response of responses) expect((await response.json()).journal.revision).toBe(1);
    const read = await (await request()).json() as { journal: DailyJournal };
    expect(read.journal.chapters).toEqual(chapters);
    expect((await db.select().from(journeyJournals).where(eq(journeyJournals.journeyId, journeyId)))).toHaveLength(1);
  });
  it("blocks stale edits, foreign links, non-actual pins and source replacement", async () => {
    const changed = structuredClone(chapters); changed[0].events[1].text = "她手工改写了正文"; changed[0].events[1].edited = true;
    expect((await request("", "PUT", owner.cookie, { baseRevision: 0, chapters: changed })).status).toBe(409);
    for (const foreign of [true, false]) {
      const bad = structuredClone(changed); bad[0].events[1].status = "actual";
      if (foreign) bad[0].events[1].routePointId = foreignPointId;
      else bad[0].events[1].mediaIds = [foreignMediaId];
      expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters: bad })).status).toBe(400);
    }
    const bad = structuredClone(changed); bad[0].events[1].routePointId = pointId;
    expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters: bad })).status).toBe(400);
    bad[0].events[1].routePointId = null; bad[0].source = "替换原文";
    expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters: bad })).status).toBe(400);
    changed[0].events[1].status = "actual"; changed[0].events[1].routePointId = pointId;
    expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters: changed })).status).toBe(200);
    expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters })).status).toBe(409);
  });
  it("rejects writes after membership becomes read-only; disabled AI leaves saved data intact", async () => {
    const before = await (await request()).json();
    expect((await request("/suggest", "POST", owner.cookie, { chapters })).status).toBe(503);
    expect(await (await request()).json()).toEqual(before);
    await db.update(member).set({ role: "viewer" }).where(eq(member.userId, owner.userId));
    expect((await request("", "PUT", owner.cookie, { baseRevision: 2, chapters })).status).toBe(403);
    expect((await request("/suggest", "POST", owner.cookie, { chapters })).status).toBe(403);
    await db.update(member).set({ role: "owner" }).where(eq(member.userId, owner.userId));
  });
  it("refuses deleted journeys and cascades private data on hard deletion", async () => {
    await db.update(journeys).set({ deletionStartedAt: new Date() }).where(eq(journeys.id, journeyId));
    expect((await request()).status).toBe(404);
    expect((await request("", "PUT", owner.cookie, { baseRevision: 2, chapters })).status).toBe(404);
    await db.delete(journeys).where(eq(journeys.id, journeyId));
    expect(await db.select().from(journeyJournals).where(eq(journeyJournals.journeyId, journeyId))).toHaveLength(0);
  });
});
