import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserVoiceCapture } from '../src/browserVoiceCapture.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function browser(t, getUserMedia) {
  const counts = { contexts: 0, recorders: 0, stopped: 0 };
  const globals = {
    navigator: { mediaDevices: { getUserMedia } },
    AudioContext: class { constructor() { counts.contexts++; } },
    MediaRecorder: class { constructor() { counts.recorders++; } static isTypeSupported() { return true; } },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; });
  }
  return { counts, stream: () => ({ getTracks: () => [{ stop: () => { counts.stopped++; } }] }) };
}
const noTranscription = async () => { assert.fail('A cancelled capture must not be transcribed'); };

test('cancelling while credentials load never requests microphone permission', async (t) => {
  const credentials = deferred();
  const fixture = browser(t, () => { assert.fail('Permission must not be requested'); });
  const capture = createBrowserVoiceCapture(() => credentials.promise, noTranscription);
  const result = capture.listen();
  capture.cancel();
  credentials.resolve({ model: 'test' });
  assert.equal(await result, '');
  assert.equal(fixture.counts.contexts, 0);
});

test('a late microphone grant is stopped without constructing a recorder', async (t) => {
  const permission = deferred(), requested = deferred();
  const fixture = browser(t, () => { requested.resolve(); return permission.promise; });
  const capture = createBrowserVoiceCapture(async () => ({ model: 'test' }), noTranscription);
  const result = capture.listen();
  await requested.promise;
  capture.cancel();
  permission.resolve(fixture.stream());
  assert.equal(await result, '');
  assert.deepEqual(fixture.counts, { contexts: 0, recorders: 0, stopped: 1 });
});

test('an older permission completion cannot clear cancellation for a newer capture', async (t) => {
  const permissions = [deferred(), deferred()], requested = [deferred(), deferred()];
  let calls = 0;
  const fixture = browser(t, () => { const index = calls++; requested[index].resolve(); return permissions[index].promise; });
  const capture = createBrowserVoiceCapture(async () => ({ model: 'test' }), noTranscription);
  const first = capture.listen();
  await requested[0].promise;
  const second = capture.listen();
  await requested[1].promise;
  permissions[0].resolve(fixture.stream());
  assert.equal(await first, '');
  capture.cancel();
  permissions[1].resolve(fixture.stream());
  assert.equal(await second, '');
  assert.deepEqual(fixture.counts, { contexts: 0, recorders: 0, stopped: 2 });
});
