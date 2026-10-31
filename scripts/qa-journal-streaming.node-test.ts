/** Run: node --import tsx --test scripts/qa-journal-streaming.node-test.ts
 * Independent acceptance tests; intentionally outside the default Vitest glob.
 * SSE fixtures exercise the actual production parser, never a QA parser.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { prepareJournalImport } from '../server/itinerary/journal-import-workflow';
import { requestIntentModelAnswer } from '../server/intents/intent-model-request';
import { ShareIntentError } from '../server/intents/create-share-intent';
import { qaInput, qaDraft, qaLines, qaModel as baseModel, qaAnswer, qaSse, qaResponse, qaToolName, qaDelta, qaFrame } from './qa-journal-streaming-fixtures';
const qaModel = { ...baseModel, timeoutMs: 1, stream: { connectTimeoutMs: 30_000, firstByteTimeoutMs: 30_000, idleTimeoutMs: 30_000 } };
const empty = () => ({ revision: 0, chapters: [] });
const request = { systemPrompt: 'synthetic tool', userContent: 'synthetic', schemaName: 'qa', schema: {}, toolName: qaToolName,
  providerName: 'synthetic', fail: (code: string, message: string, status?: number) => new ShareIntentError(code, message, status) };
const prepare = (payload = qaDraft(), before = empty()) => prepareJournalImport(qaInput, before, { ...qaModel, fetcher: qaAnswer(payload) });

test('evidence: all source lines, range context, statuses and date-line order survive', async () => {
  const result = await prepare();
  assert.equal(result.chapters.map(c => c.source).join('\n'), qaInput.source);
  assert.deepEqual(result.chapters.flatMap(c => c.events.map(e => e.source)), qaLines.filter((_, i) => [1, 2, 3, 4, 7, 8].includes(i)));
  assert.deepEqual(result.chapters.flatMap(c => c.events.map(e => e.status)), ['actual', 'planned', 'cancelled', 'uncertain', 'actual', 'actual']);
  assert.deepEqual(result.chapters.flatMap(c => c.events.map(e => e.localTime)), ['23:30', '07:30', '08:00', null, null, '18:20']);
  assert.ok(result.chapters.flatMap(c => c.events).every(e => e.localDate === null && e.routePointId === null));
  assert.match(result.chapters[1].events[0].timeContext, /晚上11:30–凌晨1:00/);
  assert.ok(result.chapters[0].suggestions.every(s => s.questions.some(q => q.includes('未推断逐日分配'))));
});

test('evidence: one invalid final event rejects the entire result without mutating prior content', async () => {
  const first = await prepare(), before = { revision: 3, chapters: first.chapters };
  before.chapters[0].events[0].text = 'member correction'; before.chapters[0].events[0].edited = true;
  const snapshot = structuredClone(before), malformed = qaDraft(); malformed.chapters[1].events[1].evidence = 'fabricated';
  await assert.rejects(prepareJournalImport(qaInput, before, { ...qaModel, fetcher: qaAnswer(malformed) }), { code: 'JOURNAL_IMPORT_MALFORMED' });
  assert.deepEqual(before, snapshot);
  const replay = await prepareJournalImport(qaInput, before, { ...qaModel, fetcher: qaAnswer(qaDraft()) });
  assert.deepEqual(replay.chapters, before.chapters);
  assert.deepEqual(replay.importedChapterIds, first.importedChapterIds);
});

for (const fault of ['omitted-event', 'overlap', 'gap', 'duplicate-event', 'invented-date', 'cropped-meridiem', 'truncated-range'] as const) {
  test(`evidence: reject ${fault}`, async () => {
    const payload = qaDraft();
    if (fault === 'omitted-event') payload.chapters[1].events.pop();
    if (fault === 'overlap') payload.chapters[1].firstLine = 5;
    if (fault === 'gap') payload.chapters[1].firstLine = 7;
    if (fault === 'duplicate-event') payload.chapters[0].events[1] = payload.chapters[0].events[0];
    if (fault === 'invented-date') payload.chapters[1].date = '2028-06-07';
    if (fault === 'cropped-meridiem') Object.assign(payload.chapters[1].events[0], { time: '11:30', timeEnd: null, timeEvidence: '11:30' });
    if (fault === 'truncated-range') Object.assign(payload.chapters[0].events[3], { timeEnd: null, timeEvidence: '10:30' });
    await assert.rejects(prepare(payload), { code: 'JOURNAL_IMPORT_MALFORMED' });
  });
}

test('evidence: a markdown date heading containing a hotel stay cannot hide that event', async () => {
  const source = '### 2028年6月3日 实际：她在虚构城入住星桥酒店。\n计划：次日离开。';
  const payload = { chapters: [{ firstLine: 0, lastLine: 1, date: '2028-06-03', dateEnd: null, dateEvidence: '2028年6月3日', events: [
    { line: 1, evidence: '计划：次日离开。', status: 'planned', localDate: null, dateEvidence: null, time: null, timeEnd: null, timeEvidence: null, reading: '', questions: [] },
  ] }] };
  await assert.rejects(prepareJournalImport({ ...qaInput, source }, empty(), { ...qaModel, fetcher: qaAnswer(payload) }), { code: 'JOURNAL_IMPORT_MALFORMED' });
});

test('SSE: requests streaming and assembles tool arguments across single-byte UTF-8 chunks and usage', async () => {
  let calls = 0, sent: Record<string, unknown> | undefined;
  const expected = { value: '星桥酒店🌉', line: 'first\nsecond', escaped: '\\"' };
  const result = await requestIntentModelAnswer({ ...qaModel, fetcher: (async (_url, init) => {
    calls++; sent = JSON.parse(String(init?.body));
    return qaResponse(qaSse(expected), 1);
  }) as typeof fetch }, request);
  assert.equal(sent?.stream, true); assert.deepEqual(result, expected); assert.equal(calls, 1);
});

for (const [kind, finish, done] of [['EOF', null, false], ['length', 'length', true], ['content-filter', 'content_filter', true]] as const) {
  test(`SSE: complete-looking JSON followed by ${kind} never becomes success`, async () => {
    let value: unknown = undefined;
    try { value = await requestIntentModelAnswer({ ...qaModel, fetcher: async () => qaResponse(qaSse({ valid: true }, finish, done)) }, request); }
    catch (error) { assert.ok(error instanceof Error); }
    assert.ok(value === undefined || value === null, 'incomplete/failed provider output must not become a writable answer');
  });
}

test('SSE: a stream failure after a valid JSON prefix is a transport failure', async () => {
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(qaDelta('{"valid":true}', true)));
    controller.error(new TypeError('synthetic disconnect'));
  } }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(requestIntentModelAnswer({ ...qaModel, fetcher: async () => response }, request), { code: 'INTENT_UNREACHABLE' });
});

test('SSE: ongoing chunks past 30 seconds do not trigger a total-duration abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let controller!: ReadableStreamDefaultController<Uint8Array>, transportSignal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const emit = (text: string) => controller.enqueue(new TextEncoder().encode(text));
  let completed = false;
  const pending = requestIntentModelAnswer({ ...qaModel, fetcher: (async (_url, init) => {
    transportSignal = init?.signal ?? undefined;
    transportSignal?.addEventListener('abort', () => controller.error(new DOMException('synthetic abort', 'AbortError')), { once: true });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch }, request).then(value => ({ value }), error => ({ error })).finally(() => { completed = true; });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  await flush(); emit(qaDelta('{"value":"', true)); await flush();
  for (let index = 0; index < 4; index++) { context.mock.timers.tick(10_000); await flush();
    assert.equal(transportSignal?.aborted, false, 'active stream aborted after total elapsed time');
    emit(qaDelta('a')); await flush();
  }
  assert.equal(completed, false);
  emit(qaDelta('"}')); emit(qaFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'); controller.close();
  assert.deepEqual(await pending, { value: { value: 'aaaa' } });
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
for (const phase of ['connection', 'first-byte', 'idle'] as const) {
  test(`SSE: ${phase} timeout aborts upstream without another request`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let calls = 0, transportSignal: AbortSignal | undefined, bodyController: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      calls++; transportSignal = init?.signal ?? undefined;
      if (phase === 'connection') return new Promise<Response>((_resolve, reject) => {
        transportSignal?.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')), { once: true });
      });
      const body = new ReadableStream<Uint8Array>({ start(c) { bodyController = c;
        transportSignal?.addEventListener('abort', () => c.error(new DOMException('synthetic abort', 'AbortError')), { once: true });
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    let outcome: { value?: unknown; error?: unknown } | undefined;
    const pending = requestIntentModelAnswer({ ...qaModel, fetcher }, request).then(value => outcome = { value }, error => outcome = { error });
    await flush();
    if (phase === 'idle') {
      context.mock.timers.tick(20_000); await flush();
      bodyController!.enqueue(new TextEncoder().encode(qaDelta('{', true))); await flush();
    }
    context.mock.timers.tick(29_999); await flush();
    assert.equal(outcome, undefined, 'phase clock must be measured from most recent upstream data');
    context.mock.timers.tick(2); await flush();
    assert.equal(transportSignal?.aborted, true);
    assert.notEqual(outcome, undefined);
    const settled = await pending; assert.ok('error' in settled);
    assert.ok(settled.error instanceof ShareIntentError);
    assert.equal(settled.error.code, phase === 'connection' ? 'INTENT_CONNECT_TIMEOUT' : phase === 'first-byte' ? 'INTENT_FIRST_BYTE_TIMEOUT' : 'INTENT_IDLE_TIMEOUT');
    assert.equal(calls, 1);
  });
}

test('SSE: pre-aborted caller sends no provider request', async () => {
  const caller = new AbortController(); caller.abort(); let calls = 0;
  const options = { ...qaModel, stream: { ...qaModel.stream, signal: caller.signal }, fetcher: async () => { calls++; return qaResponse(qaSse({ valid: true })); } };
  await assert.rejects(requestIntentModelAnswer(options, request));
  assert.equal(calls, 0);
});

test('SSE: caller cancellation aborts the in-flight body before any terminal result', async () => {
  const caller = new AbortController(); let transportSignal: AbortSignal | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const options = { ...qaModel, stream: { ...qaModel.stream, signal: caller.signal }, fetcher: (async (_url: unknown, init?: RequestInit) => {
    transportSignal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c;
      c.enqueue(new TextEncoder().encode(qaDelta('{"valid":', true)));
      transportSignal?.addEventListener('abort', () => c.error(new DOMException('synthetic abort', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch };
  let outcome: unknown;
  const pending = requestIntentModelAnswer(options, request).then(value => outcome = { value }, error => outcome = { error });
  try {
    await flush(); caller.abort(); await flush();
    assert.equal(transportSignal?.aborted, true); assert.ok(outcome && 'error' in (outcome as object));
  } finally {
    if (!transportSignal?.aborted) controller.error(new TypeError('QA cleanup'));
    await pending;
  }
});

test('SSE: real local HTTP byte writes traverse production fetch and parser', async () => {
  let calls = 0, sent: Record<string, unknown> | undefined;
  const expected = { value: '星桥🌉', complete: true };
  const server = createServer(async (req, res) => {
    calls++; let body = ''; for await (const part of req) body += part;
    sent = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    const bytes = Buffer.from(qaSse(expected));
    for (const byte of bytes) { if (res.destroyed) break; res.write(Uint8Array.of(byte)); await flush(); }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const actual = await requestIntentModelAnswer({ ...qaModel, baseUrl: `http://127.0.0.1:${address.port}/v1` }, request);
    assert.equal(sent?.stream, true); assert.deepEqual(actual, expected); assert.equal(calls, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('SSE: heartbeats and whitespace-only arguments do not renew semantic idle', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } });
  let outcome: unknown;
  const pending = requestIntentModelAnswer({ ...qaModel, fetcher }, request).then(value => outcome = { value }, error => outcome = { error });
  await flush(); controller.enqueue(new TextEncoder().encode(qaDelta('{', true))); await flush();
  for (let index = 0; index < 2; index++) {
    context.mock.timers.tick(10_000); await flush();
    controller.enqueue(new TextEncoder().encode(': keepalive\n\n' + qaDelta('   '))); await flush(); assert.equal(outcome, undefined);
  }
  context.mock.timers.tick(10_001); await flush();
  assert.ok(outcome && 'error' in (outcome as object));
  const settled = await pending; assert.ok('error' in settled); assert.ok(settled.error instanceof ShareIntentError); assert.equal(settled.error.code, 'INTENT_IDLE_TIMEOUT');
});

test('SSE: 32-second real HTTP stream completes without any total response deadline', { timeout: 45_000 }, async () => {
  const expected = { value: '持续输出🌉' }, serialized = JSON.stringify(expected);
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume only synthetic input */ } calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); res.write(qaDelta('', true));
    for (let index = 0; index < 4; index++) {
      await new Promise(resolve => setTimeout(resolve, 8_000)); if (res.destroyed) return;
      const start = Math.floor(index * serialized.length / 4), end = Math.floor((index + 1) * serialized.length / 4);
      res.write(qaDelta(serialized.slice(start, end)));
    }
    res.end(qaFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = performance.now();
  try {
    const address = server.address() as { port: number };
    const actual = await requestIntentModelAnswer({ ...qaModel, baseUrl: `http://127.0.0.1:${address.port}/v1` }, request);
    assert.deepEqual(actual, expected); assert.equal(calls, 1); assert.ok(performance.now() - started >= 31_000);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
