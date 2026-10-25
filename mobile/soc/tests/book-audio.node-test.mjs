import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBookAudio } from '../src/books/audio.ts';

function setup(configure = async () => {}) {
  const events = [], status = []; let created = 0, listener;
  const player = {
    isLoaded: true, duration: 12,
    replace(source) { events.push(['source', source.uri]); },
    addListener(_name, callback) { listener = callback; return { remove() { events.push(['unsubscribe']); } }; },
    play() { events.push(['play']); }, pause() { events.push(['pause']); },
    async seekTo(seconds) { events.push(['seek', seconds]); },
    setPlaybackRate(rate) { events.push(['rate', rate]); },
    setActiveForLockScreen(active) { events.push(['lockScreen', active]); },
    clearLockScreenControls() { events.push(['clearLockScreen']); },
    remove() { events.push(['remove']); },
  };
  const audio = createBookAudio({ create: () => { created++; return player; }, configure, guard() {}, status: (s) => status.push(s), metadata: () => ({ title: 'Book' }) });
  return { audio, events, status, emit: (s) => listener(s), created: () => created };
}

test('phrase changes retain one native player and lock-screen session until disposal', async () => {
  const f = setup();
  await f.audio.load('first.wav', 4, 1); f.audio.play(); f.audio.pause();
  await f.audio.load('second.wav', 0, 1.5); f.audio.play();
  assert.equal(f.created(), 1);
  assert.deepEqual(f.events.filter((e) => e[0] === 'source'), [['source', 'first.wav'], ['source', 'second.wav']]);
  assert.equal(f.events.some((e) => ['remove', 'clearLockScreen', 'unsubscribe'].includes(e[0])), false);
  f.audio.release(); f.audio.release();
  assert.equal(f.events.filter((e) => e[0] === 'remove').length, 1);
  assert.equal(f.events.filter((e) => e[0] === 'clearLockScreen').length, 1);
  f.emit({ currentTime: 9 }); assert.deepEqual(f.status, []);
});

test('an obsolete load cannot seek or replace metadata after a newer phrase is ready', async () => {
  let resolve; let calls = 0;
  const pending = new Promise((done) => { resolve = done; });
  const f = setup(() => ++calls === 1 ? pending : Promise.resolve());
  const first = f.audio.load('old.wav', 7, 1);
  await f.audio.load('new.wav', 0, 1.25);
  resolve(); await assert.rejects(first, /已取消/);
  assert.deepEqual(f.events.filter((e) => e[0] === 'seek'), [['seek', 0]]);
  assert.equal(f.events.filter((e) => e[0] === 'lockScreen').length, 1);
  f.audio.release();
});

test('pause during preparation prevents late native seeking and activation', async () => {
  let resolve;
  const f = setup(() => new Promise((done) => { resolve = done; }));
  const loading = f.audio.load('pending.wav', 5, 1); f.audio.pause(); resolve();
  await assert.rejects(loading, /已取消/);
  assert.equal(f.events.some((e) => e[0] === 'seek' || e[0] === 'lockScreen'), false);
  f.audio.rate(2.12); assert.deepEqual(f.events.at(-1), ['rate', 2]);
  f.audio.release();
});
