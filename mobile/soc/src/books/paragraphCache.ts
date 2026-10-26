export type CachedClip = { uri: string; duration: number };
type Entry = { key: string; location: string; duration: number };

/** Account-scoped disk cache. Signed provider URLs are never persisted. */
export class ParagraphCache {
  private entries: Entry[] | null = null;
  private writes: Promise<void> = Promise.resolve();
  private jobs = new Map<string, { signal: AbortSignal; promise: Promise<CachedClip> }>();
  private deps: {
    read(): Promise<string | null>; write(value: string): Promise<void>; guard(): void;
    store(key: string, url: string, signal: AbortSignal): Promise<string>;
    open(location: string): Promise<string | null>; duration(uri: string): Promise<number>;
    remove(location: string): Promise<void>; release(uri: string): void; namespace: string;
  };
  constructor(deps: ParagraphCache['deps']) { this.deps = deps; }
  private async list() {
    this.deps.guard();
    if (!this.entries) { const raw = await this.deps.read(); this.deps.guard(); this.entries = raw ? JSON.parse(raw) : []; }
    return this.entries!;
  }
  private async commit(change: (entries: Entry[]) => void) {
    const work = this.writes.then(async () => {
      const entries = await this.list(); this.deps.guard(); change(entries);
      await this.deps.write(JSON.stringify(entries));
    });
    this.writes = work.catch(() => { this.entries = null; });
    return work;
  }
  get(key: string, signal: AbortSignal, synthesize: () => Promise<string>): Promise<CachedClip> {
    const running = this.jobs.get(key);
    if (running && !running.signal.aborted) return running.promise;
    const job = this.resolve(key, signal, synthesize).finally(() => { if (this.jobs.get(key)?.promise === job) this.jobs.delete(key); });
    this.jobs.set(key, { signal, promise: job }); return job;
  }
  private async resolve(key: string, signal: AbortSignal, synthesize: () => Promise<string>): Promise<CachedClip> {
    const entry = (await this.list()).find((e) => e.key === key);
    if (entry) {
      const uri = await this.deps.open(entry.location); this.deps.guard();
      if (uri) {
        if (signal.aborted) { this.deps.release(uri); throw new Error('已取消'); }
        await this.commit((entries) => { const at = entries.indexOf(entry); if (at >= 0) entries.splice(at, 1); entries.push(entry); });
        return { uri, duration: entry.duration };
      }
    }
    if (signal.aborted) throw new Error('已取消');
    const url = await synthesize(); this.deps.guard();
    const location = await this.deps.store(`${this.deps.namespace}/${key}`, url, signal);
    let uri: string | null = null;
    try {
      this.deps.guard();
      uri = await this.deps.open(location);
      if (!uri || signal.aborted) throw new Error('已取消');
      const duration = await this.deps.duration(uri);
      const evicted: Entry[] = [];
      await this.commit((entries) => {
        const old = entries.findIndex((e) => e.key === key); if (old >= 0) entries.splice(old, 1);
        entries.push({ key, location, duration });
        // Keep recently heard phrases without turning ordinary playback into a whole-book download.
        while (entries.length > 128) evicted.push(entries.shift()!);
      });
      for (const old of evicted) await this.deps.remove(old.location);
      if (signal.aborted) { this.deps.release(uri); throw new Error('已取消'); }
      return { uri, duration };
    } catch (error) {
      if (uri) this.deps.release(uri);
      if (!(await this.list()).some((e) => e.location === location)) await this.deps.remove(location);
      throw error;
    }
  }
}
