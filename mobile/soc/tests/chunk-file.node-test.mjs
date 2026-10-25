import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fetchChunkFile } from '../src/speech/chunkFile.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('timeout aborts the first attempt and disposes a late download without deleting the retry winner', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstDownload = deferred(), firstStarted = deferred(), retryStarted = deferred();
  const signals = [], names = [], removed = [];
  const task = fetchChunkFile('lesson.wav', {
    signal: new AbortController().signal,
    synthesize: async (signal) => { signals.push(signal); return `url-${signals.length}`; },
    cache: async (_url, name, signal) => {
      names.push(name);
      assert.equal(signal, signals[names.length - 1]);
      if (names.length === 1) { firstStarted.resolve(); return firstDownload.promise; }
      retryStarted.resolve(); return 'winner.wav';
    },
    remove: (uri) => removed.push(uri),
  }, 10, 0);
  await firstStarted.promise;
  t.mock.timers.tick(10);
  await retryStarted.promise;
  assert.equal(await task, 'winner.wav');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.notEqual(names[0], names[1]);
  firstDownload.resolve('late.wav');
  await setImmediate();
  assert.deepEqual(removed, ['late.wav']);
});

test('a provider response arriving after timeout cannot begin another download', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstProvider = deferred(), firstStarted = deferred(), retryStarted = deferred();
  let attempts = 0;
  const downloads = [];
  const task = fetchChunkFile('lesson.wav', {
    signal: new AbortController().signal,
    synthesize: async () => {
      if (++attempts === 1) { firstStarted.resolve(); return firstProvider.promise; }
      retryStarted.resolve(); return 'winner-url';
    },
    cache: async (url) => { downloads.push(url); return 'winner.wav'; },
    remove: () => { assert.fail('The accepted winner must stay cached'); },
  }, 10, 0);
  await firstStarted.promise;
  t.mock.timers.tick(10);
  await retryStarted.promise;
  assert.equal(await task, 'winner.wav');
  firstProvider.resolve('late-url');
  await setImmediate();
  assert.deepEqual(downloads, ['winner-url']);
});

test('stopping playback aborts the download without a retry and removes a late file', { timeout: 2000 }, async () => {
  const parent = new AbortController(), download = deferred(), started = deferred();
  let attempts = 0;
  const removed = [];
  let downloadSignal;
  const task = fetchChunkFile('lesson.wav', {
    signal: parent.signal,
    synthesize: async () => { attempts++; return 'audio-url'; },
    cache: async (_url, _name, signal) => { downloadSignal = signal; started.resolve(); return download.promise; },
    remove: (uri) => removed.push(uri),
  });
  await started.promise;
  parent.abort();
  assert.equal(await task, null);
  assert.equal(downloadSignal.aborted, true);
  download.resolve('cancelled.wav');
  await setImmediate();
  assert.equal(attempts, 1);
  assert.deepEqual(removed, ['cancelled.wav']);
});
