/** Integration QA. Requires the disposable local database; never uses production. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { qaInput, qaDraft, qaModel, qaResponse, qaSse, qaDelta } from './qa-journal-streaming-fixtures';
const database = new URL(process.env.DATABASE_URL ?? 'http://missing.invalid');
assert.ok(database.hostname === '127.0.0.1' && database.port === '55432' && database.pathname === '/qa_journal_streaming', 'QA requires its named disposable loopback database');
const { app } = await import('../server/app');
const { serverConfig } = await import('../server/config');
const { pool, db } = await import('../server/db/client');
const { createEmailVerificationToken } = await import('better-auth/api');
const { submitJournalJob, runJournalJob, readJournalJob, cancelJournalJob } = await import('../server/itinerary/journal-import-jobs');
const { journalImportDependencies, journalProviderInfo } = await import('../server/itinerary/journal-import-service');
const { createJourneyForAtlas } = await import('../server/repositories/journey-repository');
const { readDailyJournal } = await import('../server/repositories/daily-journal-repository');
const { validateEnvelope, applyImport, hash } = await import('../server/admin/journal-import');
const { member } = await import('../server/db/auth-schema');
const origin = 'http://127.0.0.1:5173';
const prefix = '/api/intents/journal-import';
const headers = (cookie = '') => ({ origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });
type Actor = { cookie: string; userId: string; email: string; atlasId: string; organizationId: string; journeyId: string };
const actors: Actor[] = [];
let owner: Actor, other: Actor;
const target = (actor: Actor) => ({ userId: actor.userId, email: actor.email, atlasId: actor.atlasId, journeyId: actor.journeyId });
const input = () => ({ ...qaInput, provider: { baseUrl: qaModel.baseUrl, model: qaModel.model } });
const original = { intentDriver: serverConfig.intentDriver, intentBaseUrl: serverConfig.intentBaseUrl, intentApiKey: serverConfig.intentApiKey, intentModel: serverConfig.intentModel };
async function createActor() {
  await pool.query('DELETE FROM rate_limit');
  const id = randomUUID(), email = `qa-stream-${id}@example.test`, password = 'qa-synthetic-password-123';
  const request = (path: string, data: unknown, cookie = '') => app.request(`${origin}/api/auth/${path}`, { method: 'POST', headers: headers(cookie), body: JSON.stringify(data) });
  const signup = await request('sign-up/email', { name: 'Fictional QA', email, password }); assert.equal(signup.status, 200);
  const token = await createEmailVerificationToken(serverConfig.authSecret, email);
  assert.equal((await app.request(`${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`, { headers: headers() })).status, 200);
  const signed = await request('sign-in/email', { email, password }); assert.equal(signed.status, 200);
  const cookie = signed.headers.get('set-cookie')?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0]; assert.ok(cookie);
  const { user } = await signed.json() as { user: { id: string } };
  const org = await request('organization/create', { name: 'Fictional QA', slug: `qa-${id}` }, cookie); assert.equal(org.status, 200);
  const organization = await org.json() as { id: string };
  const bootstrap = await app.request(`${origin}/api/atlases/bootstrap`, { method: 'POST', headers: headers(cookie), body: JSON.stringify({ title: 'Fictional QA', dedication: '' }) });
  assert.ok([200, 201].includes(bootstrap.status)); const { atlas } = await bootstrap.json() as { atlas: { id: string } };
  const journey = await createJourneyForAtlas(atlas.id, user.id, { title: 'Fictional QA', startedOn: '2028-06-01', endedOn: null, note: '', lightColor: '#ffffff', routePoints: [{ label: '虚构起点', latitude: 1, longitude: 2, isStop: true, occurredAt: null }] }); assert.ok(journey);
  const actor = { cookie, userId: user.id, email, atlasId: atlas.id, organizationId: organization.id, journeyId: journey.id }; actors.push(actor); return actor;
}
before(async () => {
  owner = await createActor(); other = await createActor();
  Object.assign(serverConfig, { intentDriver: 'http-model', intentBaseUrl: qaModel.baseUrl, intentModel: qaModel.model, intentApiKey: 'synthetic-key-only' });
});
after(async () => {
  journalImportDependencies.fetcher = undefined; Object.assign(serverConfig, original);
  for (const actor of actors.reverse()) {
    await pool.query('DELETE FROM atlases WHERE id=$1', [actor.atlasId]);
    await pool.query('DELETE FROM organization WHERE id=$1', [actor.organizationId]);
    await pool.query('DELETE FROM "user" WHERE id=$1', [actor.userId]);
  }
  await pool.end();
});
const get = (path: string, actor = owner) => app.request(`${origin}${prefix}${path}`, { headers: headers(actor.cookie) });
const cancel = (id: string, actor = owner) => app.request(`${origin}${prefix}/jobs/${id}/cancel`, { method: 'POST', headers: headers(actor.cookie) });
async function waitFor<T>(work: () => Promise<T>, predicate: (result: T) => boolean) {
  const until = Date.now() + 5_000;
  do { const result = await work(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < until);
  throw new Error('QA condition did not settle');
}

test('API: unauthenticated provider discovery preserves AUTH_REQUIRED/401', async () => {
  const response = await app.request(`${origin}${prefix}/provider`);
  assert.equal(response.status, 401); assert.equal((await response.json()).error, 'AUTH_REQUIRED');
});

test('API: provider discovery cannot disclose secrets embedded in configured URLs', async () => {
  const prior = serverConfig.intentBaseUrl;
  try {
    for (const baseUrl of ['https://qa-user:qa-password@provider.invalid/v1', 'https://provider.invalid/v1?api_key=qa-query-secret', 'https://provider.invalid/v1#qa-fragment-secret']) {
      Object.assign(serverConfig, { intentBaseUrl: baseUrl });
      const response = await get('/provider'); const text = await response.text();
      assert.ok(!text.includes('qa-password') && !text.includes('qa-query-secret') && !text.includes('qa-fragment-secret'), 'discovery returned a secret-bearing URL');
    }
  } finally { Object.assign(serverConfig, { intentBaseUrl: prior }); }
});

test('jobs: disconnect/reconnect observes the same request; explicit cancel aborts upstream and writes nothing', async () => {
  const id = randomUUID(), before = await readDailyJournal(owner.journeyId, owner.atlasId);
  let calls = 0, bodyCancelled = false;
  journalImportDependencies.fetcher = async () => {
    calls++;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(qaDelta('{', true))); }, cancel() { bodyCancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  await submitJournalJob(target(owner), id, input());
  const worker = runJournalJob();
  try {
    await waitFor(async () => calls, value => value === 1);
    assert.deepEqual(await submitJournalJob(target(owner), id, input()), { jobId: id });
    await assert.rejects(submitJournalJob(target(owner), id, { ...input(), source: qaInput.source + 'changed' }), /JOURNAL_JOB_CONFLICT/);
    for (let observer = 0; observer < 2; observer++) {
      const response = await get(`/jobs/${id}/events`); assert.equal(response.status, 200);
      const reader = response.body!.getReader(); const first = await reader.read();
      const text = new TextDecoder().decode(first.value); assert.match(text, /event: progress/); assert.ok(!text.includes(qaInput.source));
      await reader.cancel();
      assert.equal((await readJournalJob(target(owner), id)).status, 'running'); assert.equal(bodyCancelled, false); assert.equal(calls, 1);
    }
    assert.equal((await get(`/jobs/${id}`, other)).status, 404);
    assert.equal((await cancel(id, other)).status, 404);
    // A second editor in the same Atlas still cannot read another user's private job.
    await db.insert(member).values({ id: randomUUID(), organizationId: owner.organizationId, userId: other.userId, role: 'member', createdAt: new Date() });
    const switched = await app.request(`${origin}/api/auth/organization/set-active`, { method: 'POST', headers: headers(other.cookie), body: JSON.stringify({ organizationId: owner.organizationId }) }); assert.equal(switched.status, 200);
    assert.equal((await get(`/jobs/${id}`, other)).status, 404);
    assert.equal((await cancel(id, other)).status, 404);
    const cancelled = await cancel(id); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).status, 'cancelled');
    await worker; assert.equal(bodyCancelled, true); assert.equal(calls, 1);
    const row = await readJournalJob(target(owner), id); assert.equal(row.payload, null); assert.equal(row.envelope, null);
    await runJournalJob(); assert.equal(calls, 1);
    assert.deepEqual(await readDailyJournal(owner.journeyId, owner.atlasId), before);
  } finally { await cancelJournalJob(target(owner), id); await worker; }
});

test('jobs: cancelled queued work and stale worker leases are never reissued', async () => {
  let calls = 0; journalImportDependencies.fetcher = async () => { calls++; return qaResponse(qaSse(qaDraft())); };
  const cancelled = randomUUID(); await submitJournalJob(target(owner), cancelled, input()); await cancelJournalJob(target(owner), cancelled); await runJournalJob(); assert.equal(calls, 0);
  const interrupted = randomUUID(); await submitJournalJob(target(owner), interrupted, input());
  await pool.query("UPDATE journal_import_jobs SET status='running',lease=$2,updated_at=now()-interval '30 seconds' WHERE id=$1", [interrupted, randomUUID()]);
  await runJournalJob(); const row = await readJournalJob(target(owner), interrupted);
  assert.equal(row.status, 'interrupted'); assert.equal(row.payload, null); assert.equal(row.envelope, null); assert.equal(calls, 0);
  await submitJournalJob(target(owner), interrupted, input()); await runJournalJob(); assert.equal(calls, 0);
});

test('jobs: partial valid JSON without a successful terminal frame cannot create a plan or write a journal', async () => {
  const id = randomUUID(), before = await readDailyJournal(owner.journeyId, owner.atlasId);
  let calls = 0; journalImportDependencies.fetcher = async () => { calls++; return qaResponse(qaSse(qaDraft(), null, false)); };
  await submitJournalJob(target(owner), id, input()); await runJournalJob();
  const row = await readJournalJob(target(owner), id); assert.equal(row.status, 'failed'); assert.equal(row.envelope, null); assert.equal(row.payload, null);
  assert.equal(row.error.error, 'INTENT_STREAM_INVALID'); assert.equal(calls, 1);
  assert.deepEqual(await readDailyJournal(owner.journeyId, owner.atlasId), before);
  await runJournalJob(); assert.equal(calls, 1);
});

test('jobs: completed durable envelopes retain signatures, safe provider identity, replay and atomic apply', async () => {
  const journey = await createJourneyForAtlas(owner.atlasId, owner.userId, { title: 'Fictional completed QA', startedOn: '2028-06-01', endedOn: null, note: '', lightColor: '#ffffff', routePoints: [{ label: '虚构起点', latitude: 1, longitude: 2, isStop: true, occurredAt: null }] }); assert.ok(journey);
  const jobTarget = { ...target(owner), journeyId: journey.id }, id = randomUUID();
  const before = await readDailyJournal(journey.id, owner.atlasId), prior = serverConfig.intentBaseUrl;
  let calls = 0;
  try {
    Object.assign(serverConfig, { intentBaseUrl: 'https://provider.invalid/v1?api_key=qa-persisted-secret' });
    const provider = journalProviderInfo(); assert.match(provider.baseUrl, /^provider:/);
    const request = { ...qaInput, provider: { baseUrl: provider.baseUrl, model: provider.model } };
    journalImportDependencies.fetcher = async () => { calls++; return qaResponse(qaSse(qaDraft())); };
    await submitJournalJob(jobTarget, id, request); await Promise.all([runJournalJob(), runJournalJob()]);
    const row = await readJournalJob(jobTarget, id); assert.equal(row.status, 'completed'); assert.equal(row.payload, null); assert.equal(calls, 1);
    const envelope = validateEnvelope(row.envelope); assert.equal(envelope.plan.after.chapters.length, 2);
    assert.deepEqual(envelope.plan.provider, request.provider); assert.ok(!JSON.stringify(row.envelope).includes('qa-persisted-secret'));
    const response = await get(`/jobs/${id}`); assert.equal(response.status, 200);
    const snapshot = await response.json(); assert.equal(snapshot.planDigest, hash(envelope)); assert.deepEqual(snapshot.envelope, envelope);
    const events = await get(`/jobs/${id}/events`); const stream = await events.text(); assert.match(stream, /event: completed/); assert.ok(!stream.includes('qa-persisted-secret'));
    await submitJournalJob(jobTarget, id, request); await runJournalJob(); assert.equal(calls, 1);
    assert.equal((await cancelJournalJob(jobTarget, id)).status, 'completed');
    assert.deepEqual(await readDailyJournal(journey.id, owner.atlasId), before);
    await assert.rejects(applyImport(envelope, hash(envelope), async () => { throw new Error('QA_BACKUP_FAILED'); }), /QA_BACKUP_FAILED/);
    assert.deepEqual(await readDailyJournal(journey.id, owner.atlasId), before);
    let backups = 0;
    const results = await Promise.all([applyImport(envelope, hash(envelope), async () => { backups++; }), applyImport(envelope, hash(envelope), async () => { backups++; })]);
    assert.deepEqual(results.map(result => result.state).sort(), ['already-applied', 'applied']); assert.equal(backups, 1);
    const saved = await readDailyJournal(journey.id, owner.atlasId); assert.deepEqual(saved, envelope.plan.after);
  } finally { Object.assign(serverConfig, { intentBaseUrl: prior }); }
});

test('API: submit is same-origin, idempotent and bound to discovered provider identity', async () => {
  let calls = 0; journalImportDependencies.fetcher = async () => { calls++; return qaResponse(qaSse(qaDraft())); };
  const providerResponse = await get('/provider'); assert.equal(providerResponse.status, 200);
  const provider = await providerResponse.json(); assert.equal(provider.available, true); assert.match(provider.baseUrl, /^provider:/);
  const id = randomUUID(), body = { ...qaInput, journeyId: owner.journeyId, requestId: id, provider: { baseUrl: provider.baseUrl, model: provider.model } };
  const post = (data: unknown, originHeader = origin) => app.request(`${origin}${prefix}/jobs`, { method: 'POST', headers: { ...headers(owner.cookie), origin: originHeader }, body: JSON.stringify(data) });
  assert.equal((await post(body, 'https://foreign.invalid')).status, 403);
  assert.equal((await post({ ...body, provider: { ...body.provider, baseUrl: 'provider:wrong' } })).status, 400);
  const first = await post(body); assert.equal(first.status, 202); assert.deepEqual(await first.json(), { jobId: id });
  try {
    const second = await post(body); assert.equal(second.status, 202); assert.deepEqual(await second.json(), { jobId: id });
    assert.equal((await post({ ...body, source: body.source + 'changed' })).status, 409);
    assert.equal((await post({ ...body, requestId: randomUUID() })).status, 409);
    assert.equal(calls, 0);
  } finally { await cancelJournalJob(target(owner), id); }
});

test('CLI: submit exits while queued; later status/export resume that same job without another model request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-journal-streaming-')), refPath = join(directory, 'job.json'), planPath = join(directory, 'plan.json');
  const id = randomUUID(); let calls = 0;
  journalImportDependencies.fetcher = async () => { calls++; return qaResponse(qaSse(qaDraft())); };
  const cli = (args: string[], input?: unknown) => new Promise<{ code: number | null; out: string; err: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('server/admin/journal-import-cli.ts'), ...args], {
      env: { ...process.env, INTENT_DRIVER: 'http-model', INTENT_BASE_URL: qaModel.baseUrl, INTENT_MODEL: qaModel.model, INTENT_API_KEY: 'synthetic-key-only' },
    });
    let out = '', err = ''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data);
    child.on('error', reject); child.on('close', code => resolveResult({ code, out, err })); child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
  try {
    const submitted = await cli(['llm-job-submit', refPath], { target: target(owner), requestId: id, ...input() });
    assert.equal(submitted.code, 0, submitted.err); assert.deepEqual(JSON.parse(submitted.out), { jobId: id, stage: 'queued' }); assert.equal(calls, 0);
    assert.equal((await readJournalJob(target(owner), id)).status, 'queued');
    await runJournalJob(); assert.equal(calls, 1);
    for (let index = 0; index < 2; index++) {
      const status = await cli(['llm-job-status', refPath]); assert.equal(status.code, 0, status.err); assert.equal(JSON.parse(status.out).status, 'completed');
      assert.ok(!status.out.includes(qaInput.source) && !status.out.includes('星桥'));
    }
    const exported = await cli(['llm-job-export', refPath, planPath]); assert.equal(exported.code, 0, exported.err);
    const envelope = validateEnvelope(JSON.parse(await readFile(planPath, 'utf8'))); assert.equal(JSON.parse(exported.out).planDigest, hash(envelope));
    assert.equal(calls, 1); const journal = await readDailyJournal(owner.journeyId, owner.atlasId); assert.ok(journal); assert.equal(journal.revision, 0);
  } finally { await cancelJournalJob(target(owner), id); await rm(directory, { recursive: true, force: true }); }
});
