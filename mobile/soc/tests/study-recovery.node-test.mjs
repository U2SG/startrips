import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MissingLessonDataError, requiredLessonData, pendingAfterResumeFailure, parseLessonPointer, startAfterPointer } from '../src/lessonRecovery.ts';
import { nextReviewAfter, saveFlashcardAnswer } from '../src/flashcardReview.ts';

const pending = { worldId: 'world', convId: 'lesson' };
const guard = () => {};
test('network, timeout and provider failures retain the persisted lesson continuation', async () => {
  for (const error of [new Error('offline'), new Error('timeout'), { status: 503 }, { status: 401 }, { status: 404 }]) {
    assert.equal(await pendingAfterResumeFailure(error, pending, async () => assert.fail('Must preserve pointer'), guard), pending);
  }
});
test('confirmed missing lesson data clears its pointer exactly once', async () => {
  for (const error of [new MissingLessonDataError('missing textbook'), new MissingLessonDataError('missing chat')]) {
    let cleared = 0;
    assert.equal(await pendingAfterResumeFailure(error, pending, async () => { cleared++; }, guard), null);
    assert.equal(cleared, 1);
  }
});
test('only missing required course files are classified as unrecoverable', async () => {
  await assert.rejects(requiredLessonData(Promise.reject({ status: 404 }), 'missing chat'), MissingLessonDataError);
  const unavailable = { status: 503 };
  await assert.rejects(requiredLessonData(Promise.reject(unavailable), 'missing chat'), (error) => error === unavailable);
});
test('an unavailable pointer store retains the resume action', async () => {
  assert.equal(await pendingAfterResumeFailure(new MissingLessonDataError('missing'), pending, async () => { throw new Error('storage offline'); }, guard), pending);
});
test('a retired account cannot clear another account continuation', async () => {
  await assert.rejects(pendingAfterResumeFailure(new MissingLessonDataError('missing'), pending, async () => assert.fail('Must not clear'), () => { throw new Error('retired'); }), /retired/);
});

const now = new Date('2026-10-25T08:00:00.000Z');
const card = (history = []) => ({ id: 'first', correctIndex: 0, history });
test('SRS uses prior history so first and subsequent correct answers advance one interval each', () => {
  const expected = [1, 3, 7, 14, 30, 60, 60];
  for (let prior = 0; prior < expected.length; prior++) {
    const entry = card(Array.from({ length: prior }, () => ({ correct: true })));
    assert.equal(nextReviewAfter(entry, true, now), new Date(Date.UTC(2026, 9, 25 + expected[prior], 16)).toISOString());
  }
  assert.equal(nextReviewAfter(card([{ correct: true }]), false, now), '2026-10-26T16:00:00.000Z');
  assert.equal(nextReviewAfter(card([{ correct: true }, { correct: false }]), true, now), '2026-10-26T16:00:00.000Z');
});
test('a deferred save commits one review and leaves the original untouched until persistence succeeds', async () => {
  const entry = card(), file = { textbookId: 'book', updatedAt: 'before', cards: [entry] };
  let release, captured;
  const task = saveFlashcardAnswer(file, entry, 0, now, async (updated) => {
    captured = updated;
    await new Promise((resolve) => { release = resolve; });
  });
  assert.equal(entry.history.length, 0);
  assert.equal(entry.nextReview, undefined);
  assert.equal(captured.cards[0].history.length, 1);
  assert.equal(captured.cards[0].nextReview, '2026-10-26T16:00:00.000Z');
  release();
  await task;
  assert.equal(entry.history.length, 1);
  assert.equal(entry.nextReview, '2026-10-26T16:00:00.000Z');
});
test('a failed review save cannot advance the durable schedule or mutate the loaded history', async () => {
  const entry = card(), file = { textbookId: 'book', updatedAt: 'before', cards: [entry] };
  await assert.rejects(saveFlashcardAnswer(file, entry, 0, now, async () => { throw new Error('conflict'); }), /conflict/);
  assert.equal(entry.history.length, 0);
  assert.equal(entry.nextReview, undefined);
});

test('a delayed saved-pointer read cannot start or overwrite an unfinished lesson', async () => {
  let resolve, began = 0;
  const loading = new Promise((done) => { resolve = done; });
  const task = startAfterPointer(() => loading, guard, () => {}, async () => { began++; });
  const rejected = assert.rejects(task, /未下课/);
  assert.equal(began, 0);
  resolve(pending);
  await rejected;
  assert.equal(began, 0);
});
test('a rejected pointer-store read fails closed at the actual start boundary', async () => {
  await assert.rejects(startAfterPointer(async () => { throw new Error('getItem offline'); }, guard, () => {}, async () => assert.fail('Must not begin')), /getItem offline/);
});
test('only a confirmed absent pointer allows new lesson initialization', async () => {
  let began = 0;
  assert.equal(await startAfterPointer(async () => null, guard, (p) => assert.equal(p, null), async () => { began++; return 'new lesson'; }), 'new lesson');
  assert.equal(began, 1);
});
test('malformed stored pointers are unknown rather than silently absent', () => {
  assert.equal(parseLessonPointer(null), null);
  for (const raw of ['', 'null', 'false', '{}', '{"worldId":"world"}']) assert.throws(() => parseLessonPointer(raw));
  const value = { worldId: 'world', textbookId: 'book', convId: 'lesson' };
  assert.deepEqual(parseLessonPointer(JSON.stringify(value)), value);
});
test('a pointer read completing for a retired account cannot begin a lesson', async () => {
  await assert.rejects(startAfterPointer(async () => null, () => { throw new Error('retired'); }, () => assert.fail('Must not publish'), async () => assert.fail('Must not begin')), /retired/);
});
