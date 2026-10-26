import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfflineShelf, audioKey, completePages } from '../src/books/offlineStore.ts';
const page = { page: 3, total: 48, signature: 'source-a', passages: [{ text: '原文。', speaker: '旁白', voice: 'Cherry', tone: 'neutral' }] };
const textbook = { id: 'book', title: '教材', numPages: 48 };
function fixture() {
  let raw = null, valid = true;
  const payloads = new Map();
  const deps = { read: async () => raw, write: async (value) => { raw = value; }, guard: () => { if (!valid) throw Error('switched'); },
    store: async (key) => { payloads.set(key, 'audio bytes'); return key; }, remove: async (uri) => { payloads.delete(uri); }, namespace: 'account-a' };
  return { deps, payloads, switchUser() { valid = false; }, make: () => new OfflineShelf(deps) };
}
test('download survives restart without provider URLs; partial pages are not marked complete', async () => {
  const f = fixture(); const shelf = f.make();
  const book = await shelf.ensure('world', textbook, 'dir', page.signature);
  await assert.rejects(shelf.putPage(book, page, true), /尚未下载完整/);
  assert.equal(completePages(book).length, 0);
  const key = audioKey(page, 0, 'Cherry');
  await shelf.putAudio(book, key, 'https://temporary.invalid/audio', new AbortController().signal);
  await shelf.putPage(book, page, true);
  const [restored] = await f.make().list();
  assert.equal(completePages(restored).length, 1);
  assert.ok(!JSON.stringify(restored).includes('temporary.invalid'));
  assert.ok(f.payloads.has(restored.audio[key]));
  assert.notEqual(key, audioKey(page, 0, 'Ryan'));
  assert.notEqual(key, audioKey({ ...page, signature: 'updated' }, 0, 'Cherry'));
  await f.make().remove(book.id); assert.equal(f.payloads.size, 0);
});
test('cancelled downloads retain committed phrases and delete late writes', async () => {
  const f = fixture(); const shelf = f.make();
  const book = await shelf.ensure('world', textbook, 'dir', page.signature);
  const controller = new AbortController();
  f.deps.store = async (key) => { f.payloads.set(key, 'late bytes'); controller.abort(); return key; };
  await assert.rejects(shelf.putAudio(book, audioKey(page, 0, 'Cherry'), 'url', controller.signal));
  assert.equal(f.payloads.size, 0); assert.equal(completePages(book).length, 0);
});
test('a cancelled voice replacement retains the old complete page', async () => {
  const f = fixture(); const shelf = f.make();
  const book = await shelf.ensure('world', textbook, 'dir', page.signature);
  await shelf.putAudio(book, audioKey(page, 0, 'Cherry'), 'old', new AbortController().signal);
  await shelf.putPage(book, page, true);
  const replacement = { ...page, passages: page.passages.map((p) => ({ ...p, voice: 'Ryan' })) };
  await assert.rejects(shelf.putPage(book, replacement, true), /尚未下载完整/);
  assert.equal(completePages(book)[0][1].passages[0].voice, 'Cherry');
  const [restored] = await f.make().list();
  assert.equal(completePages(restored)[0][1].passages[0].voice, 'Cherry');
});
test('replaced sources and switched accounts cannot silently reuse downloaded speech', async () => {
  const f = fixture(); const shelf = f.make();
  await shelf.ensure('world', textbook, 'dir', page.signature);
  await assert.rejects(shelf.ensure('world', textbook, 'dir', 'source-b'), /教材已更新/);
  f.switchUser(); await assert.rejects(shelf.list(), /switched/);
});
