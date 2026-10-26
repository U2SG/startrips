import type { BookAudio } from './engine.ts';

type Metadata = { title: string; artist?: string; albumTitle?: string };
type Status = { currentTime: number; duration: number; playing: boolean; didJustFinish: boolean; bookKey?: string; error?: unknown; isBuffering?: boolean };
type Player = {
  readonly isLoaded: boolean; readonly duration: number;
  replace(source: { uri: string }): void;
  addListener(event: 'playbackStatusUpdate', listener: (status: Status) => void): { remove(): void };
  play(): void; pause(): void; seekTo(seconds: number): Promise<void>; setPlaybackRate(rate: number): void;
  setActiveForLockScreen(active: boolean, metadata?: Metadata): void;
  updateLockScreenMetadata?(metadata: Metadata): void;
  clearLockScreenControls(): void; remove(): void;
  bookReplace?(source: { uri: string }, key: string, rate: number): void;
  bookAppend?(source: { uri: string }, key: string, rate: number): void;
  bookRate?(rate: number): void;
  bookClear?(): void;
  bookSeek?(seconds: number): void;
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
  let lockScreenActive = false;
  let currentKey = '';
  let pending: { uri: string; key: string; rate: number }[] = [];
  let ready: { resolve(): void; reject(error: Error): void } | null = null;
  const cancelReady = () => { ready?.reject(new Error('音频加载已取消')); ready = null; };
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
      cancelReady();
      const version = ++generation;
      assertCurrent(version);
      loading = true; starting = false; wanted = false;
      if (!player) {
        const created = deps.create();
        player = created;
        subscription = created.addListener('playbackStatusUpdate', (status) => {
          if (player !== created || released) return;
          if (loading) {
            if (status.error) ready?.reject(new Error('音频加载失败，请重试'));
            else if (created.isLoaded) ready?.resolve();
            return;
          }
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
      if (!current.isLoaded) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('音频加载失败，请重试')), 10000);
        const finish = (error?: Error) => {
          clearTimeout(timer); if (ready === waiter) ready = null;
          if (error) reject(error); else resolve();
        };
        const waiter = { resolve: () => finish(), reject: (error: Error) => finish(error) };
        ready = waiter;
        // Native status events keep working while React Native's UI timers are suspended.
        if (current.isLoaded) finish();
      });
      assertCurrent(version);
      if (!current.isLoaded) throw new Error('音频加载失败，请重试');
      rate(speed);
      const target = Math.max(0, Math.min(seconds, Math.max(0, current.duration - 0.1)));
      // Replacing a source already starts at zero. Android's native command avoids
      // waiting for a paused ExoPlayer seek promise before play() can be requested.
      if (target > 0) {
        if (current.bookSeek) current.bookSeek(target);
        else await current.seekTo(target);
      }
      assertCurrent(version);
      loading = false;
    },
    enqueue(uri, key, speed) {
      if (released || !player) return;
      if (player.bookAppend) player.bookAppend({ uri }, key, speed);
      else pending.push({ uri, key, rate: speed });
    },
    clear() {
      cancelReady();
      ++generation; loading = false; wanted = false; starting = false; pending = []; currentKey = '';
      player?.pause();
      if (player?.bookClear) player.bookClear();
      else player?.replace({ uri: '' });
    },
    play() {
      if (released || !player) return;
      deps.guard(); starting = true; wanted = true;
      // Repeated activation rebuilds Android's MediaSession. Keep one session,
      // including across source replacements, and only update its metadata.
      if (!lockScreenActive) {
        player.setActiveForLockScreen(true, deps.metadata()); lockScreenActive = true;
      } else player.updateLockScreenMetadata?.(deps.metadata());
      player.play();
    },
    pause() { cancelReady(); ++generation; loading = false; starting = false; wanted = false; player?.pause(); },
    async seek(seconds) { if (player && !released) { if (player.bookSeek) player.bookSeek(seconds); else await player.seekTo(seconds); } },
    rate,
    release() {
      if (released) return;
      released = true; ++generation;
      cancelReady();
      pending = [];
      const old = player; player = null;
      subscription?.remove(); subscription = null;
      try { old?.pause(); old?.clearLockScreenControls(); old?.remove(); } catch { /* Already released by the platform. */ }
    },
  };
}
