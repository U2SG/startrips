import { mockChapter, toolResponse } from "../itinerary/journal-import-test-fixtures";
import { readJournalImportSnapshot } from "../../src/journey/journalImportApi";
import { submitJournalJob, runJournalJob, readJournalJob, cancelJournalJob, jobView } from "../itinerary/journal-import-jobs";
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
import { journalImportDependencies, prepareAuthorizedJournalImport } from "../itinerary/journal-import-service";
import { JOURNAL_DROPPED_CLAIM_QUESTION } from "../itinerary/journal-import-workflow";
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
const prior = { intentDriver: serverConfig.intentDriver, intentBaseUrl: serverConfig.intentBaseUrl, intentApiKey: serverConfig.intentApiKey, intentModel: serverConfig.intentModel, journalModel: serverConfig.journalModel, journalTimeoutMs: serverConfig.journalTimeoutMs };
const provider = { baseUrl: "https://model.example.test/v1", model: "mock" };
const model = { ...provider, apiKey: "mock-only", timeoutMs: 1000, fetcher: vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(init!.body as string), name = body.tool_choice.function.name, data = JSON.parse(body.messages.filter((m: any) => m.role === "user").at(-1).content);
  expect(body.model).toBe("mock");
  let args;
  if (name === "stage_journal_import") args = { chapters: [{ firstLine: 0, lastLine: 2, heading: true, dateStatus: "single", questions: [], date: "2028-06-03", dateEnd: null, dateEvidence: "2028年6月3日",
    events: source.split("\n").slice(1).map((_, i) => ({ line: i + 1, status: i ? "cancelled" : "actual", dateStatus: "absent", localDate: null, dateEvidence: null,
      time: i ? "07:30" : "23:30", timeEnd: null, timeEvidence: i ? "07:30" : "23:30", placeName: null, questions: [] })) }] };
  else if (name === "search_hotels") {
    const event = data.flatMap((c: any) => c.events).find((e: any) => e.source.includes("入住星桥酒店"));
    args = { stays: [{ eventId: event.id ?? event.eventId, evidence: "在虚构城入住星桥酒店", name: "星桥酒店", area: "虚构城" }], questions: [] };
  } else { expect(name).toBe("stage_hotel_links"); args = { matches: data.map((e: any) => ({ eventId: e.eventId, candidateId: e.candidates[0].candidateId })) }; }
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: `mock-${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
}) };
const point = { id: "provider-hotel", label: "星桥酒店", context: "虚构城，中心路", latitude: 10, longitude: 20, countryCode: "ZZ" };
const search: LocationSearch = { driver: "mock", attribution: null, search: vi.fn(async () => [point]), reverse: vi.fn() };
beforeAll(async () => {
  owner = await createAuthenticatedAtlas("llm-journal-owner"); other = await createAuthenticatedAtlas("llm-journal-other");
  const j = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "虚构旅行", startedOn: "2028-06-07", endedOn: "2028-06-09", note: "keep", lightColor: "#ffffff", routePoints: [{ label: "旧地点", latitude: 1, longitude: 2, isStop: true, occurredAt: null }] }); journeyId = j!.id;
  const [media] = await db.insert(mediaAssets).values({ journeyId, storageDriver: "disabled", storageKey: randomUUID(), fileName: "fiction.jpg", mimeType: "image/jpeg", bytes: 1, uploadedByUserId: owner.userId }).returning(); mediaId = media.id;
  const chapters = previewJournalImport("2028-05-01\n实际：旧记事", "2028-05-01"); chapters[0].events[0].text = "private edited reading"; chapters[0].events[0].edited = true; chapters[0].events[0].mediaIds = [mediaId];
  await writeDailyJournal(journeyId, owner.atlasId, 0, chapters);
  Object.assign(serverConfig, { intentDriver: "http-model", intentBaseUrl: provider.baseUrl, intentModel: "simple-mock", journalModel: provider.model, intentApiKey: "mock-only" });
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
it("refuses missing journal configuration and simple-model consent before any provider call", async () => {
  const calls = model.fetcher.mock.calls.length;
  try {
    Object.assign(serverConfig, { journalModel: null });
    expect((await request()).status).toBe(503);
    Object.assign(serverConfig, { journalModel: provider.model });
    expect((await request(owner.cookie, { ...provider, model: serverConfig.intentModel })).status).toBe(400);
    expect(model.fetcher.mock.calls.length).toBe(calls);
  } finally { Object.assign(serverConfig, { journalModel: provider.model }); }
});
it("one-sentence API authenticates target/provider before sending source and shares the admin plan", async () => {
  expect((await request("")).status).toBe(401); expect((await request(other.cookie)).status).toBe(404);
  expect((await request(owner.cookie, { ...provider, model: "different" })).status).toBe(400); expect(model.fetcher).not.toHaveBeenCalled();
  const response = await request(); expect(response.status).toBe(200); envelope = (await response.json()).envelope;
  expect(envelope.plan.provider).toEqual({ baseUrl: expect.stringMatching(/^provider:[a-f0-9]{64}$/), model: "mock" });
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
  ["schema", "INTENT_TOOL_PROTOCOL_INVALID", "protocol", 502],
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
        { env: { ...process.env, INTENT_DRIVER: "http-model", INTENT_BASE_URL: baseUrl, INTENT_MODEL: "simple-mock", JOURNAL_MODEL: "mock", INTENT_API_KEY: "mock-only", INTENT_TIMEOUT_MS: "1000", JOURNAL_TIMEOUT_MS: "1000" } });
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
        { env: { ...process.env, INTENT_DRIVER: "http-model", INTENT_BASE_URL: baseUrl, INTENT_MODEL: "simple-mock", JOURNAL_MODEL: "mock", INTENT_API_KEY: "mock-only" } });
      let out = "", err = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
      child.on("error", reject); child.on("close", code => done({ code, out, err }));
      child.stdin.end(JSON.stringify({ target: { userId: owner.userId, email: authUserEmails[0], atlasId: owner.atlasId, journeyId },
        sentence: "导入并关联酒店", source, fallbackDate: "2028-06-01", provider: { baseUrl, model: "mock" } }));
    });
    expect(result.code, result.err).toBe(0); expect(result.out).not.toContain("星桥酒店");
    expect(JSON.parse(result.out)).toMatchObject({ mode: "model", stage: "journal-preview", statuses: { actual: 1, cancelled: 1 }, localClocks: 2 });
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.plan.after.chapters).toEqual(envelope.plan.after.chapters);
    expect(saved.plan.provider).toEqual({ baseUrl: expect.stringMatching(/^provider:[a-f0-9]{64}$/), model: "mock" });
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

it("durable streaming job shares validated use-case, resumes without another provider call, and never writes a journal",async()=>{
  await db.update(member).set({role:"owner"}).where(eq(member.userId,owner.userId));
  const j=await createJourneyForAtlas(owner.atlasId,owner.userId,{title:"stream fixture",startedOn:"2028-06-01",endedOn:"2028-06-09",note:"",lightColor:"#ffffff",routePoints:[{label:"旧点",latitude:1,longitude:2,isStop:true,occurredAt:null}]});
  const target={...owner,email:authUserEmails[0],journeyId:j!.id};
  const input={source,sentence:"导入原稿",fallbackDate:"2028-06-01",provider};const id=randomUUID();
  const before=await readDailyJournal(j!.id,owner.atlasId);let calls=0;
  journalImportDependencies.fetcher=async(url,init)=>{
    calls++;expect(JSON.parse(init!.body as string).stream).toBe(true);
    const value=await (await model.fetcher(url,init)).json();const call=value.choices[0].message.tool_calls[0];
    const chunks=[JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:"fixture-call",type:"function",function:{name:call.function.name,arguments:call.function.arguments.slice(0,20)}}]},finish_reason:null}]}),JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:call.function.arguments.slice(20)}}]},finish_reason:"tool_calls"}]})];
    return new Response(chunks.map(c=>`data: ${c}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
  };
  try{
    expect(await submitJournalJob(target,id,input)).toEqual({jobId:id});
    expect(await submitJournalJob(target,id,input)).toEqual({jobId:id});
    await expect(submitJournalJob(target,id,{...input,source:source+"x"})).rejects.toThrow("JOURNAL_JOB_CONFLICT");
    await expect(submitJournalJob(target,randomUUID(),input)).rejects.toThrow("JOURNAL_JOB_BUSY");
    await Promise.all([runJournalJob(),runJournalJob()]);
    const row=await readJournalJob(target,id);expect(row.status).toBe("completed");expect(row.payload).toBeNull();expect(calls).toBe(1);
    expect(validateEnvelope(row.envelope).plan.after.chapters).toHaveLength(1);
    expect((jobView(row) as any).planDigest).toBe(hash(row.envelope));
    await runJournalJob();expect(calls).toBe(1);
    expect((await cancelJournalJob(target,id)).status).toBe("completed");
    await expect(readJournalJob({...target,userId:other.userId,email:authUserEmails[1]},id)).rejects.toThrow();
    expect(await readDailyJournal(j!.id,owner.atlasId)).toEqual(before);
    const cancelled=randomUUID();await submitJournalJob(target,cancelled,input);await cancelJournalJob(target,cancelled);await runJournalJob();expect(calls).toBe(1);
    expect((await readJournalJob(target,cancelled)).envelope).toBeNull();
    // A running provider body is aborted; cancellation wins over all later completion writes.
    let upstream:AbortSignal|undefined;let began!:()=>void;const started=new Promise<void>(r=>{began=r;});
    journalImportDependencies.fetcher=async(_url,init)=>{calls++;upstream=init?.signal??undefined;began();return new Response(new ReadableStream(),{headers:{"content-type":"text/event-stream"}});};
    const running=randomUUID();await submitJournalJob(target,running,input);const worker=runJournalJob();await started;
    await cancelJournalJob(target,running);await worker;expect(upstream?.aborted).toBe(true);
    expect(await readJournalJob(target,running)).toMatchObject({status:"cancelled",payload:null,envelope:null});
    const count=calls;const stale=randomUUID();await submitJournalJob(target,stale,input);
    await pool.query("UPDATE journal_import_jobs SET status='running',updated_at=now()-interval '30 seconds' WHERE id=$1",[stale]);
    await runJournalJob();expect((await readJournalJob(target,stale)).status).toBe("interrupted");expect(calls).toBe(count);
    const changed=randomUUID();await submitJournalJob(target,changed,input);
    await writeDailyJournal(j!.id,owner.atlasId,0,previewJournalImport("2028-05-01\n实际：手工内容。","2028-05-01"));
    await runJournalJob();expect((await readJournalJob(target,changed)).error).toMatchObject({error:"JOURNAL_CHANGED"});expect(calls).toBe(count);
    const revoked=randomUUID();await submitJournalJob(target,revoked,input);await db.update(member).set({role:"viewer"}).where(eq(member.userId,owner.userId));
    await runJournalJob();await expect(readJournalJob(target,revoked)).rejects.toThrow("TARGET_PERMISSION_DENIED");
    await db.update(member).set({role:"owner"}).where(eq(member.userId,owner.userId));
    expect((await readJournalJob(target,revoked)).error).toMatchObject({error:"TARGET_PERMISSION_DENIED"});expect(calls).toBe(count);

  }finally{journalImportDependencies.fetcher=model.fetcher;}
});
it('provider discovery returns only an opaque identity and safe hostname, never URL credentials',async()=>{
  const previous=serverConfig.intentBaseUrl;
  Object.assign(serverConfig,{intentBaseUrl:'https://user:private-password@model.example.test/private-path-secret/v1?credential=private-query'});
  try{
    const response=await app.request(`${TEST_ORIGIN}/api/intents/journal-import/provider`,{headers:authHeaders(owner.cookie)});
    expect(response.status).toBe(200);const data=await response.json();
    expect(data.baseUrl).toMatch(/^provider:[a-f0-9]{64}$/);expect(data.displayName).toBe('model.example.test');
    const synchronous=await request(owner.cookie,{baseUrl:data.baseUrl,model:data.model});expect(synchronous.status).toBe(200);
    const output=JSON.stringify({data,result:await synchronous.json()});for(const secret of ['private-password','private-path-secret','private-query','mock-only'])expect(output).not.toContain(secret);
  }finally{Object.assign(serverConfig,{intentBaseUrl:previous});}
});

