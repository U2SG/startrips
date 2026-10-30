import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, journeys, mediaAssets } from "../db/app-schema";
import { organization as authOrganizations, rateLimit, user as authUsers, member } from "../db/auth-schema";
import { db, pool } from "../db/client";
import { createJourneyForAtlas, getJourneyForAtlas } from "../repositories/journey-repository";
import { readDailyJournal, writeDailyJournal } from "../repositories/daily-journal-repository";
import { applyImport, readImportState, validateEnvelope, hash, type Envelope } from "../admin/journal-import";
import { previewImportedHotels, applyImportedHotels } from "../admin/journal-hotel-import";
import { journalImportDependencies } from "../itinerary/journal-import-service";
import { previewJournalImport } from "../../src/journey/dailyJournal";
import type { LocationSearch } from "../location/location-search";
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
let owner: Awaited<ReturnType<typeof createAuthenticatedAtlas>>, other: typeof owner;
let journeyId: string, mediaId: string;
const source = "2028年6月3日\n- 23:30 实际：她在虚构城入住星桥酒店。\n- 07:30 取消：原计划入住山谷酒店。";
const prior = { intentDriver: serverConfig.intentDriver, intentBaseUrl: serverConfig.intentBaseUrl, intentApiKey: serverConfig.intentApiKey, intentModel: serverConfig.intentModel };
const provider = { baseUrl: "https://model.example.test/v1", model: "mock" };
const model = { ...provider, apiKey: "mock-only", timeoutMs: 1000, fetcher: vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(init!.body as string), name = body.tool_choice.function.name, data = JSON.parse(body.messages[1].content);
  let args;
  if (name === "stage_journal_import") args = { chapters: [{ firstLine: 0, lastLine: 2, date: "2028-06-03", dateEnd: null, dateEvidence: "2028年6月3日",
    events: source.split("\n").slice(1).map((evidence, i) => ({ line: i + 1, evidence, status: i ? "cancelled" : "actual", localDate: null, dateEvidence: null,
      time: i ? "07:30" : "23:30", timeEnd: null, timeEvidence: i ? "07:30" : "23:30", reading: evidence, questions: [] })) }] };
  else if (name === "search_hotels") {
    const event = data.flatMap((c: any) => c.events).find((e: any) => e.source.includes("入住星桥酒店"));
    args = { stays: [{ eventId: event.id ?? event.eventId, evidence: "在虚构城入住星桥酒店", name: "星桥酒店", area: "虚构城" }], questions: [] };
  } else { expect(name).toBe("stage_hotel_links"); args = { matches: data.map((e: any) => ({ eventId: e.eventId, candidateId: e.candidates[0].candidateId })) }; }
  return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
}) };
const point = { id: "provider-hotel", label: "星桥酒店", context: "虚构城，中心路", latitude: 10, longitude: 20, countryCode: "ZZ" };
const search: LocationSearch = { driver: "mock", attribution: null, search: vi.fn(async () => [point]), reverse: vi.fn() };
beforeAll(async () => {
  owner = await createAuthenticatedAtlas("llm-journal-owner"); other = await createAuthenticatedAtlas("llm-journal-other");
  const j = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "虚构旅行", startedOn: "2028-06-07", endedOn: "2028-06-09", note: "keep", lightColor: "#ffffff", routePoints: [{ label: "旧地点", latitude: 1, longitude: 2, isStop: true, occurredAt: null }] }); journeyId = j!.id;
  const [media] = await db.insert(mediaAssets).values({ journeyId, storageDriver: "disabled", storageKey: randomUUID(), fileName: "fiction.jpg", mimeType: "image/jpeg", bytes: 1, uploadedByUserId: owner.userId }).returning(); mediaId = media.id;
  const chapters = previewJournalImport("2028-05-01\n实际：旧记事", "2028-05-01"); chapters[0].events[0].text = "private edited reading"; chapters[0].events[0].edited = true; chapters[0].events[0].mediaIds = [mediaId];
  await writeDailyJournal(journeyId, owner.atlasId, 0, chapters);
  Object.assign(serverConfig, { intentDriver: "http-model", intentBaseUrl: provider.baseUrl, intentModel: provider.model, intentApiKey: "mock-only" });
  journalImportDependencies.fetcher = model.fetcher;
});
afterAll(async () => {
  journalImportDependencies.fetcher = undefined; Object.assign(serverConfig, prior);
  if (atlasIds.length) await db.delete(atlases).where(inArray(atlases.id, atlasIds));
  if (authOrganizationIds.length) await db.delete(authOrganizations).where(inArray(authOrganizations.id, authOrganizationIds));
  if (authUserEmails.length) await db.delete(authUsers).where(inArray(authUsers.email, authUserEmails));
  // This isolated fixture creates auth rate-limit rows; do not contaminate later suites.
  await db.delete(rateLimit);
  await pool.end();
});
let envelope: Envelope;
const request = (cookie = owner.cookie, consent: unknown = provider) => app.request(`${TEST_ORIGIN}/api/intents/journal-import`, { method: "POST", headers: authHeaders(cookie), body: JSON.stringify({ journeyId, source, sentence: "导入原稿并关联已入住酒店", fallbackDate: "2028-06-01", provider: consent }) });
it("one-sentence API authenticates target/provider before sending source and shares the admin plan", async () => {
  expect((await request("")).status).toBe(401); expect((await request(other.cookie)).status).toBe(404);
  expect((await request(owner.cookie, { ...provider, model: "different" })).status).toBe(400); expect(model.fetcher).not.toHaveBeenCalled();
  const response = await request(); expect(response.status).toBe(200); envelope = (await response.json()).envelope;
  const legacy = { ...envelope.plan, version: 1 };
  expect(() => validateEnvelope({ plan: legacy, signature: createHmac("sha256", serverConfig.authSecret).update(JSON.stringify(legacy)).digest("hex") })).toThrow("INVALID_PLAN");
  expect((await readDailyJournal(journeyId, owner.atlasId))!.revision).toBe(1);
  expect(JSON.stringify(model.fetcher.mock.calls)).not.toContain("private edited reading");
  await expect(previewImportedHotels(envelope, provider, { model, search })).rejects.toThrow("JOURNAL_STAGE_NOT_CURRENT");
});
it.each([
  ["timeout", "INTENT_TIMEOUT", "transport", 504],
  ["body-timeout", "INTENT_TIMEOUT", "transport", 504],
  ["body-disconnect", "INTENT_UNREACHABLE", "transport", 502],
  ["unreachable", "INTENT_UNREACHABLE", "transport", 502],
  ["http", "INTENT_FAILED", "transport", 502],
  ["schema", "JOURNAL_IMPORT_MALFORMED", "schema", 502],
] as const)("actual CLI preserves %s diagnosis without private output or writes", async (mode, code, kind, status) => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume private input without logging it */ }
    calls++;
    if (mode === "timeout") return;
    if (mode === "body-timeout" || mode === "body-disconnect") {
      response.writeHead(200, { "content-type": "application/json" }); response.flushHeaders(); response.write("{");
      if (mode === "body-disconnect") setImmediate(() => response.destroy());
      return;
    }
    if (mode === "unreachable") { request.socket.destroy(); return; }
    response.statusCode = mode === "http" ? 503 : 200;
    response.end(JSON.stringify({ privateProviderBody: source }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const directory = await mkdtemp(join(tmpdir(), "llm-journal-error-")), path = join(directory, "plan.json");
  const before = await readDailyJournal(journeyId, owner.atlasId);
  try {
    const result = await new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", process.env.JOURNAL_ADMIN_TEST_ENTRY ?? resolve("server/admin/journal-import-cli.ts"), "llm-preview", path],
        { env: { ...process.env, INTENT_DRIVER: "http-model", INTENT_BASE_URL: baseUrl, INTENT_MODEL: "mock", INTENT_API_KEY: "mock-only", INTENT_TIMEOUT_MS: "1000" } });
      let out = "", err = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
      child.on("error", reject); child.on("close", code => done({ code, out, err }));
      child.stdin.end(JSON.stringify({ target: { userId: owner.userId, email: authUserEmails[0], atlasId: owner.atlasId, journeyId }, sentence: "导入并关联酒店", source, fallbackDate: "2028-06-01", provider: { baseUrl, model: "mock" } }));
    });
    expect(result.code).toBe(1); expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toEqual({ error: code, stage: "llm-preview", kind, status });
    expect(calls).toBe(1); await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readDailyJournal(journeyId, owner.atlasId)).toEqual(before);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); }
});
it("actual admin CLI uses the same model use-case through a local mock provider", async () => {
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    expect(request.headers.authorization).toBe("Bearer mock-only");
    const answer = await model.fetcher("local", { body }); response.setHeader("content-type", "application/json"); response.end(await answer.text());
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number }, baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const directory = await mkdtemp(join(tmpdir(), "llm-journal-cli-")), path = join(directory, "plan.json");
  try {
    const result = await new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", process.env.JOURNAL_ADMIN_TEST_ENTRY ?? resolve("server/admin/journal-import-cli.ts"), "llm-preview", path],
        { env: { ...process.env, INTENT_DRIVER: "http-model", INTENT_BASE_URL: baseUrl, INTENT_MODEL: "mock", INTENT_API_KEY: "mock-only" } });
      let out = "", err = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
      child.on("error", reject); child.on("close", code => done({ code, out, err }));
      child.stdin.end(JSON.stringify({ target: { userId: owner.userId, email: authUserEmails[0], atlasId: owner.atlasId, journeyId },
        sentence: "导入并关联酒店", source, fallbackDate: "2028-06-01", provider: { baseUrl, model: "mock" } }));
    });
    expect(result.code, result.err).toBe(0); expect(result.out).not.toContain("星桥酒店");
    expect(JSON.parse(result.out)).toMatchObject({ mode: "model", stage: "journal-preview", statuses: { actual: 1, cancelled: 1 }, localClocks: 2 });
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.plan.after.chapters).toEqual(envelope.plan.after.chapters);
    expect(saved.plan.provider).toEqual({ baseUrl, model: "mock" });
  } finally { await new Promise<void>((r, reject) => server.close(error => error ? reject(error) : r())); await rm(directory, { recursive: true, force: true }); }
});
it("applies journal with a backup, survives replay and preserves prior manual text/media", async () => {
  await expect(applyImport(envelope, hash(envelope), async () => { throw new Error("BACKUP_FAILED"); })).rejects.toThrow("BACKUP_FAILED");
  const backup = vi.fn(async () => {});
  const results = await Promise.all([applyImport(envelope, hash(envelope), backup), applyImport(envelope, hash(envelope), backup)]);
  expect(results.map(r => r.state).sort()).toEqual(["already-applied", "applied"]); expect(backup).toHaveBeenCalledTimes(1);
  const journal = (await readDailyJournal(journeyId, owner.atlasId))!;
  expect(journal.chapters[0].events[0]).toMatchObject({ edited: true, text: "private edited reading", mediaIds: [mediaId] });
  expect(journal.chapters[1].events.map(e => e.localTime)).toEqual(["23:30", "07:30"]);
});
it("uncertain hotel preview never creates points and leaves journal stage resumable", async () => {
  const ambiguous: LocationSearch = { ...search, search: async () => [point, { ...point, id: "other-branch" }] };
  const checkpoint = await previewImportedHotels(envelope, provider, { model, search: ambiguous });
  const result = await applyImportedHotels(checkpoint, hash(checkpoint), async () => { throw new Error("must not write"); });
  expect(result.state).toBe("hotels-unresolved"); expect((await getJourneyForAtlas(journeyId, owner.atlasId))!.routePoints).toHaveLength(1);
});
it("hotel stage validates signed candidates, backs up before writing, and repeats without duplicate points", async () => {
  const checkpoint = await previewImportedHotels(envelope, provider, { model, search });
  const tampered = structuredClone(checkpoint); tampered.checkpoint.target.atlasId = other.atlasId;
  await expect(applyImportedHotels(tampered, hash(tampered), async () => {})).rejects.toThrow("INVALID_HOTEL_CHECKPOINT");
  await expect(applyImportedHotels(checkpoint, hash(checkpoint), async () => { throw new Error("BACKUP_FAILED"); })).rejects.toThrow("BACKUP_FAILED");
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
  await expect(applyImportedHotels(checkpoint, hash(checkpoint), async () => {})).rejects.toThrow("HOTEL_PLAN_EXPIRED_OR_INVALID"); clock.mockRestore();
  const backup = vi.fn(async () => {});
  const results = await Promise.all([applyImportedHotels(checkpoint, hash(checkpoint), backup), applyImportedHotels(checkpoint, hash(checkpoint), backup)]);
  expect(results.map(r => r.state).sort()).toEqual(["hotels-already-applied", "hotels-applied"]); expect(backup).toHaveBeenCalledTimes(1);
  const journey = (await getJourneyForAtlas(journeyId, owner.atlasId))!;
  expect(JSON.stringify(model.fetcher.mock.calls)).not.toContain("旧记事");
  expect(journey.routePoints).toHaveLength(2); expect(journey.startedOn).toBe("2028-06-07"); expect(journey.endedOn).toBe("2028-06-09");
  const response = await app.request(`${TEST_ORIGIN}/api/journeys/${journeyId}/journal`, { headers: authHeaders(owner.cookie) });
  const { journal } = await response.json();
  expect(journal.chapters[1].source).toBe(source); expect(journal.chapters[1].events[0].routePointId).toBe(journey.routePoints.find(p => p.label === "星桥酒店")!.id);
  expect(journal.chapters[1].events[1]).toMatchObject({ status: "cancelled", routePointId: null });
  expect(journal.chapters[0].events[0]).toMatchObject({ edited: true, mediaIds: [mediaId], text: "private edited reading" });
  const snapshot = await readImportState(envelope);
  expect(snapshot.journal).toEqual(journal); expect(snapshot.journey.routePoints).toHaveLength(2);
  const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
  expect((await applyImportedHotels(checkpoint, hash(checkpoint), backup)).state).toBe("hotels-already-applied"); later.mockRestore();
  await db.update(member).set({ role: "viewer" }).where(eq(member.userId, owner.userId));
  await expect(applyImportedHotels(checkpoint, hash(checkpoint), backup)).rejects.toThrow("TARGET_PERMISSION_DENIED");
});
