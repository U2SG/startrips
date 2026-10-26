import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParagraphCache } from '../src/books/paragraphCache.ts';
import { wavDuration } from '../src/books/wav.ts';

function fixture() {
  let raw = null, writes = 0;
  const files = new Map(), removed = [];
  const deps = {
    namespace: 'user/book', guard() {}, async read() { return raw; }, async write(value) { raw = value; },
    async store(key, url) { const uri = `file-${++writes}`; files.set(uri, url); return uri; },
    async open(uri) { return files.has(uri) ? uri : null; }, async duration() { return 8; },
    async remove(uri) { removed.push(uri); files.delete(uri); }, release() {},
  };
  return { cache: new ParagraphCache(deps), reopen: () => new ParagraphCache(deps), files, removed };
}

test('cached paragraphs survive reopening; changing voice/source/model does not reuse another audio', async () => {
  const f = fixture(), signal = new AbortController().signal;
  let calls = 0;
  const generate = async () => { calls++; return `signed-provider-${calls}`; };
  const first = await f.cache.get('book-a/model/Cherry/original', signal, generate);
  assert.deepEqual(await f.reopen().get('book-a/model/Cherry/original', signal, generate), first);
  assert.equal(calls, 1);
  for (const key of ['book-a/model/Ryan/original', 'book-b/model/Cherry/original', 'book-a/other-model/Cherry/original']) await f.cache.get(key, signal, generate);
  assert.equal(calls, 4);
});

test('duplicate requests share one job and a missing audio file is regenerated', async () => {
  const f = fixture(), signal = new AbortController().signal;
  let calls = 0;
  const generate = async () => { calls++; return 'url'; };
  const [one, two] = await Promise.all([f.cache.get('same', signal, generate), f.cache.get('same', signal, generate)]);
  assert.deepEqual(one, two); assert.equal(calls, 1);
  f.files.delete(one.uri); await f.cache.get('same', signal, generate); assert.equal(calls, 2);
});

test('recent audio is bounded and repeated use protects a paragraph from eviction', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const one = await f.cache.get('one', signal, async () => 'url');
  for (let i = 0; i < 127; i++) await f.cache.get(String(i), signal, async () => 'url');
  await f.cache.get('one', signal, async () => assert.fail('Cached audio must be reused'));
  await f.cache.get('new', signal, async () => 'url');
  assert.equal(f.files.size, 128); assert.ok(f.files.has(one.uri)); assert.equal(f.removed.length, 1);
});

test('WAV duration uses RIFF chunks and rejects truncated audio', () => {
  const bytes = Buffer.alloc(44 + 16000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt32LE(16000, 28); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
  assert.equal(wavDuration(bytes), 1);
  assert.throws(() => wavDuration(bytes.subarray(0, 100)), /不完整/);
});
