import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fetchWithLifetime } from '../src/fetchLifetime.ts';
import { modelRequest } from '../src/modelRequest.ts';

const encode = (content) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`);

function transport(pending) {
  let body, signal, cancelled = 0;
  const fetchResponse = async (next) => {
    signal = next;
    const stream = new ReadableStream({
      start(controller) {
        body = controller;
        next.addEventListener('abort', () => { try { controller.error(new Error('transport cancelled')); } catch {} }, { once: true });
      },
      cancel() { cancelled++; },
    });
    return new Response(stream);
  };
  return {
    request: (owner) => fetchWithLifetime(fetchResponse, owner, pending),
    push: (chunk) => body.enqueue(chunk),
    signal: () => signal,
    cancelled: () => cancelled,
  };
}

test('authenticated model stream stays live beyond 180 seconds and releases its request on DONE', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new Set();
  const connection = transport(pending);
  const deltas = [];
  const task = modelRequest(connection.request, true, (delta) => deltas.push(delta));
  await setImmediate();
  assert.equal(pending.size, 1);
  for (let index = 0; index < 6; index++) {
    t.mock.timers.tick(40000);
    assert.equal(connection.signal().aborted, false, 'Healthy body traffic must outlive the connection deadline');
    connection.push(encode('part'));
    await setImmediate();
  }
  connection.push(new TextEncoder().encode('data: [DONE]\n'));
  assert.equal(await task, 'part'.repeat(6));
  assert.equal(deltas.length, 6);
  assert.equal(connection.signal().aborted, true);
  assert.equal(pending.size, 0);
});

for (const cause of ['lesson', 'account']) {
  test(`${cause} cancellation still aborts an active authenticated response body and clears bookkeeping`, { timeout: 2000 }, async () => {
    const pending = new Set(), owner = new AbortController();
    const connection = transport(pending);
    const task = modelRequest(connection.request, true, undefined, owner.signal);
    const rejected = assert.rejects(task, /取消|cancelled/);
    await setImmediate();
    assert.equal(pending.size, 1);
    if (cause === 'lesson') owner.abort();
    else for (const controller of pending) controller.abort();
    await rejected;
    assert.equal(connection.signal().aborted, true);
    assert.equal(pending.size, 0);
  });
}

test('failed header acquisition aborts and removes its pending request', async () => {
  const pending = new Set(), owner = new AbortController();
  let signal;
  await assert.rejects(fetchWithLifetime(async (next) => { signal = next; throw new Error('offline'); }, owner.signal, pending), /offline/);
  assert.equal(signal.aborted, true);
  assert.equal(pending.size, 0);
});