it.each(["queued", "running"])("stops a %s job after a journal-model change without fallback or replay", async phase => {
  await db.update(member).set({ role: "owner" }).where(eq(member.userId, owner.userId));
  const target = { ...owner, email: authUserEmails[0], journeyId };
  const before = await readDailyJournal(journeyId, owner.atlasId), id = randomUUID();
  const calls = vi.fn(async () => {
    Object.assign(serverConfig, { journalModel: "different-journal-model" });
    // A malformed argument answer would normally be correctable. Configuration
    // changes must stop the next call, not send that source to either model again.
    const call = { index: 0, id: "changed-model-call", type: "function", function: { name: "stage_journal_import", arguments: "{}" } };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  journalImportDependencies.fetcher = calls;
  try {
    await submitJournalJob(target, id, { source, sentence: "导入合成记录", fallbackDate: "2028-06-01", provider });
    if (phase === "queued") Object.assign(serverConfig, { journalModel: "different-journal-model" });
    await runJournalJob();
    const row = await readJournalJob(target, id);
    expect(row.status).toBe("failed");
    expect(row.error.error).toBe("JOURNAL_PROVIDER_CONFIRMATION_REQUIRED");
    expect(row.envelope).toBeNull();
    expect(calls).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
    Object.assign(serverConfig, { journalModel: provider.model });
    await runJournalJob();
    expect(calls).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
    expect(await readDailyJournal(journeyId, owner.atlasId)).toEqual(before);
  } finally {
    Object.assign(serverConfig, { journalModel: provider.model });
    journalImportDependencies.fetcher = model.fetcher;
  }
});

for (const path of ["sync", "job"] as const) {
  it.each([
    "chapter-unknown-with-value", "event-unknown-with-value", "range", "unresolved",
    "incomplete-left-chapter-unknown-with-value", "incomplete-left-event-unknown-with-value",
    "incomplete-right-chapter-unknown-with-value", "incomplete-right-event-unknown-with-value",
    "incomplete-left-unresolved", "incomplete-right-unresolved", "quantity-chapter", "quantity-event",
  ] as const)(`${path} date evidence: %s cannot bypass validation or change existing data`, async scenario => {
    const j = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "date evidence fixture", startedOn: "2028-06-01", endedOn: "2028-06-09", note: "keep", lightColor: "#ffffff", routePoints: [{ label: "旧点", latitude: 1, longitude: 2, isStop: true, occurredAt: null }] });
    const target = { ...owner, email: authUserEmails[0], journeyId: j!.id };
    const manual = previewJournalImport("2028-05-01\n实际：手工内容。", "2028-05-01");
    manual[0].events[0].text = "edited prior text"; manual[0].events[0].edited = true;
    await writeDailyJournal(j!.id, owner.atlasId, 0, manual);
    const before = await readDailyJournal(j!.id, owner.atlasId), journeyBefore = await getJourneyForAtlas(j!.id, owner.atlasId);
    expect(journeyBefore).toBeDefined(); expect(journeyBefore!.routePoints).toHaveLength(1);
    const incomplete = scenario.startsWith("incomplete-"), quantity = scenario.startsWith("quantity-");
    const evidence = incomplete
      ? scenario.startsWith("incomplete-left-") ? "（2028年6月？日）到（2028年6月5日）" : "（2028年6月5日）到（2028年？月5日）"
      : "（2028年6月3日）到（2028年6月5日）";
    const text = quantity ? "她于2028年6月3日到（3.5公里外的酒店）入住。" : `记录：${evidence}。她沿湖步行。`;
    const singleDate = quantity ? "2028-06-03" : "2028-06-05";
    const singleQuote = quantity ? "2028年6月3日" : "2028年6月5日";
    const chapterHasValue = scenario.endsWith("chapter-unknown-with-value") || scenario === "quantity-chapter";
    const eventHasValue = scenario.endsWith("event-unknown-with-value") || scenario === "quantity-event";
    const payload = { chapters: [{ firstLine: 0, lastLine: 0, heading: false,
      dateStatus: quantity ? chapterHasValue ? "single" : "absent" : scenario === "range" ? "range" : "unknown",
      questions: quantity ? [] : ["日期范围待确认"],
      date: chapterHasValue ? singleDate : scenario === "range" ? "2028-06-03" : null,
      dateEnd: scenario === "range" ? "2028-06-05" : null,
      dateEvidence: quantity ? chapterHasValue ? singleQuote : null : evidence,
      events: [{ line: 0, status: "actual", dateStatus: quantity ? eventHasValue ? "single" : "absent" : "unknown", localDate: eventHasValue ? singleDate : null,
        dateEvidence: quantity ? eventHasValue ? singleQuote : null : evidence, time: null, timeEnd: null, timeEvidence: null, placeName: null, questions: quantity ? [] : ["日期范围待确认"] }] }] };
    let calls = 0;
    journalImportDependencies.fetcher = async (_url, init) => {
      calls++;
      const fn = { name: "stage_journal_import", arguments: JSON.stringify(payload) };
      if (!JSON.parse(init!.body as string).stream) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: `mock-${randomUUID()}`, type: "function", function: fn }] } }] });
      const chunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `date-fixture-${calls}`, type: "function", function: fn }] }, finish_reason: "tool_calls" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const input = { source: text, sentence: "导入合成日期记录", fallbackDate: "2028-06-01", provider };
      // An unknown claim with a value never reaches the preview: the claim is dropped and the line keeps
      // its status, with no correction call; a dropped event date adds a question.
      const invalid = scenario.endsWith("unknown-with-value"), chapterInvalid = scenario.endsWith("chapter-unknown-with-value"); let result: Envelope | null = null;
      if (path === "sync") {
        const response = await app.request(`${TEST_ORIGIN}/api/intents/journal-import`, { method: "POST", headers: authHeaders(owner.cookie), body: JSON.stringify({ ...input, journeyId: j!.id }) });
        expect(response.status).toBe(200);
        result = (await response.json()).envelope;
      } else {
        const id = randomUUID(); await submitJournalJob(target, id, input); await runJournalJob();
        const row = await readJournalJob(target, id);
        expect(row.status).toBe("completed");
        expect(row.degraded_lines).toBe(0);
        expect(jobView(row)).toMatchObject({ degradedLines: 0, degradations: [] });
        result = row.envelope;
      }
      const plan = validateEnvelope(result).plan;
      expect(plan.after.chapters[0]).toEqual(before!.chapters[0]);
      const added = plan.after.chapters[1]; expect(added.source).toBe(text);
      if (invalid) {
        expect(added.date).toBe("2028-06-01");
        expect(added.events[0]).toMatchObject({ status: "actual", localDate: null, text });
        expect(added.suggestions[0].questions.includes(JOURNAL_DROPPED_CLAIM_QUESTION)).toBe(!chapterInvalid);
        if (chapterInvalid) expect(added.suggestions[0].questions).toContain("章节日期未明确，暂用指定归档日。");
      } else {
        expect(added.events[0].localDate).toBe(eventHasValue ? singleDate : null);
        if (quantity) {
          expect(added.date).toBe(chapterHasValue ? singleDate : "2028-06-01");
          expect(added.suggestions[0].questions.join()).not.toMatch(/日期范围|日期区间/);
        } else expect(added.suggestions[0].questions.join()).toContain(scenario === "range" ? "2028-06-03 至 2028-06-05" : "日期范围待确认");
      }
      expect(calls).toBe(1);
      expect(await readDailyJournal(j!.id, owner.atlasId)).toEqual(before);
      expect(await getJourneyForAtlas(j!.id, owner.atlasId)).toEqual(journeyBefore);
    } finally { journalImportDependencies.fetcher = model.fetcher; }
  });
}

