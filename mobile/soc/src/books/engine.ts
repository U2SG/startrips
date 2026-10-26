import { restoreBookmark, toneRate, isSpeakable, type BookPage, type Bookmark } from './model.ts';

type Status = 'paused' | 'loading' | 'playing' | 'ended' | 'error';
export type BookState = { page: BookPage | null; bookmark: Bookmark | null; status: Status; duration: number; error: string; syncError: string; sleepAt: number | null };
export type BookAudio = {
  load(uri: string, seconds: number, rate: number): Promise<void>;
  play(): void; pause(): void; seek(seconds: number): Promise<void>; rate(value: number): void;
  release(): void;
};
export type BookDependencies = {
  page(number: number, dramatic: boolean, signal: AbortSignal): Promise<BookPage>;
  audio(page: BookPage, index: number, signal: AbortSignal): Promise<string | null>;
  remove(uri: string): void;
  save(bookmark: Bookmark, localOnly?: boolean): Promise<void>;
  focus(): void;
  player: BookAudio;
};

/** One owner, one bounded look-ahead buffer. A failed phrase is never skipped. */
export class BookEngine {
  private state: BookState = { page: null, bookmark: null, status: 'paused', duration: 0, error: '', syncError: '', sleepAt: null };
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private sequence = 0;
  private disposed = false;
  private loaded = '';
  private jobs = new Map<string, Promise<string | null>>();
  private ready = new Set<string>();
  private uris = new Set<string>();
  private saveQueue: Promise<void> = Promise.resolve();
  private lastSaved = 0;
  private transition = false;
  private movedAt = Date.now();
  private lastPosition = 0;
  private resumeFrom: unknown = null;
  private deps: BookDependencies;
  constructor(deps: BookDependencies) { this.deps = deps; }
  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private patch(next: Partial<BookState>) { if (this.disposed) return; this.state = { ...this.state, ...next }; this.listeners.forEach((fn) => fn()); }
  private current(seq: number) { return !this.disposed && seq === this.sequence && !this.controller.signal.aborted; }
  private invalidate() { ++this.sequence; this.controller.abort(); this.controller = new AbortController(); this.deps.player.pause(); this.transition = false; }
  private clearBuffer() { this.jobs.clear(); this.ready.clear(); this.uris.forEach(this.deps.remove); this.uris.clear(); this.loaded = ''; }
  private key(page: BookPage, index: number) { return `${page.signature}/${page.page}/${index}/${this.state.bookmark?.dramatic}`; }
  private prepare(page: BookPage, index: number) {
    const key = this.key(page, index);
    if (!this.jobs.has(key)) {
      const signal = this.controller.signal;
      const job = this.deps.audio(page, index, signal).then((uri) => {
        if (signal.aborted || this.disposed) { if (uri) this.deps.remove(uri); return null; }
        if (uri) { this.uris.add(uri); this.ready.add(key); } return uri;
      });
      this.jobs.set(key, job);
    }
    return this.jobs.get(key)!;
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
    this.invalidate(); this.clearBuffer();
    const seq = this.sequence;
    this.patch({ status: 'loading', duration: 0, error: '' });
    try {
      const dramatic = (previous as Partial<Bookmark> | null)?.dramatic !== false;
      const page = await this.deps.page(Math.max(1, Math.trunc(number)), dramatic, this.controller.signal);
      if (!this.current(seq)) return;
      const bookmark = restoreBookmark(previous, page);
      if (raw === undefined) { bookmark.passage = Math.max(0, Math.min(index, Math.max(0, page.passages.length - 1))); bookmark.seconds = 0; }
      this.patch({ page, bookmark, status: 'paused' }); this.checkpoint();
      if (play) await this.play();
    } catch (error) { if (this.current(seq)) this.fail(error); }
  }
  async play() {
    const { page, bookmark: b } = this.state;
    if (!page || !b || this.disposed || this.state.status === 'loading') return;
    if (this.state.status === 'ended') { await this.go(1, 0, true); return; }
    this.deps.focus();
    if (!page.passages.length) {
      if (page.page < page.total) { await this.go(page.page + 1, 0, true); return; }
      this.patch({ status: 'ended' }); return;
    }
    if (!isSpeakable(page.passages[b.passage].text)) { await this.next(1); return; }
    const seq = this.sequence;
    const key = this.key(page, b.passage);
    this.transition = true;
    this.patch({ status: 'loading', error: '' });
    try {
      const uri = await this.prepare(page, b.passage);
      if (!this.current(seq)) return;
      if (!uri) { this.jobs.delete(key); throw new Error('这段音频生成失败，请重试，进度已保留'); }
      if (this.loaded !== key) {
        await this.deps.player.load(uri, b.seconds, b.speed * toneRate(page.passages[b.passage].tone));
        if (!this.current(seq)) return;
        this.loaded = key;
      }
      this.deps.player.rate((this.state.bookmark?.speed || b.speed) * toneRate(page.passages[b.passage].tone));
      this.deps.player.play();
      this.movedAt = Date.now(); this.lastPosition = b.seconds;
      this.patch({ status: 'playing' }); this.transition = false;
      if (b.passage + 1 < page.passages.length) void this.prepare(page, b.passage + 1).catch(() => {});
      // Keep just the current and next audio files; books can be thousands of phrases.
      for (const [old, promise] of this.jobs) if (old !== key && old !== this.key(page, b.passage + 1)) {
        this.jobs.delete(old); this.ready.delete(old); void promise.then((file) => { if (file) { this.uris.delete(file); this.deps.remove(file); } }).catch(() => {});
      }
    } catch (error) { this.jobs.delete(key); if (this.current(seq)) this.fail(error); }
  }
  pause(localOnly = false) {
    if (this.disposed) return;
    // Cancel preparation too: a paused pending request must never start playing later.
    const loading = this.state.status === 'loading';
    this.invalidate();
    for (const key of this.jobs.keys()) if (!this.ready.has(key)) this.jobs.delete(key);
    if (loading) this.clearBuffer();
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
    this.checkpoint(); await this.play();
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
    this.patch({ status: 'paused', duration: 0, error: '' });
    if (playing && this.state.page) await this.play();
  }
  async mode(dramatic: boolean) {
    const b = this.state.bookmark;
    if (!b) return;
    await this.go(b.page, b.passage, false, { ...b, dramatic });
  }
  sleep(minutes: number) { this.patch({ sleepAt: minutes > 0 ? Date.now() + minutes * 60000 : null }); }
  poll() {
    if (this.disposed) return;
    if (this.state.sleepAt && Date.now() >= this.state.sleepAt) { this.patch({ sleepAt: null }); this.pause(); return; }
    if (this.state.status === 'playing' && Date.now() - this.movedAt > 15000) {
      this.loaded = ''; this.fail(new Error('音频播放中断，请重试，进度已保留'));
    }
  }
  tick(seconds: number, duration: number, playing: boolean, finished: boolean) {
    if (this.disposed || this.transition || this.state.status === 'loading') return;
    const b = this.state.bookmark;
    if (!b || !this.loaded) return;
    if (Math.abs(seconds - this.lastPosition) > 0.05 || !playing) { this.lastPosition = seconds; this.movedAt = Date.now(); }
    this.patch({ bookmark: { ...b, seconds: Math.max(0, seconds) }, duration: Math.max(0, duration) });
    if (this.state.sleepAt && Date.now() >= this.state.sleepAt) { this.patch({ sleepAt: null }); this.pause(); return; }
    if (finished && this.state.status === 'playing') { this.transition = true; void this.next(1); return; }
    // Reflect lock-screen controls and audio interruptions without automatic restart.
    if (playing && this.state.status === 'paused') { this.deps.focus(); this.patch({ status: 'playing' }); }
    else if (!playing && this.state.status === 'playing') { this.patch({ status: 'paused' }); this.checkpoint(); }
    if (this.state.status === 'playing' && Date.now() - this.lastSaved > 5000) this.checkpoint();
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
