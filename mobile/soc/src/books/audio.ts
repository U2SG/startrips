import type { BookAudio } from './engine.ts';

type Metadata = { title: string; artist?: string; albumTitle?: string };
type Status = { currentTime: number; duration: number; playing: boolean; didJustFinish: boolean; bookKey?: string; error?: unknown; isBuffering?: boolean };
type Player = {
  readonly isLoaded: boolean; readonly duration: number;
  replace(source: { uri: string }): void;
  addListener(event: 'playbackStatusUpdate', listener: (status: Status) => void): { remove(): void };
  play(): void; pause(): void; seekTo(seconds: number): Promise<void>; setPlaybackRate(rate: number): void;
  setActiveForLockScreen(active: boolean, metadata?: Metadata): void;
  clearLockScreenControls(): void; remove(): void;
  bookReplace?(source: { uri: string }, key: string, rate: number): void;
  bookAppend?(source: { uri: string }, key: string, rate: number): void;
  bookRate?(rate: number): void;
};

/** Keep the native media session alive across phrases and page/LLM gaps. */
export function createBookAudio(deps: {
  create(): Player; configure(): Promise<void>; guard(): void; status(status: Status): void; metadata(): Metadata;
}): BookAudio {
  let player: Player | null = null;
  let subscription: { remove(): void } | null = null;
  let generation = 0;
  let released = false;
  let loading = false;
  let starting = false;
  let wanted = false;
  let currentKey = '';
  let pending: { uri: string; key: string; rate: number }[] = [];
  const valid = (version: number) => !released && version === generation;
  const assertCurrent = (version: number) => { if (!valid(version)) throw new Error('音频加载已取消'); deps.guard(); };
  const rate = (value: number) => {
    const bounded = Math.max(0.1, Math.min(2, value));
    if (player?.bookRate) player.bookRate(bounded);
    else {
      const old = currentRate;
      for (const track of pending) track.rate *= bounded / old;
      player?.setPlaybackRate(bounded);
    }
    currentRate = bounded;
  };
  let currentRate = 1;
  return {
    async load(uri, seconds, speed, key = '') {
      const version = ++generation;
      assertCurrent(version);
      loading = true; starting = false; wanted = false;
      if (!player) {
        const created = deps.create();
        player = created;
        subscription = created.addListener('playbackStatusUpdate', (status) => {
          if (player !== created || released || loading) return;
          if (status.isBuffering && !status.didJustFinish) return;
          if (status.bookKey) currentKey = status.bookKey;
          // Browsers use the same bounded queue, with ended events instead of native transitions.
          if (!created.bookAppend && wanted && status.didJustFinish && pending.length) {
            const next = pending.shift()!;
            currentKey = next.key; currentRate = next.rate; starting = true;
            created.replace({ uri: next.uri }); created.setPlaybackRate(next.rate); created.play();
            return;
          }
          // replace/seek can deliver a delayed pause after play() was requested.
          if (starting && !status.playing && !status.didJustFinish) return;
          if ((status.playing && status.currentTime > 0.05) || status.didJustFinish) starting = false;
          if (!status.playing && !status.didJustFinish) wanted = false;
          deps.status({ ...status, bookKey: status.bookKey || currentKey });
        });
      }
      const current = player;
      current.pause();
      pending = []; currentKey = key;
      if (current.bookReplace) current.bookReplace({ uri }, key, speed);
      else current.replace({ uri });
      await deps.configure();
      assertCurrent(version);
      const started = Date.now();
      while (!current.isLoaded && valid(version) && Date.now() - started < 10000) await new Promise((done) => setTimeout(done, 50));
      assertCurrent(version);
      if (!current.isLoaded) throw new Error('音频加载失败，请重试');
      rate(speed);
      await current.seekTo(Math.max(0, Math.min(seconds, Math.max(0, current.duration - 0.1))));
      assertCurrent(version);
      current.setActiveForLockScreen(true, deps.metadata());
      loading = false;
    },
    enqueue(uri, key, speed) {
      if (released || !player) return;
      if (player.bookAppend) player.bookAppend({ uri }, key, speed);
      else pending.push({ uri, key, rate: speed });
    },
    play() { if (released) return; deps.guard(); starting = true; wanted = true; player?.setActiveForLockScreen(true, deps.metadata()); player?.play(); },
    pause() { ++generation; loading = false; starting = false; wanted = false; player?.pause(); },
    async seek(seconds) { if (player && !released) await player.seekTo(seconds); },
    rate,
    release() {
      if (released) return;
      released = true; ++generation;
      pending = [];
      const old = player; player = null;
      subscription?.remove(); subscription = null;
      try { old?.pause(); old?.clearLockScreenControls(); old?.remove(); } catch { /* Already released by the platform. */ }
    },
  };
}
