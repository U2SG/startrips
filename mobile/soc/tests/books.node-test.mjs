import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { splitBookText, annotatePassages, restoreBookmark, isSpeakable, legacyPassageIndices } from '../src/books/model.ts';
import { BookEngine } from '../src/books/engine.ts';

const page = (number = 1) => ({ page: number, total: 2, signature: 'book-a', passages: ['第一句。', '第二句！', '第三句？'].map((text) => ({ text, speaker: '旁白', voice: 'Cherry', tone: 'neutral' })) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const saved = [], played = [], removed = [], sought = [];
  const engine = new BookEngine({
    page: async (n) => page(n), audio: async (p, i) => `${p.page}-${i}.wav`, remove: (uri) => removed.push(uri),
    save: async (b) => { saved.push(b); }, focus() {},
    player: { async load(uri, seconds, rate) { played.push({ uri, seconds, rate }); }, play() {}, pause() {}, async seek(n) { sought.push(n); }, rate() {}, release() {} },
    ...overrides,
  });
  return { engine, saved, played, removed, sought };
}

test('book segmentation preserves every non-whitespace character, including Markdown and emoji', () => {
  const text = '\n*轻声说*：“你好！”\n' + '🙂长段落'.repeat(180) + '。最后一页\n';
  const chunks = splitBookText(text);
  assert.equal(chunks.join('').replace(/\s/gu, ''), text.replace(/\s/gu, ''));
  assert.ok(chunks.every((chunk) => Array.from(chunk.trim()).length <= 240));
  assert.ok(chunks.some((chunk) => chunk.includes('*轻声说*')));
});

test('closing quotes and punctuation-only paragraphs never become TTS jobs', () => {
  const source = '“好，你还好吗？\n”\n你还好吗？\n她不知道。\n她站在那里，拿着电话。\n“喂，喂，你听到了吗？\n”';
  const texts = splitBookText(source);
  assert.ok(texts.every(isSpeakable));
  assert.equal(texts.join('').replace(/\s/gu, ''), source.replace(/\s/gu, ''));
  assert.ok(texts[0].includes('”'));
  assert.deepEqual(splitBookText('”\n……！？'), []);
  const current = { ...page(), passages: texts.map((text) => ({ text, speaker: '旁白', voice: 'Cherry', tone: 'neutral' })), legacyIndices: legacyPassageIndices(source, texts) };
  const restored = restoreBookmark({ version: 1, signature: 'book-a', page: 1, passage: 2, seconds: 3 }, current);
  assert.equal(restored.passage, 1); assert.equal(restored.seconds, 0);
  const next = restoreBookmark({ ...restored, seconds: 4 }, current);
  assert.equal(next.passage, 1); assert.equal(next.seconds, 4);
});

test('an old punctuation-only checkpoint is advanced without sending punctuation to TTS', async () => {
  const requests = [];
  const p = page(); p.passages[0].text = '”';
  const { engine } = fixture({ page: async () => p, audio: async (_, i) => { requests.push(i); return `${i}.wav`; } });
  await engine.open(); await engine.play();
  assert.equal(engine.getState().bookmark.passage, 1);
  assert.ok(!requests.includes(0)); engine.dispose();
});

test('hot voice changes discard current and prefetched audio, preserve position, and cancel stale loads', async () => {
  let voice = 'Cherry';
  const pending = deferred();
  const { engine, played, removed } = fixture({ audio: async (_, i) => i === 0 && voice === 'Cherry' ? pending.promise : `${voice}-${i}.wav` });
  await engine.open(); const old = engine.play();
  voice = 'Ryan'; await engine.refreshAudio(); pending.resolve('old-Cherry.wav'); await old;
  assert.equal(engine.getState().status, 'playing');
  assert.equal(played[0].uri, 'Ryan-0.wav');
  assert.ok(removed.includes('old-Cherry.wav'));
  engine.tick(3, 10, true, false); voice = 'Serena'; await engine.refreshAudio();
  assert.equal(played.at(-1).uri, 'Serena-0.wav'); assert.equal(played.at(-1).seconds, 3);
  engine.pause(); voice = 'Ethan'; await engine.refreshAudio();
  assert.equal(engine.getState().status, 'paused'); engine.dispose();
});

test('LLM text cannot change narration; duplicate/missing indices fall back to original text', () => {
  const original = ['张三说：“你好。”', '李四说：“再见。”'];
  const bad = [{ index: 0, speaker: '张三', tone: 'excited', text: '篡改' }, { index: 0, speaker: '李四', tone: 'sad' }];
  const fallback = annotatePassages(original, bad, {});
  assert.equal(fallback.valid, false);
  assert.deepEqual(fallback.passages.map((p) => p.text), original);
  assert.ok(fallback.passages.every((p) => p.speaker === '旁白'));
  const annotations = [{ index: 1, speaker: '李四', tone: 'sad' }, { index: 0, speaker: '张三', tone: 'excited', text: '篡改' }];
  const first = annotatePassages(original, annotations, {});
  const next = annotatePassages(['新页'], [{ index: 0, speaker: '张三', tone: 'gentle' }], first.cast);
  assert.deepEqual(first.passages.map((p) => p.text), original);
  assert.equal(next.passages[0].voice, first.passages[0].voice);
  assert.notEqual(first.passages[0].voice, first.passages[1].voice);
});

test('invalid and replaced-source checkpoints cannot seek beyond the book', () => {
  assert.equal(restoreBookmark({ version: 1, signature: 'old', page: 1, passage: 2, seconds: 90 }, page()).passage, 0);
  const bookmark = restoreBookmark({ version: 1, signature: 'book-a', page: 1, passage: 100, seconds: Infinity, speed: NaN }, page());
  assert.equal(bookmark.passage, 2); assert.equal(bookmark.seconds, 0); assert.equal(bookmark.speed, 1);
});

test('resume restores page, phrase, seconds and speed without automatically playing', async () => {
  const { engine, played, saved } = fixture();
  await engine.open({ version: 1, page: 2, passage: 1, seconds: 7, signature: 'book-a', speed: 1.5 });
  assert.equal(engine.getState().status, 'paused'); assert.equal(played.length, 0);
  await engine.play();
  assert.deepEqual(played[0], { uri: '2-1.wav', seconds: 7, rate: 1.5 });
  engine.tick(8, 20, true, false); engine.pause(); await setImmediate();
  assert.equal(saved.at(-1).seconds, 8); assert.equal(saved.at(-1).page, 2);
  engine.dispose();
});

test('pause while synthesizing prevents late playback and releases the late audio file', async () => {
  const pending = deferred();
  const { engine, played, removed } = fixture({ audio: () => pending.promise });
  await engine.open(); const task = engine.play(); engine.pause();
  pending.resolve('late.wav'); await task;
  assert.equal(engine.getState().status, 'paused'); assert.deepEqual(played, []); assert.deepEqual(removed, ['late.wav']);
  engine.dispose();
});

test('seek supersedes a slow page request and a failed phrase never advances', async () => {
  const slow = deferred();
  const { engine } = fixture({ page: (n) => n === 1 ? slow.promise : Promise.resolve(page(n)), audio: async () => null });
  const old = engine.open(); await engine.go(2); slow.resolve(page(1)); await old;
  assert.equal(engine.getState().page.page, 2);
  await engine.play();
  assert.equal(engine.getState().status, 'error'); assert.equal(engine.getState().bookmark.passage, 0);
  engine.dispose();
});

test('completion advances exactly once, page turns preserve source order, and sleep pauses', async () => {
  const { engine, played, sought } = fixture();
  await engine.open(); await engine.play();
  engine.tick(5, 5, false, true); engine.tick(5, 5, false, true); await setImmediate();
  assert.equal(engine.getState().bookmark.passage, 1);
  assert.deepEqual(played.map((p) => p.uri), ['1-0.wav', '1-1.wav']);
  engine.tick(3, 10, true, false); await engine.seek(500);
  assert.deepEqual(sought, [9.9]);
  await engine.next(1); await engine.next(1);
  assert.equal(engine.getState().page.page, 2); assert.equal(engine.getState().bookmark.passage, 0);
  engine.sleep(0.000001); await new Promise((done) => setTimeout(done, 2));
  engine.tick(1, 10, true, false); assert.equal(engine.getState().status, 'paused');
  engine.dispose();
});

test('disposal invalidates pending work and never reactivates playback', async () => {
  const pending = deferred();
  const { engine, played } = fixture({ audio: () => pending.promise });
  await engine.open(); const task = engine.play(); engine.dispose(); pending.resolve('old-account.wav'); await task;
  assert.deepEqual(played, []);
});

test('a seek completing after a page change cannot overwrite the new checkpoint', async () => {
  const pending = deferred();
  const { engine } = fixture({ player: { async load() {}, play() {}, pause() {}, seek: () => pending.promise, rate() {}, release() {} } });
  await engine.open(); await engine.play(); engine.tick(1, 10, true, false);
  const old = engine.seek(4); await engine.go(2); pending.resolve(); await old;
  assert.equal(engine.getState().bookmark.page, 2); assert.equal(engine.getState().bookmark.seconds, 0);
  engine.dispose();
});

test('pause cancels look-ahead; resuming can generate that phrase again without losing it', async () => {
  const pending = deferred(); let calls = 0;
  const { engine } = fixture({ audio: async (_page, index) => index === 1 && ++calls === 1 ? pending.promise : `phrase-${index}.wav` });
  await engine.open(); await engine.play(); engine.pause();
  pending.resolve('cancelled-buffer.wav'); await setImmediate();
  await engine.play(); await engine.next(1);
  assert.equal(engine.getState().status, 'playing'); assert.equal(engine.getState().bookmark.passage, 1);
  engine.dispose();
});

test('finishing a book allows replay and idle status events do not keep writing checkpoints', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { engine, saved } = fixture();
  await engine.go(2, 2, true); await engine.next(1);
  assert.equal(engine.getState().status, 'ended');
  await engine.play();
  assert.equal(engine.getState().page.page, 1); assert.equal(engine.getState().bookmark.passage, 0);
  engine.pause(); await engine.flush(); const count = saved.length;
  t.mock.timers.tick(10000); engine.tick(0, 8, false, false); await engine.flush();
  assert.equal(saved.length, count); engine.dispose();
});

test('pausing the initial resume load retains the saved position for retry', async () => {
  const pending = deferred(); let requests = 0;
  const { engine, played } = fixture({ page: async (n) => { requests++; assert.equal(n, 2); return requests === 1 ? pending.promise : page(n); } });
  const bookmark = { version: 1, page: 2, passage: 1, seconds: 7, signature: 'book-a', speed: 1.5 };
  const opening = engine.open(bookmark); engine.pause(); pending.resolve(page(2)); await opening;
  assert.equal(engine.getState().page, null);
  await engine.open(engine.getState().bookmark); await engine.play();
  assert.equal(engine.getState().bookmark.page, 2); assert.equal(engine.getState().bookmark.passage, 1);
  assert.deepEqual(played[0], { uri: '2-1.wav', seconds: 7, rate: 1.5 }); engine.dispose();
});
