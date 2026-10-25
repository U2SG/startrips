import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { modelRequest } from '../src/modelRequest.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function lateResponse(counts) {
  return { ok: true, status: 200, body: {
    cancel: async () => { counts.cancelled++; },
    getReader: () => { counts.opened++; throw new Error('A retired response must not be read'); },
  } };
}

for (const stream of [false, true]) {
  test(`${stream ? 'streaming' : 'single'} first-byte deadline aborts fetch and cancels late headers`, { timeout: 2000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const headers = deferred(), started = deferred();
    const counts = { opened: 0, cancelled: 0 };
    let signal;
    const task = modelRequest((next) => { signal = next; started.resolve(); return headers.promise; }, stream,
      () => { assert.fail('Late output must not reach the lesson'); });
    const rejected = assert.rejects(task, /LLM 连接超时/);
    await started.promise;
    t.mock.timers.tick(60000);
    await rejected;
    assert.equal(signal.aborted, true);
    headers.resolve(lateResponse(counts));
    await setImmediate();
    assert.deepEqual(counts, { opened: 0, cancelled: 1 });
  });

  test(`${stream ? 'stream stall' : 'JSON body'} deadline closes its reader and ignores a late chunk`, { timeout: 2000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const chunk = deferred(), started = deferred();
    let signal, cancelled = 0, released = 0, accessed = 0, reads = 0;
    const reader = {
      read: () => { reads++; started.resolve(); return chunk.promise; },
      cancel: async () => { cancelled++; },
      releaseLock: () => { released++; },
    };
    const task = modelRequest(async (next) => {
      signal = next;
      return { ok: true, status: 200, body: { getReader: () => reader } };
    }, stream, () => { assert.fail('Cancelled output must not reach the lesson'); });
    const rejected = assert.rejects(task, stream ? /流式响应停滞/ : /LLM 响应超时/);
    await started.promise;
    t.mock.timers.tick(stream ? 45000 : 180000);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, 1);
    assert.equal(released, 1);
    chunk.resolve({ done: false, get value() { accessed++; return new TextEncoder().encode('late response'); } });
    await setImmediate();
    assert.equal(accessed, 0);
    assert.equal(reads, 1);
  });
}

test('either the lesson or the user can cancel an in-flight model request', { timeout: 2000 }, async () => {
  for (const index of [0, 1]) {
    const owners = [new AbortController(), new AbortController()];
    const headers = deferred(), started = deferred();
    const counts = { opened: 0, cancelled: 0 };
    let signal;
    const task = modelRequest((next) => { signal = next; started.resolve(); return headers.promise; }, false, undefined, owners.map((owner) => owner.signal));
    const rejected = assert.rejects(task, /LLM 请求已取消/);
    await started.promise;
    owners[index].abort();
    await rejected;
    assert.equal(signal.aborted, true);
    headers.resolve(lateResponse(counts));
    await setImmediate();
    assert.deepEqual(counts, { opened: 0, cancelled: 1 });
  }
});

test('a previously cancelled lesson never starts another paid request', async () => {
  const owner = new AbortController();
  owner.abort();
  await assert.rejects(modelRequest(() => { assert.fail('Fetch must not start'); }, false, undefined, owner.signal), /已取消/);
});

test('a successful non-streaming response returns the model text and releases the body', async () => {
  const response = new Response(JSON.stringify({ choices: [{ message: { content: 'lesson summary' } }] }));
  assert.equal(await modelRequest(async () => response, false), 'lesson summary');
  assert.equal(response.body.locked, false);
});

test('streaming DONE returns all deltas and closes a provider connection that stays open', async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\ndata: {"choices":[{"delta":{"content":" world"}}]}\ndata: [DONE]\n'));
    },
    cancel() { cancelled++; },
  });
  const deltas = [];
  assert.equal(await modelRequest(async () => new Response(body), true, (delta, full) => deltas.push([delta, full])), 'hello world');
  assert.deepEqual(deltas, [['hello', 'hello'], [' world', 'hello world']]);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('cancellation from a delta callback stops the rest of the same SSE chunk', async () => {
  const owner = new AbortController();
  const deltas = [];
  const response = new Response('data: {"choices":[{"delta":{"content":"first"}}]}\ndata: {"choices":[{"delta":{"content":"late"}}]}\ndata: [DONE]\n');
  await assert.rejects(modelRequest(async () => response, true, (delta) => {
    deltas.push(delta);
    owner.abort();
  }, owner.signal), /已取消/);
  assert.deepEqual(deltas, ['first']);
  assert.equal(response.body.locked, false);
});
