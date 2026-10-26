import type { BookPage } from './model.ts';

export type DownloadedBook = {
  id: string; worldId: string; textbook: { id: string; title: string; numPages: number; [key: string]: unknown };
  dir: string; signature: string; pages: Record<string, BookPage>; audio: Record<string, string>;
};
export const pageKey = (number: number, dramatic: boolean) => `${number}/${dramatic}`;
export const audioKey = (page: BookPage, index: number, voice: string) => JSON.stringify([page.signature, page.page, index, page.passages[index].text, voice]);
export const completePages = (book: DownloadedBook) => Object.entries(book.pages).filter(([, page]) => page.passages.every((passage, i) => book.audio[audioKey(page, i, passage.voice)]));

/** Metadata commits only after a complete local audio write; cancellation keeps prior files. */
export class OfflineShelf {
  private books: DownloadedBook[] | null = null;
  private writes: Promise<void> = Promise.resolve();
  private deps: {
    read(): Promise<string | null>; write(value: string): Promise<void>; guard(): void;
    store(key: string, url: string, signal: AbortSignal): Promise<string>;
    remove(location: string): Promise<void>; namespace: string;
  };
  constructor(deps: OfflineShelf['deps']) { this.deps = deps; }
  async list() {
    this.deps.guard();
    if (!this.books) {
      const raw = await this.deps.read(); this.deps.guard();
      this.books = raw ? JSON.parse(raw) : [];
    }
    return this.books!;
  }
  private commit(change: () => void) {
    const next = this.writes.then(async () => {
      this.deps.guard(); await this.list(); this.deps.guard();
      change();
      try { await this.deps.write(JSON.stringify(this.books)); this.deps.guard(); }
      catch (error) { this.books = null; throw error; }
    });
    this.writes = next.catch(() => {});
    return next;
  }
  async ensure(worldId: string, textbook: DownloadedBook['textbook'], dir: string, signature: string) {
    const found = (await this.list()).find((book) => book.dir === dir);
    if (found) {
      if (found.signature !== signature) throw new Error('教材已更新，请删除旧下载后重新下载');
      return found;
    }
    const book: DownloadedBook = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, worldId, textbook, dir, signature, pages: {}, audio: {} };
    await this.commit(() => { this.books!.push(book); }); return book;
  }
  async putPage(book: DownloadedBook, page: BookPage, dramatic: boolean) {
    if (page.signature !== book.signature) throw new Error('教材已更新，下载已停止');
    await this.commit(() => { book.pages[pageKey(page.page, dramatic)] = page; });
  }
  async putAudio(book: DownloadedBook, key: string, url: string, signal: AbortSignal) {
    this.deps.guard();
    if (signal.aborted) throw new Error('下载已暂停');
    const location = await this.deps.store(`${this.deps.namespace}/${book.id}/${key}`, url, signal);
    try {
      this.deps.guard(); if (signal.aborted) throw new Error('下载已暂停');
      await this.commit(() => { book.audio[key] = location; });
    } catch (error) { await this.deps.remove(location); throw error; }
  }
  async remove(id: string) {
    const book = (await this.list()).find((entry) => entry.id === id);
    if (!book) return;
    // Delete payloads before dropping their index, so storage failures remain retryable.
    for (const location of Object.values(book.audio)) { this.deps.guard(); await this.deps.remove(location); }
    await this.commit(() => { this.books = this.books!.filter((entry) => entry.id !== id); });
  }
}
