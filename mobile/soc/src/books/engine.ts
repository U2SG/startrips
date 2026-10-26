import { restoreBookmark, toneRate, isSpeakable, type BookPage, type Bookmark } from './model.ts';
import type { CachedClip } from './paragraphCache.ts';

type Status = 'paused' | 'loading' | 'playing' | 'ended' | 'error';
export type BookState = { page: BookPage | null; bookmark: Bookmark | null; status: Status; duration: number; elapsed: number; length: number; buffered: number; error: string; syncError: string; sleepAt: number | null };
export type BookAudio = {
  load(uri: string, seconds: number, rate: number, key?: string): Promise<void>;
  enqueue?(uri: string, key: string, rate: number): void;
  clear?(): void;
  play(): void; pause(): void; seek(seconds: number): Promise<void>; rate(value: number): void;
  release(): void;
};
export type BookDependencies = {
  page(number: number, dramatic: boolean, signal: AbortSignal): Promise<BookPage>;
  audio(page: BookPage, index: number, signal: AbortSignal): Promise<string | CachedClip | null>;
  remove(uri: string): void;
  exists?(uri: string): Promise<boolean>;
  save(bookmark: Bookmark, localOnly?: boolean): Promise<void>;
  focus(): void;
  started?(page: BookPage, signal: AbortSignal): void;
  player: BookAudio;
};