for (const mode of ["sync", "job"] as const) {
  it.each(["correct", "version", "permission", ...(mode === "job" ? ["cancel"] : [])])(`${mode}: argument correction respects %s state`, async change => {
    const j = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "correction fixture", startedOn: "2028-06-01", endedOn: "2028-06-09", note: "", lightColor: "#ffffff", routePoints: [{ label: "合成起点", latitude: 1, longitude: 2, isStop: true, occurredAt: null }] });
    const target = { ...owner, email: authUserEmails[0], journeyId: j!.id }, jobId = randomUUID();
    const input = { source, sentence: "导入合成记录", fallbackDate: "2028-06-01", provider };
    let calls = 0;
    journalImportDependencies.fetcher = async (url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)), payload = await (await model.fetcher(url, init)).json();
      const call = payload.choices[0].message.tool_calls[0];
      if (calls === 1) {
        const args = JSON.parse(call.function.arguments); args.chapters[0].events[0].latitude = 1; call.function.arguments = JSON.stringify(args);
        if (change === "version") await writeDailyJournal(j!.id, owner.atlasId, 0, previewJournalImport("她后来手工记录。", "2028-06-01"));
        if (change === "permission") await db.update(member).set({ role: "viewer" }).where(eq(member.userId, owner.userId));
        if (change === "cancel") await cancelJournalJob(target, jobId);
      } else {
        expect(body.messages.at(-1).role).toBe("tool");
        expect(body.messages.at(-1).tool_call_id).toBe(body.messages.at(-2).tool_calls[0].id);
        expect(JSON.parse(body.messages.at(-1).content).error.code).toBe("EXTRA_ARGUMENT");
      }
      if (!body.stream) return Response.json(payload);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    };
    try {
      if (mode === "sync") {
        const response = await app.request(`${TEST_ORIGIN}/api/intents/journal-import`, { method: "POST", headers: authHeaders(owner.cookie), body: JSON.stringify({ ...input, journeyId: j!.id }) });
        const output = await response.json();
        if (change === "correct") { expect(response.status).toBe(200); expect(output.envelope).toBeDefined(); }
        else { expect(response.status).toBe(change === "version" ? 409 : 404); expect(output.envelope).toBeUndefined(); expect(output.error).toBe(change === "version" ? "JOURNAL_CHANGED" : "JOURNEY_NOT_FOUND"); }
      } else {
        await submitJournalJob(target, jobId, input); await runJournalJob();
        if (change === "permission") await db.update(member).set({ role: "owner" }).where(eq(member.userId, owner.userId));
        const row = await readJournalJob(target, jobId);
        expect(row.status).toBe(change === "correct" ? "completed" : change === "cancel" ? "cancelled" : "failed");
        if (change === "version" || change === "permission") expect(row.error.error).toBe(change === "version" ? "JOURNAL_CHANGED" : "TARGET_PERMISSION_DENIED");
        if (change !== "correct") expect(row.envelope).toBeNull();
      }
      expect(calls).toBe(change === "correct" ? 2 : 1);
      const saved = await readDailyJournal(j!.id, owner.atlasId);
      expect(saved!.revision).toBe(change === "version" ? 1 : 0);
      if (change === "version") expect(saved!.chapters[0].source).toBe("她后来手工记录。");
    } finally {
      journalImportDependencies.fetcher = model.fetcher;
      await db.update(member).set({ role: "owner" }).where(eq(member.userId, owner.userId));
    }
  });
}

