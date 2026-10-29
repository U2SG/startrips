import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, journeys, journeyJournals, mediaAssets } from "../db/app-schema";
import { organization as authOrganizations, rateLimit, user as authUsers, member } from "../db/auth-schema";
import { db, pool } from "../db/client";
import { signHotelPlan } from "../itinerary/journal-hotel-tools";
import { writeDailyJournal } from "../repositories/daily-journal-repository";
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
    chapters[0].events[0].localTime = "23:30";
    chapters[0].events[1].localTime = "18:20";
    chapters[0].events[2].status = "cancelled";
    const payload = { baseRevision: 0, chapters };
    const responses = await Promise.all([request("", "PUT", owner.cookie, payload), request("", "PUT", owner.cookie, payload)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    for (const response of responses) expect((await response.json()).journal.revision).toBe(1);
    const read = await (await request()).json() as { journal: DailyJournal };
    expect(read.journal.chapters).toEqual(chapters);
    expect((await db.select().from(journeyJournals).where(eq(journeyJournals.journeyId, journeyId)))).toHaveLength(1);
  });
  it("blocks stale edits, foreign links, non-actual pins and source replacement", async () => {
    const changed = structuredClone(chapters); changed[0].events[0].text = "她手工改写了正文"; changed[0].events[0].edited = true;
    expect((await request("", "PUT", owner.cookie, { baseRevision: 0, chapters: changed })).status).toBe(409);
    for (const foreign of [true, false]) {
      const bad = structuredClone(changed); bad[0].events[0].status = "actual";
      if (foreign) bad[0].events[0].routePointId = foreignPointId;
      else bad[0].events[0].mediaIds = [foreignMediaId];
      expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters: bad })).status).toBe(400);
    }
    const bad = structuredClone(changed); bad[0].events[0].routePointId = pointId;
    expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters: bad })).status).toBe(400);
    bad[0].events[0].routePointId = null; bad[0].source = "替换原文";
    expect((await request("", "PUT", owner.cookie, { baseRevision: 1, chapters: bad })).status).toBe(400);
    changed[0].events[0].status = "actual"; changed[0].events[0].routePointId = pointId;
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
  it("clears only previously owned dead references, keeping prose editable after media deletion", async () => {
    const [asset] = await db.insert(mediaAssets).values({ journeyId, storageDriver: "disabled", storageKey: randomUUID(), fileName: "own.jpg", mimeType: "image/jpeg", bytes: 1, uploadedByUserId: owner.userId }).returning();
    const before = (await (await request()).json()).journal as DailyJournal;
    before.chapters[0].events[0].mediaIds = [asset.id];
    expect((await request("", "PUT", owner.cookie, { baseRevision: before.revision, chapters: before.chapters })).status).toBe(200);
    await db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id));
    const current = (await (await request()).json()).journal as DailyJournal;
    current.chapters[0].events[0].text = "照片删除后仍可修改";
    const response = await request("", "PUT", owner.cookie, { baseRevision: current.revision, chapters: current.chapters });
    expect(response.status).toBe(200);
    const updated = (await response.json()).journal;
    expect(updated.chapters[0].events[0]).toMatchObject({ mediaIds: [], text: "照片删除后仍可修改" });
    const replay = await request("", "PUT", owner.cookie, { baseRevision: current.revision, chapters: current.chapters });
    expect(replay.status).toBe(200);
    expect((await replay.json()).journal).toEqual(updated);
  });
  it("routes journal AI through the existing standard model adapter, not a custom document endpoint", async () => {
    const prior = { intentDriver: serverConfig.intentDriver, intentBaseUrl: serverConfig.intentBaseUrl, intentApiKey: serverConfig.intentApiKey, intentModel: serverConfig.intentModel };
    Object.assign(serverConfig, { intentDriver: "http-model", intentBaseUrl: "https://model.example.test/v1", intentApiKey: "mock-only-key", intentModel: "mock-model" });
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const document = JSON.parse(body.messages[1].content);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ suggestions: document.chapters.flatMap((c: { events: {eventId:string;source:string}[] }) => c.events.map((e) => ({ eventId:e.eventId, text:e.source, questions:[], background:"" }))) }) } }] });
    });
    try {
      const before = await (await request()).json();
      const response = await request("/suggest", "POST", owner.cookie, { chapters });
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(upstream.mock.calls[0][0]).toBe("https://model.example.test/v1/chat/completions");
      const body = JSON.parse(upstream.mock.calls[0][1]!.body as string);
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body).not.toHaveProperty("document");
      expect(await (await request()).json()).toEqual(before);
    } finally { upstream.mockRestore(); Object.assign(serverConfig, prior); }
  });
  it("exposes hotel preview through the authenticated standard tool endpoint without writing", async () => {
    const j = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "工具预览", startedOn: "2027-05-01", endedOn: null, note: "", lightColor: "#ffffff", routePoints: [{ label: "星桥酒店", regionContext: "虚构城中心路", latitude: 10, longitude: 20, isStop: true, occurredAt: null }] });
    const cs = previewJournalImport("2027-05-01\n实际：她在虚构城入住星桥酒店。", "2027-05-01");
    await writeDailyJournal(j!.id, owner.atlasId, 0, cs);
    const prior = { intentDriver: serverConfig.intentDriver, intentBaseUrl: serverConfig.intentBaseUrl, intentApiKey: serverConfig.intentApiKey, intentModel: serverConfig.intentModel };
    Object.assign(serverConfig, { intentDriver: "http-model", intentBaseUrl: "https://model.example.test/v1", intentApiKey: "mock-only", intentModel: "mock" });
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(url).toBe("https://model.example.test/v1/chat/completions");
      const body = JSON.parse(init!.body as string), name = body.tool_choice.function.name;
      const args = name === "search_hotels" ? { stays: [{ eventId: cs[0].events[0].id, evidence: "在虚构城入住星桥酒店", name: "星桥酒店", area: "虚构城" }], questions: [] }
        : { matches: [{ eventId: cs[0].events[0].id, candidateId: `existing:${j!.routePoints[0].id}` }] };
      return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    });
    const preview = (cookie: string) => app.request(`${TEST_ORIGIN}/api/journeys/${j!.id}/journal/hotels/preview`, { method: "POST", headers: authHeaders(cookie), body: "{}" });
    try {
      expect((await preview(other.cookie)).status).toBe(404); expect(upstream).not.toHaveBeenCalled();
      const response = await preview(owner.cookie); expect(response.status).toBe(200);
      expect((await response.json()).preview.hotels[0].existingPointId).toBe(j!.routePoints[0].id);
      expect(upstream).toHaveBeenCalledTimes(2);
      const [row] = await db.select().from(journeyJournals).where(eq(journeyJournals.journeyId, j!.id));
      expect(row.revision).toBe(1); expect(row.chapters).toEqual(cs);
    } finally { upstream.mockRestore(); Object.assign(serverConfig, prior); }
  });
  it("atomically confirms hotel tools, replays concurrent clicks and rejects stale/foreign plans", async () => {
    const hotelJourney = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "虚构住宿测试", startedOn: "2027-05-01", endedOn: null, note: "", lightColor: "#ffffff", routePoints: [{ label: "起点", latitude: 0, longitude: 0, isStop: true, occurredAt: null }] });
    const cs = previewJournalImport("2027-05-01\n实际：23:40她入住虚构城星桥酒店。\n2027-05-02\n实际：00:20她回到虚构城星桥酒店。\n取消：山谷酒店。", "2027-05-01");
    cs[0].events[0].text = "保留手工正文"; cs[0].events[0].edited = true;
    await writeDailyJournal(hotelJourney!.id, owner.atlasId, 0, cs);
    const hotels = [cs[0].events[0], cs[1].events[0]].map(e => ({ eventId: e.id, evidence: e.source, label: "星桥酒店", context: "虚构城", latitude: 10, longitude: 20, providerId: "mock-provider", existingPointId: null }));
    const plan = { atlasId: owner.atlasId, journeyId: hotelJourney!.id, journalRevision: 1, journeyRevision: hotelJourney!.revision, expires: Date.now() + 60000, hotels };
    const token = signHotelPlan(plan, serverConfig.authSecret);
    const apply = (cookie: string, body: unknown) => app.request(`${TEST_ORIGIN}/api/journeys/${hotelJourney!.id}/journal/hotels/apply`, { method: "POST", headers: authHeaders(cookie), body: JSON.stringify(body) });
    expect((await apply(owner.cookie, { token })).status).toBe(400);
    expect((await apply(owner.cookie, { token: token + "x", confirmed: true })).status).toBe(400);
    expect((await apply(other.cookie, { token, confirmed: true })).status).toBe(404);
    await db.update(member).set({ role: "viewer" }).where(eq(member.userId, owner.userId));
    expect((await apply(owner.cookie, { token, confirmed: true })).status).toBe(403);
    await db.update(member).set({ role: "owner" }).where(eq(member.userId, owner.userId));
    const responses = await Promise.all([apply(owner.cookie, { token, confirmed: true }), apply(owner.cookie, { token, confirmed: true })]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    const [a, b] = await Promise.all(responses.map(r => r.json()));
    expect(a.journal).toEqual(b.journal); expect(a.journey.routePoints).toHaveLength(2);
    expect(a.journal.chapters[0].events[0]).toMatchObject({ text: "保留手工正文", edited: true, localTime: cs[0].events[0].localTime, source: cs[0].events[0].source });
    expect(a.journal.chapters[0].source).toBe(cs[0].source);
    expect(a.journal.chapters[0].events[0].routePointId).toBe(a.journal.chapters[1].events[0].routePointId);
    expect(a.journal.chapters[1].events[1]).toMatchObject({ status: "cancelled", routePointId: null });
    expect(a.journey.routePoints[1]).toMatchObject({ occurredAt: null, placeRole: "accommodation" });
    const changed = structuredClone(a.journal.chapters); changed[0].events[0].text = "稍后手改";
    await writeDailyJournal(hotelJourney!.id, owner.atlasId, a.journal.revision, changed);
    expect((await apply(owner.cookie, { token, confirmed: true })).status).toBe(409);
    const staleJourney = signHotelPlan({ ...plan, journalRevision: a.journal.revision + 1 }, serverConfig.authSecret);
    expect((await apply(owner.cookie, { token: staleJourney, confirmed: true })).status).toBe(409);
  });
  it("refuses deleted journeys and cascades private data on hard deletion", async () => {
    await db.update(journeys).set({ deletionStartedAt: new Date() }).where(eq(journeys.id, journeyId));
    expect((await request()).status).toBe(404);
    expect((await request("", "PUT", owner.cookie, { baseRevision: 2, chapters })).status).toBe(404);
    await db.delete(journeys).where(eq(journeys.id, journeyId));
    expect(await db.select().from(journeyJournals).where(eq(journeyJournals.journeyId, journeyId))).toHaveLength(0);
  });
});