type Track = { page: BookPage; index: number; key: string; clip: CachedClip };
/** Start one phrase immediately; keep about twenty seconds ahead in the native queue. */
export class BookEngine {
  private state: BookState = { page: null, bookmark: null, status: 'paused', duration: 0, elapsed: 0, length: 0, buffered: 0, error: '', syncError: '', sleepAt: null };
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private sequence = 0;
  private disposed = false;
  private loaded = '';
  private jobs = new Map<string, Promise<CachedClip | null>>();
  private clips = new Map<string, CachedClip>();
  private pages = new Map<string, BookPage>();
  private queue: Track[] = [];
  private timelineBase = 0;
  private filling = -1;
  private prefetchFailed = new Set<string>();
  private ready = new Set<string>();
  private uris = new Set<string>();
  private saveQueue: Promise<void> = Promise.resolve();
  private lastSaved = 0;
  private transition = false;
  private movedAt = Date.now();
  private lastPosition = 0;
  private resumeFrom: unknown = null;
  private background = false;
  private deps: BookDependencies;
  constructor(deps: BookDependencies) { this.deps = deps; }
  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private patch(next: Partial<BookState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    const at = this.queue.findIndex((track) => track.key === this.loaded);
    const elapsed = this.timelineBase + this.queue.slice(0, Math.max(0, at)).reduce((sum, track) => sum + track.clip.duration, 0) + (this.state.bookmark?.seconds || 0);
    const length = this.timelineBase + this.queue.reduce((sum, track) => sum + track.clip.duration, 0);
    this.state = { ...this.state, elapsed, length: length || this.state.duration };
    this.listeners.forEach((fn) => fn());
  }
  private current(seq: number) { return !this.disposed && seq === this.sequence && !this.controller.signal.aborted; }
  private invalidate() {
    ++this.sequence; this.controller.abort(); this.controller = new AbortController(); this.deps.player.pause(); this.transition = false;
    for (const key of this.jobs.keys()) if (!this.ready.has(key)) this.jobs.delete(key);
  }
  private clearBuffer() { this.jobs.clear(); this.clips.clear(); this.ready.clear(); this.prefetchFailed.clear(); this.uris.forEach(this.deps.remove); this.uris.clear(); this.loaded = ''; this.queue = []; this.timelineBase = 0; }
  private key(page: BookPage, index: number) { return `${page.signature}/${page.page}/${index}/${this.state.bookmark?.dramatic}`; }
  private async prepare(page: BookPage, index: number): Promise<CachedClip | null> {
    const key = this.key(page, index);
    const signal = this.controller.signal;
    const cached = this.clips.get(key);
    if (cached && this.deps.exists && !await this.deps.exists(cached.uri) && this.clips.get(key) === cached) {
      this.clips.delete(key); this.jobs.delete(key); this.ready.delete(key); this.uris.delete(cached.uri); this.deps.remove(cached.uri);
    }
    if (signal.aborted || this.disposed) return null;
    if (!this.jobs.has(key)) {
      const job = this.deps.audio(page, index, signal).then((result) => {
        const clip = typeof result === 'string' ? { uri: result, duration: 0 } : result;
        if (signal.aborted || this.disposed) { if (clip) this.deps.remove(clip.uri); return null; }
        if (clip) { this.uris.add(clip.uri); this.ready.add(key); this.clips.set(key, clip); }
        else if (this.jobs.get(key) === job) this.jobs.delete(key);
        return clip;
      }).catch((error) => { if (this.jobs.get(key) === job) this.jobs.delete(key); throw error; });
      this.jobs.set(key, job);
    }
    return this.jobs.get(key)!;
  }
  private async pageAt(number: number) {
    const dramatic = this.state.bookmark?.dramatic !== false;
    const key = `${number}/${dramatic}`;
    const cached = this.pages.get(key);
    if (cached) return cached;
    const signal = this.controller.signal;
    const page = await this.deps.page(number, dramatic, signal);
    if (!signal.aborted && !this.disposed) this.pages.set(key, page);
    return page;
  }
  private async adjacent(page: BookPage, index: number, delta: number): Promise<{ page: BookPage; index: number } | null> {
    const seq = this.sequence;
    index += delta;
    while (index < 0 || index >= page.passages.length) {
      const number = page.page + delta;
      if (number < 1 || number > page.total) return null;
      page = await this.pageAt(number); index = delta > 0 ? 0 : page.passages.length - 1;
      if (!this.current(seq)) throw new Error('已取消');
    }
    return { page, index };
  }
  private bufferSeconds() {
    const b = this.state.bookmark;
    const at = this.queue.findIndex((track) => track.key === this.loaded);
    return at < 0 ? 0 : this.queue.slice(at).reduce((sum, track, i) => sum + Math.max(0, track.clip.duration - (i ? 0 : b?.seconds || 0)), 0);
  }
  private async fill() {
    const seq = this.sequence;
    if (this.filling === seq || this.state.status !== 'playing' || !this.queue.length) return;
    this.filling = seq;
    let preparing = '';
    try {
      // Duration, rather than a fixed phrase count, matters for very short sentences.
      while (this.current(seq) && this.state.status === 'playing' && this.bufferSeconds() < 20 * (this.state.bookmark?.speed || 1)) {
        const at = this.queue.findIndex((track) => track.key === this.loaded);
        if (this.queue.length - at >= 12) break;
        const last = this.queue.at(-1)!;
        const next = await this.adjacent(last.page, last.index, 1);
        if (!next || !this.current(seq)) break;
        const key = this.key(next.page, next.index);
        if (this.prefetchFailed.has(key)) break;
        preparing = key;
        const clip = await this.prepare(next.page, next.index);
        if (!this.current(seq) || !clip) break;
        // A legacy test/player without duration information only needs one look-ahead.
        this.queue.push({ ...next, key, clip });
        if (next.page.page !== last.page.page) this.deps.started?.(next.page, this.controller.signal);
        this.deps.player.enqueue?.(clip.uri, key, (this.state.bookmark?.speed || 1) * toneRate(next.page.passages[next.index].tone));
        this.patch({ buffered: this.bufferSeconds() });
        if (!clip.duration) break;
      }
    } catch { if (this.current(seq) && preparing) this.prefetchFailed.add(preparing); }
    finally { if (this.filling === seq) this.filling = -1; }
  }
  async open(raw?: unknown) {
    const checkpoint = raw ?? this.state.bookmark ?? this.resumeFrom;
    this.resumeFrom = checkpoint;
    const b = checkpoint as Partial<Bookmark> | undefined;
    await this.go(typeof b?.page === 'number' && Number.isInteger(b.page) && b.page > 0 ? b.page : 1, 0, false, checkpoint);
  }
  async go(number: number, index = 0, play = this.state.status === 'playing', raw?: unknown) {
    if (this.disposed) return;
    const previous = raw ?? this.state.bookmark;
    this.invalidate(); this.loaded = ''; this.queue = []; this.timelineBase = 0;
    const seq = this.sequence;
    this.patch({ status: 'loading', duration: 0, error: '' });
    try {
      const dramatic = (previous as Partial<Bookmark> | null)?.dramatic !== false;
      const page = this.pages.get(`${number}/${dramatic}`) || await this.deps.page(Math.max(1, Math.trunc(number)), dramatic, this.controller.signal);
      if (!this.current(seq)) return;
      this.pages.set(`${page.page}/${dramatic}`, page);
      const bookmark = restoreBookmark(previous, page);
      if (raw === undefined) { bookmark.passage = Math.max(0, Math.min(index, Math.max(0, page.passages.length - 1))); bookmark.seconds = 0; }
      this.patch({ page, bookmark, status: 'paused' }); this.checkpoint();
      if (play) await this.play();
    } catch (error) { if (this.current(seq)) this.fail(error); }
  }
  async play(autoplay = true) {
    const { page, bookmark: b } = this.state;
    if (!page || !b || this.disposed || this.state.status === 'loading') return;
    if (this.state.status === 'ended') { await this.go(1, 0, true); return; }
    if (autoplay) this.deps.focus();
    if (!page.passages.length) {
      if (page.page < page.total) { await this.go(page.page + 1, 0, autoplay); return; }
      this.patch({ status: 'ended' }); return;
    }
    if (!isSpeakable(page.passages[b.passage].text)) { if (autoplay) await this.next(1); return; }
    const seq = this.sequence;
    const key = this.key(page, b.passage);
    this.prefetchFailed.delete(key);
    this.transition = true;
    this.patch({ status: 'loading', error: '' });
    try {
      const clip = await this.prepare(page, b.passage);
      if (!this.current(seq)) return;
      if (!clip) { this.jobs.delete(key); throw new Error('这段音频生成失败，请重试，进度已保留'); }
      if (this.loaded !== key) {
        await this.deps.player.load(clip.uri, b.seconds, b.speed * toneRate(page.passages[b.passage].tone), key);
        if (!this.current(seq)) return;
        this.loaded = key;
        this.queue = [{ page, index: b.passage, key, clip }]; this.timelineBase = 0;
      }
      this.deps.player.rate((this.state.bookmark?.speed || b.speed) * toneRate(page.passages[b.passage].tone));
      if (autoplay) this.deps.player.play();
      this.movedAt = Date.now(); this.lastPosition = b.seconds;
      this.patch({ status: autoplay ? 'playing' : 'paused', duration: clip.duration, buffered: this.bufferSeconds() }); this.transition = false;
      if (autoplay) this.deps.started?.(page, this.controller.signal);
      // Never await LLM analysis or later audio before starting the current phrase.
      void this.fill();
    } catch (error) { this.jobs.delete(key); if (this.current(seq)) this.fail(error); }
  }
  pause(localOnly = false) {
    if (this.disposed) return;
    // Cancel preparation too: a paused pending request must never start playing later.
    const loading = this.state.status === 'loading';
    this.invalidate();
    for (const key of this.jobs.keys()) if (!this.ready.has(key)) this.jobs.delete(key);
    if (loading) { this.loaded = ''; this.queue = []; }
    this.patch({ status: 'paused' }); return this.checkpoint(localOnly);
  }
  async next(delta: number) {
    const { page, bookmark: b } = this.state;
    if (!page || !b) return;
    ++this.sequence;
    const index = b.passage + delta;
    if (index < 0) { if (page.page > 1) await this.go(page.page - 1, Number.MAX_SAFE_INTEGER, true); return; }
    if (index >= page.passages.length) {
      if (page.page < page.total) await this.go(page.page + 1, 0, true);
      else { this.deps.player.pause(); this.patch({ status: 'ended' }); this.checkpoint(); }
      return;
    }
    this.deps.player.pause(); this.loaded = ''; this.transition = true;
    this.patch({ bookmark: { ...b, passage: index, seconds: 0 }, duration: 0, status: 'paused' });
    this.queue = []; this.timelineBase = 0; this.checkpoint(); await this.play();
  }
  async seek(seconds: number) {
    const b = this.state.bookmark;
    if (!b || !Number.isFinite(seconds) || this.state.status === 'loading') return;
    const target = Math.max(0, Math.min(seconds, Math.max(0, this.state.duration - 0.1)));
    const seq = this.sequence;
    try {
      await this.deps.player.seek(target);
      if (!this.current(seq)) return;
      this.movedAt = Date.now(); this.lastPosition = target;
      this.patch({ bookmark: { ...b, seconds: target } }); this.checkpoint();
    } catch (error) { if (this.current(seq)) this.fail(error); }
  }
  async skip(delta: number) {
    const b = this.state.bookmark;
    let page = this.state.page;
    if (!b || !page || !Number.isFinite(delta) || this.state.status === 'loading') return;
    const seq = this.sequence, playing = this.state.status === 'playing';
    let index = b.passage, seconds = b.seconds + delta;
    try {
      for (;;) {
        const clip = await this.prepare(page, index);
        if (!this.current(seq) || !clip) return;
        const duration = clip.duration || (index === b.passage && page.page === b.page ? this.state.duration : 0);
        if (seconds < 0) {
          const previous = await this.adjacent(page, index, -1);
          if (!this.current(seq)) return;
          if (!previous) { seconds = 0; break; }
          page = previous.page; index = previous.index;
          const before = await this.prepare(page, index);
          if (!this.current(seq) || !before) return;
          seconds += before.duration; continue;
        }
        if (duration > 0 && seconds >= duration) {
          const next = await this.adjacent(page, index, 1);
          if (!this.current(seq)) return;
          if (!next) { seconds = Math.max(0, duration - 0.1); break; }
          seconds -= duration; page = next.page; index = next.index; continue;
        }
        break;
      }
      if (!this.current(seq)) return;
      if (page.page === b.page && index === b.passage) { await this.seek(seconds); return; }
      await this.go(page.page, index, playing, { ...b, segmentation: 2, page: page.page, signature: page.signature, passage: index, seconds });
      // Paused scrubbing must load/seek without starting playback.
      if (!playing) {
        const clip = await this.prepare(page, index);
        if (clip && this.state.bookmark?.page === page.page && this.state.bookmark.passage === index) {
          const key = this.key(page, index);
          await this.deps.player.load(clip.uri, seconds, b.speed * toneRate(page.passages[index].tone), key);
          this.loaded = key; this.queue = [{ page, index, key, clip }]; this.patch({ duration: clip.duration });
        }
      }
    } catch (error) { if (this.current(seq)) this.fail(error); }
  }
  seekTimeline(seconds: number) { return this.skip(seconds - this.state.elapsed); }
  speed(value: number) {
    const { bookmark: b, page } = this.state;
    if (!b || !page || !Number.isFinite(value)) return;
    const speed = Math.max(0.75, Math.min(2, value));
    this.deps.player.rate(speed * toneRate(page.passages[b.passage]?.tone || 'neutral'));
    this.patch({ bookmark: { ...b, speed } }); this.checkpoint();
  }
  async refreshAudio() {
    if (this.disposed) return;
    const playing = this.state.status === 'playing' || this.state.status === 'loading';
    this.invalidate(); this.clearBuffer();
    this.deps.player.clear?.();
    this.patch({ status: 'paused', duration: 0, buffered: 0, error: '', bookmark: this.state.bookmark ? { ...this.state.bookmark, seconds: 0 } : null });
    if (this.state.page) await this.play(playing);
  }
  async mode(dramatic: boolean) {
    const b = this.state.bookmark;
    if (!b) return;
    await this.go(b.page, b.passage, false, { ...b, dramatic });
  }
  sleep(minutes: number) { this.patch({ sleepAt: minutes > 0 ? Date.now() + minutes * 60000 : null }); }
  setBackground(value: boolean) { this.background = value; this.movedAt = Date.now(); }
  poll() {
    if (this.disposed) return;
    if (this.state.sleepAt && Date.now() >= this.state.sleepAt) { this.patch({ sleepAt: null }); this.pause(); return; }
    if (!this.background && this.state.status === 'playing' && Date.now() - this.movedAt > 15000) {
      this.loaded = ''; this.fail(new Error('音频播放中断，请重试，进度已保留'));
    }
  }
  tick(seconds: number, duration: number, playing: boolean, finished: boolean, key?: string) {
    if (this.disposed || this.transition || this.state.status === 'loading') return;
    let b = this.state.bookmark;
    if (!b || !this.loaded) return;
    if (key && key !== this.loaded) {
      const track = this.queue.find((t) => t.key === key);
      if (!track) return; // A replaced native queue cannot update this book.
      const pageChanged = track.page.page !== b.page;
      this.loaded = key; this.movedAt = Date.now();
      const at = this.queue.indexOf(track);
      if (at > 8) this.timelineBase += this.queue.splice(0, at - 8).reduce((sum, old) => sum + old.clip.duration, 0);
      b = { ...b, page: track.page.page, passage: track.index, signature: track.page.signature, seconds };
      this.patch({ page: track.page, bookmark: b });
      if (pageChanged) this.deps.started?.(track.page, this.controller.signal);
      const keep = new Set(this.queue.map((t) => t.key));
      for (const old of this.clips.keys()) {
        if (this.clips.size <= 96) break;
        if (keep.has(old)) continue;
        const clip = this.clips.get(old)!;
        this.clips.delete(old); this.ready.delete(old); this.jobs.delete(old); this.uris.delete(clip.uri); this.deps.remove(clip.uri);
      }
    }
    if (Math.abs(seconds - this.lastPosition) > 0.05 || !playing) { this.lastPosition = seconds; this.movedAt = Date.now(); }
    if (duration > 0) { const clip = this.clips.get(this.loaded); if (clip) clip.duration = duration; }
    this.patch({ bookmark: { ...b, seconds: Math.max(0, seconds) }, duration: Math.max(0, duration), buffered: this.bufferSeconds() });
    if (this.state.sleepAt && Date.now() >= this.state.sleepAt) { this.patch({ sleepAt: null }); this.pause(); return; }
    if (finished && this.state.status === 'playing') { this.transition = true; void this.next(1); return; }
    // Reflect lock-screen controls and audio interruptions without automatic restart.
    if (playing && this.state.status === 'paused') { this.deps.focus(); this.patch({ status: 'playing' }); }
    else if (!playing && this.state.status === 'playing') { this.patch({ status: 'paused' }); this.checkpoint(); }
    if (this.state.status === 'playing' && Date.now() - this.lastSaved > 5000) this.checkpoint();
    if (playing) void this.fill();
  }
  checkpoint(localOnly = false) {
    const b = this.state.bookmark;
    if (!b || this.disposed) return;
    this.lastSaved = Date.now();
    const snapshot = { ...b, savedAt: this.lastSaved };
    if (localOnly) return this.deps.save(snapshot, true).catch((error) => { this.patch({ syncError: error instanceof Error ? error.message : '本机进度保存失败' }); });
    this.saveQueue = this.saveQueue.then(async () => {
      try { await this.deps.save(snapshot); this.patch({ syncError: '' }); }
      catch (error) { this.patch({ syncError: error instanceof Error ? error.message : '进度同步失败' }); }
    });
    return this.saveQueue;
  }
  flush() { return this.saveQueue; }
  private fail(error: unknown) { this.deps.player.pause(); this.transition = false; this.patch({ status: 'error', error: error instanceof Error ? error.message : '听书暂时不可用' }); this.checkpoint(); }
  dispose() { if (this.disposed) return; this.disposed = true; this.invalidate(); this.clearBuffer(); this.deps.player.release(); this.listeners.clear(); }
}