it.each(["sync", "job"] as const)("%s preserves repeated source through chapter joining, preview, signed save and replay", async mode => {
  const j = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "repeated source fixture", startedOn: "2028-06-01", endedOn: "2028-06-09", note: "", lightColor: "#ffffff", routePoints: [{ label: "合成起点", latitude: 1, longitude: 2, isStop: true, occurredAt: null }] });
  const target = { ...owner, email: authUserEmails[0], journeyId: j!.id }, jobId = randomUUID();
  const text = "她在湖边散步。", repeated = `${text}\n${text}`, input = { source: repeated, sentence: "导入合成记录", fallbackDate: "2028-06-01", provider };
  let calls = 0;
  journalImportDependencies.fetcher = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body)), first = mockChapter(text), second = mockChapter(text);
    second.firstLine = second.lastLine = second.events[0].line = 1;
    const response = toolResponse("stage_journal_import", { chapters: [first, second] });
    if (!request.stream) return response;
    const call = (await response.json()).choices[0].message.tool_calls[0];
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  try {
    let result: Envelope;
    if (mode === "sync") {
      const response = await app.request(`${TEST_ORIGIN}/api/intents/journal-import`, { method: "POST", headers: authHeaders(owner.cookie), body: JSON.stringify({ ...input, journeyId: j!.id }) });
      expect(response.status).toBe(200); result = (await response.json()).envelope;
    } else {
      await submitJournalJob(target, jobId, input); await runJournalJob();
      const row = await readJournalJob(target, jobId); expect(row.status).toBe("completed"); result = row.envelope;
    }
    const checked = validateEnvelope(result);
    expect(calls).toBe(1); expect(checked.plan.importedChapterIds).toHaveLength(1);
    expect(checked.plan.after.chapters.map(c => c.source).join("\n")).toBe(repeated);
    expect(checked.plan.after.chapters[0].events.map(e => e.source)).toEqual([text, text]);
    expect(readJournalImportSnapshot({ jobId, status: "completed", envelope: checked, planDigest: hash(checked) }, jobId,
      { journeyId: j!.id, atlasId: owner.atlasId, ...input })).toEqual({ status: "completed", draft: { revision: 0, chapters: checked.plan.after.chapters } });
    expect((await readDailyJournal(j!.id, owner.atlasId))!.revision).toBe(0);
    const backup = vi.fn(async () => {});
    expect((await applyImport(checked, hash(checked), backup)).state).toBe("applied");
    expect((await applyImport(checked, hash(checked), backup)).state).toBe("already-applied");
    expect(backup).toHaveBeenCalledTimes(1);
    expect((await readDailyJournal(j!.id, owner.atlasId))!.chapters[0].events.map(e => e.source)).toEqual([text, text]);
  } finally { journalImportDependencies.fetcher = model.fetcher; }
});

