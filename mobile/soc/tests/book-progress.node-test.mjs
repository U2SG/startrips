import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncProgress } from '../src/books/progress.ts';

const progress = (savedAt) => ({ version: 1, page: 2, passage: 3, seconds: 4, signature: 'source', speed: 1, dramatic: true, savedAt });
const conflict = () => Object.assign(new Error('Conflict'), { status: 409 });

test('a stale revision refreshes and retries without reopening the book', async () => {
  const next = progress(200); let writes = 0, reads = 0;
  await syncProgress(next, {
    async read() { reads++; return progress(100); },
    async write(value) { assert.equal(value, next); if (++writes === 1) throw conflict(); },
  });
  assert.equal(reads, 1); assert.equal(writes, 2);
});

test('a newer remote checkpoint is retained and a later local update can still sync', async () => {
  let remote = progress(300), revision = 0, known = -1;
  const deps = {
    async read() { known = revision; return remote; },
    async write(value) { if (known !== revision) throw conflict(); remote = value; known = ++revision; },
  };
  await syncProgress(progress(200), deps); assert.equal(remote.savedAt, 300);
  await syncProgress(progress(400), deps); assert.equal(remote.savedAt, 400);
});

test('repeated conflicts and network failures remain recoverable on the next checkpoint', async () => {
  let failing = true, writes = 0;
  const deps = { async read() { return null; }, async write() { writes++; if (failing) throw conflict(); } };
  await assert.rejects(syncProgress(progress(100), deps), { status: 409 });
  assert.equal(writes, 2); failing = false;
  await syncProgress(progress(200), deps); assert.equal(writes, 3);
  await assert.rejects(syncProgress(progress(300), { async read() { assert.fail(); }, async write() { throw new Error('Offline'); } }), /Offline/);
});