it("automatically links an exact existing place in the signed preview, preserving existing links on replay", async () => {
  const journey = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: "合成地点关联", startedOn: "2028-06-03", endedOn: "2028-06-03", note: "", lightColor: "#ffffff",
    routePoints: [{ label: "星桥花园", latitude: 1, longitude: 2, isStop: true, occurredAt: null }] });
  const text = "实际：她在星桥花园看花。", chapter = mockChapter(text);
  Object.assign(chapter.events[0], { placeName: "星桥花园" });
  const target = { userId: owner.userId, atlasId: owner.atlasId, email: (await db.select().from(authUsers).where(eq(authUsers.id, owner.userId)))[0].email, journeyId: journey!.id };
  const input = { source: text, sentence: "导入并关联已有地点", fallbackDate: "2028-06-03", provider };
  const requestModes: boolean[] = [];
  const mock = { ...model, fetcher: async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    requestModes.push(request.stream === true);
    const response = toolResponse("stage_journal_import", { chapters: [chapter] });
    if (!request.stream) return response;
    const call = (await response.json()).choices[0].message.tool_calls[0];
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } };
  const envelope = await prepareAuthorizedJournalImport(target, input, mock);
  expect(envelope.plan.after.chapters[0].events[0]).toMatchObject({ routePointId: journey!.routePoints[0].id, localDate: null, localTime: null, mediaIds: [] });
  expect((await readDailyJournal(journey!.id, owner.atlasId))!.chapters).toEqual([]);
  const previousFetcher = journalImportDependencies.fetcher;
  try {
    journalImportDependencies.fetcher = mock.fetcher;
    const job = await submitJournalJob(target, randomUUID(), input);
    await runJournalJob();
    const row = await readJournalJob(target, job.jobId);
    expect(row.status, row.error?.error).toBe("completed");
    expect((row.envelope as Envelope).plan.after).toEqual(envelope.plan.after);
  } finally { journalImportDependencies.fetcher = previousFetcher; }
  await applyImport(envelope, hash(envelope), async () => undefined);
  const replay = await prepareAuthorizedJournalImport(target, input, mock);
  expect(replay.plan.after).toEqual(envelope.plan.after);
  expect(replay.plan.before.revision).toBe(replay.plan.after.revision);
  expect(requestModes).toEqual([false, true, false]);
});
