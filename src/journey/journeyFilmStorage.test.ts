import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamTargetChunk } from "mediabunny";
import {
  createJourneyFilmStorage,
  clearRetainedJourneyFilmDownloads,
  listRetainedJourneyFilmDownloads,
  FILM_MEMORY_OUTPUT_BYTES,
  FILM_STORAGE_CHUNK_BYTES,
  FILM_UNKNOWN_STORAGE_OUTPUT_BYTES,
  type JourneyFilmStorage,
} from "./journeyFilmStorage";

// Exercise the storage boundary independently of codecs. Browser QA uses the real muxer.
vi.mock("mediabunny", () => ({
  StreamTarget: class {
    constructor(readonly writable: WritableStream<StreamTargetChunk>, readonly options: unknown) {}
  },
}));

const MIB = 1024 * 1024;
const signal = () => new AbortController().signal;
const chunk = (position: number, values: number[]): StreamTargetChunk => ({ type: "write", position, data: new Uint8Array(values) });
const writerFor = (storage: JourneyFilmStorage) => (storage.target as unknown as {
  writable: WritableStream<StreamTargetChunk>;
}).writable.getWriter();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeLocks() {
  const states = new Map<string, { held: boolean; queue: Array<() => void> }>();
  const queued = new Map<string, ReturnType<typeof deferred>>();
  const request = <T>(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: { name: string } | null) => T | Promise<T>): Promise<T> => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    let state = states.get(name);
    if (options.ifAvailable && state?.held) return Promise.resolve(callback(null));
    if (!state) { state = { held: false, queue: [] }; states.set(name, state); }
    const current = state;
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const abort = () => {
        if (started) return;
        const index = current.queue.indexOf(start);
        if (index !== -1) current.queue.splice(index, 1);
        options.signal?.removeEventListener("abort", abort);
        reject(options.signal?.reason);
      };
      const complete = () => {
        current.held = false;
        const next = current.queue.shift();
        if (next) next(); else states.delete(name);
      };
      const start = () => {
        started = true; current.held = true;
        options.signal?.removeEventListener("abort", abort);
        void Promise.resolve().then(() => callback({ name })).then(
          (value) => { complete(); resolve(value); },
          (error: unknown) => { complete(); reject(error); },
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (current.held) { current.queue.push(start); queued.get(name)?.resolve(); }
      else start();
    });
  };
  return {
    request,
    isHeld: (name: string) => states.get(name)?.held === true,
    whenQueued(name: string) {
      if (states.get(name)?.queue.length) return Promise.resolve();
      let event = queued.get(name);
      if (!event) { event = deferred(); queued.set(name, event); }
      return event.promise;
    },
    async hold(name: string) {
      const entered = deferred(), held = deferred();
      const waiting = request(name, {}, async () => { entered.resolve(); await held.promise; });
      await entered.promise;
      return async () => { held.resolve(); await waiting; };
    },
  };
}

function disk(options: {
  quota?: number;
  usage?: number;
  estimateError?: Error;
  openError?: Error;
  writeError?: Error;
  closeError?: Error;
  readError?: Error;
  writeGate?: ReturnType<typeof deferred>;
  closeGate?: ReturnType<typeof deferred>;
  openGate?: ReturnType<typeof deferred>;
  retainGate?: ReturnType<typeof deferred>;
} = {}) {
  const writeStarted = deferred(), closeStarted = deferred(), openStarted = deferred(), retainStarted = deferred();
  const write = vi.fn(async (_value: StreamTargetChunk) => {
    writeStarted.resolve();
    await options.writeGate?.promise;
    if (options.writeError) throw options.writeError;
  });
  const close = vi.fn(async () => {
    closeStarted.resolve();
    await options.closeGate?.promise;
    if (options.closeError) throw options.closeError;
  });
  const abort = vi.fn();
  function makeFile(name: string, initial = new Blob([])) {
    let stored = initial;
    const contents = new Map<number, number>();
    let size = 0;
    return {
      name, kind: "file" as const,
      getFile: vi.fn(async () => {
        if (name !== "film.mp4") return stored;
        if (options.readError) throw options.readError;
        const bytes = new Uint8Array(size);
        for (const [position, byte] of contents) bytes[position] = byte;
        return new Blob([bytes]);
      }),
      createWritable: vi.fn(async () => {
        if (name !== "film.mp4") {
          let staged = new Blob([]);
          return {
            write: async (value: string) => { staged = new Blob([value]); },
            close: async () => {
              if (name === "retained.json") { retainStarted.resolve(); await options.retainGate?.promise; }
              stored = staged;
            },
            abort: async () => {},
          };
        }
        openStarted.resolve(); await options.openGate?.promise;
        if (options.openError) throw options.openError;
        return new WritableStream<StreamTargetChunk>({
          async write(value) {
            await write(value);
            value.data.forEach((byte, index) => contents.set(value.position + index, byte));
            size = Math.max(size, value.position + value.data.byteLength);
          },
          close, abort,
        });
      }),
    };
  }
  class Directory {
    readonly kind = "directory";
    readonly directories = new Map<string, Directory>();
    readonly files = new Map<string, ReturnType<typeof makeFile>>();
    constructor(readonly name: string) {}
    getDirectoryHandle = vi.fn(async (name: string, flags?: { create?: boolean }): Promise<Directory> => {
      let child = this.directories.get(name);
      if (!child && flags?.create) { child = new Directory(name); this.directories.set(name, child); }
      if (!child) throw new DOMException("missing", "NotFoundError");
      return child;
    });
    getFileHandle = vi.fn(async (name: string, flags?: { create?: boolean }) => {
      let child = this.files.get(name);
      if (!child && flags?.create) { child = makeFile(name); this.files.set(name, child); }
      if (!child) throw new DOMException("missing", "NotFoundError");
      return child;
    });
    removeEntry = vi.fn(async (name: string, _flags?: { recursive?: boolean }) => {
      if (!this.directories.delete(name) && !this.files.delete(name)) throw new DOMException("missing", "NotFoundError");
    });
    async *values() { yield* this.directories.values(); yield* this.files.values(); }
  }
  const root = new Directory("root"), directory = new Directory("startrips-film-temporary");
  root.directories.set(directory.name, directory);
  const storage = {
    estimate: vi.fn(async () => {
      if (options.estimateError) throw options.estimateError;
      return { quota: options.quota ?? 8 * 1024 * MIB, usage: options.usage ?? 0 };
    }),
    getDirectory: vi.fn(async () => root),
  };
  const locks = fakeLocks();
  vi.stubGlobal("navigator", { storage, locks });
  const seed = (id: string, values: { retained?: unknown; reserved?: number }) => {
    const child = new Directory(id);
    child.files.set("reservation.json", makeFile("reservation.json", new Blob([JSON.stringify({ version: 1, byteLimit: values.reserved ?? MIB })])));
    if ("retained" in values) child.files.set("retained.json", makeFile("retained.json", new Blob([JSON.stringify(values.retained)])));
    directory.directories.set(id, child);
    return child;
  };
  return { storage, root, directory, locks, seed, write, close, abort, writeStarted, closeStarted, openStarted, retainStarted };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("bounded Journey film output storage", () => {
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid estimates: %s", async (expected) => {
    await expect(createJourneyFilmStorage(expected, signal())).rejects.toThrow("journey_film_output_limit");
  });

  it("rejects an already canceled request before opening storage", async () => {
    const mock = disk();
    const controller = new AbortController(); controller.abort();
    await expect(createJourneyFilmStorage(1, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.storage.estimate).not.toHaveBeenCalled();
    expect(mock.storage.getDirectory).not.toHaveBeenCalled();
  });

  it("falls back to positioned memory chunks without OPFS, including overlapping writes", async () => {
    vi.stubGlobal("navigator", {});
    const progress = vi.fn();
    const storage = await createJourneyFilmStorage(32, signal(), progress);
    expect(storage.storageMode).toBe("memory");
    expect(storage.byteLimit).toBe(FILM_MEMORY_OUTPUT_BYTES);
    expect((storage.target as unknown as { options: unknown }).options).toEqual({ chunked: true, chunkSize: FILM_STORAGE_CHUNK_BYTES });
    const writer = writerFor(storage);
    await writer.write(chunk(2, [3, 4]));
    await writer.write(chunk(0, [1, 2, 9]));
    await writer.close();
    const blob = await storage.finish();
    expect(blob.type).toBe("video/mp4");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 9, 4]);
    expect(progress.mock.calls).toEqual([[4], [4]]);
    expect(await storage.finish()).toBe(blob);
    const disposal = storage.dispose();
    expect(storage.dispose()).toBe(disposal);
    await disposal;
    await expect(storage.finish()).rejects.toThrow("journey_film_storage_unavailable");
  });

  it("refuses a large memory fallback before allocating output", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(createJourneyFilmStorage(FILM_MEMORY_OUTPUT_BYTES + 1, signal())).rejects.toMatchObject({
      message: "journey_film_storage_unavailable", requiredBytes: FILM_MEMORY_OUTPUT_BYTES + 1,
      availableBytes: FILM_MEMORY_OUTPUT_BYTES,
    });
  });

  it("requires Web Locks for cross-tab-safe disk storage", async () => {
    const mock = disk();
    vi.stubGlobal("navigator", { storage: mock.storage });
    const storage = await createJourneyFilmStorage(1, signal());
    expect(storage.storageMode).toBe("memory");
    await storage.dispose();
    await expect(createJourneyFilmStorage(FILM_MEMORY_OUTPUT_BYTES + 1, signal())).rejects.toThrow("journey_film_storage_unavailable");
    expect(mock.storage.getDirectory).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, FILM_MEMORY_OUTPUT_BYTES])(
    "rejects an invalid or overflowing memory write before progress: %s", async (position) => {
      vi.stubGlobal("navigator", {});
      const progress = vi.fn();
      const storage = await createJourneyFilmStorage(1, signal(), progress);
      const writer = writerFor(storage);
      void writer.closed.catch(() => {});
      await expect(writer.write(chunk(position, [1]))).rejects.toThrow("journey_film_output_limit");
      expect(progress).not.toHaveBeenCalled();
      await storage.dispose();
    },
  );

  it("returns a disk-backed MIME-correct Blob and removes only its own file on disposal", async () => {
    const mock = disk();
    const progress = vi.fn();
    const storage = await createJourneyFilmStorage(100 * MIB, signal(), progress);
    expect(storage.storageMode).toBe("disk");
    expect(storage.byteLimit).toBe(125 * MIB);
    const writer = writerFor(storage);
    await writer.write(chunk(0, [1, 2, 3]));
    await writer.write(chunk(1, [4]));
    await writer.close();
    const blob = await storage.finish();
    expect(blob.type).toBe("video/mp4");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 4, 3]);
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual([[3], [3]]);
    const disposal = storage.dispose();
    expect(storage.dispose()).toBe(disposal);
    await disposal;
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
    expect(mock.directory.removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/), { recursive: true });
    expect(mock.abort).not.toHaveBeenCalled();
  });

  it("keeps the completed artifact after the old export signal expires", async () => {
    const mock = disk();
    const controller = new AbortController();
    const storage = await createJourneyFilmStorage(1, controller.signal);
    const writer = writerFor(storage);
    await writer.write(chunk(0, [1])); await writer.close();
    const blob = await storage.finish();
    controller.abort();
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    expect(blob.size).toBe(1);
    await storage.dispose();
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
  });

  it("bounds known quota by half the remaining storage and a global 512 MiB ceiling", async () => {
    disk({ quota: 300 * MIB, usage: 100 * MIB });
    const storage = await createJourneyFilmStorage(100 * MIB, signal());
    expect(storage.byteLimit).toBe(100 * MIB);
    await storage.dispose();
    const mock = disk();
    await expect(createJourneyFilmStorage(FILM_UNKNOWN_STORAGE_OUTPUT_BYTES + 1, signal())).rejects.toMatchObject({
      message: "journey_film_output_limit", requiredBytes: FILM_UNKNOWN_STORAGE_OUTPUT_BYTES + 1,
      availableBytes: FILM_UNKNOWN_STORAGE_OUTPUT_BYTES,
    });
    expect(mock.storage.getDirectory).not.toHaveBeenCalled();
  });

  it("uses bounded memory if quota is insufficient only when the estimate fits it", async () => {
    const mock = disk({ quota: 64 * MIB });
    const storage = await createJourneyFilmStorage(64 * MIB, signal());
    expect(storage.storageMode).toBe("memory");
    expect(mock.storage.getDirectory).not.toHaveBeenCalled();
    await storage.dispose();
    await expect(createJourneyFilmStorage(97 * MIB, signal())).rejects.toThrow("journey_film_output_limit");
  });

  it("uses a bounded disk budget when the quota estimate is unavailable", async () => {
    disk({ estimateError: new Error("estimate unavailable") });
    const storage = await createJourneyFilmStorage(500 * MIB, signal());
    expect(storage.storageMode).toBe("disk");
    expect(storage.byteLimit).toBe(FILM_UNKNOWN_STORAGE_OUTPUT_BYTES);
    await storage.dispose();
  });

  it("rejects a disk overflow before forwarding bytes to the filesystem", async () => {
    const mock = disk();
    const progress = vi.fn();
    const storage = await createJourneyFilmStorage(100 * MIB, signal(), progress);
    const writer = writerFor(storage);
    void writer.closed.catch(() => {});
    await expect(writer.write(chunk(storage.byteLimit, [1]))).rejects.toThrow("journey_film_output_limit");
    expect(mock.write).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    await storage.dispose();
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
  });

  it("cleans an empty temporary file if opening its writer fails", async () => {
    const mock = disk({ openError: new DOMException("storage blocked", "NotAllowedError") });
    const storage = await createJourneyFilmStorage(1, signal());
    expect(storage.storageMode).toBe("memory");
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
    await storage.dispose();
  });

  it("cleans up cancellation that arrives while opening a writer", async () => {
    const gate = deferred();
    const mock = disk({ openGate: gate });
    const controller = new AbortController();
    const pending = createJourneyFilmStorage(1, controller.signal);
    await mock.openStarted.promise;
    controller.abort(); gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.abort).toHaveBeenCalledTimes(1);
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
  });

  it("propagates quota exhaustion without reporting a successful write or artifact", async () => {
    const mock = disk({ writeError: new DOMException("full", "QuotaExceededError") });
    const progress = vi.fn();
    const storage = await createJourneyFilmStorage(1, signal(), progress);
    const writer = writerFor(storage);
    void writer.closed.catch(() => {});
    await expect(writer.write(chunk(0, [1]))).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(progress).not.toHaveBeenCalled();
    await expect(storage.finish()).rejects.toThrow("journey_film_output_invalid");
    await storage.dispose();
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
  });

  it("propagates close failures and deletes the temporary file", async () => {
    const mock = disk({ closeError: new Error("close failed") });
    const storage = await createJourneyFilmStorage(1, signal());
    const writer = writerFor(storage);
    void writer.closed.catch(() => {});
    await writer.write(chunk(0, [1]));
    await expect(writer.close()).rejects.toThrow("close failed");
    await expect(storage.finish()).rejects.toThrow("journey_film_output_invalid");
    await storage.dispose();
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
  });

  it("errors the muxer immediately on abort but waits for the physical write before removal", async () => {
    const gate = deferred();
    const mock = disk({ writeGate: gate });
    const controller = new AbortController();
    const storage = await createJourneyFilmStorage(1, controller.signal);
    const writer = writerFor(storage);
    void writer.closed.catch(() => {});
    const writing = writer.write(chunk(0, [1]));
    const settledWrite = writing.catch(() => {});
    await mock.writeStarted.promise;
    controller.abort();
    await expect(writer.ready).rejects.toMatchObject({ name: "AbortError" });
    const disposal = storage.dispose();
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    gate.resolve();
    await settledWrite;
    await disposal;
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
    await expect(storage.finish()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not unlink while a final filesystem close is still in flight", async () => {
    const gate = deferred();
    const mock = disk({ closeGate: gate });
    const controller = new AbortController();
    const storage = await createJourneyFilmStorage(1, controller.signal);
    const writer = writerFor(storage);
    void writer.closed.catch(() => {});
    await writer.write(chunk(0, [1]));
    const closing = writer.close().catch(() => {});
    await mock.closeStarted.promise;
    controller.abort();
    await expect(writer.ready).rejects.toMatchObject({ name: "AbortError" });
    const disposal = storage.dispose();
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    gate.resolve();
    await closing; await disposal;
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
  });

  it("retains a completed anchor-download file across disposal until explicit cleanup", async () => {
    const mock = disk();
    const storage = await createJourneyFilmStorage(1, signal());
    const writer = writerFor(storage);
    await writer.write(chunk(0, [1, 2, 3])); await writer.close();
    await storage.finish();
    await storage.retainForDownload();
    await storage.retainForDownload();
    expect(await listRetainedJourneyFilmDownloads()).toEqual({ count: 1, bytes: 3 });
    // Even explicit cleanup skips a live export lease.
    expect(await clearRetainedJourneyFilmDownloads()).toEqual({ count: 1, bytes: 3 });
    await storage.dispose();
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    expect(await listRetainedJourneyFilmDownloads()).toEqual({ count: 1, bytes: 3 });
    expect(await clearRetainedJourneyFilmDownloads()).toEqual({ count: 0, bytes: 0 });
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
  });

  it("cannot retain an unfinished or disposed file", async () => {
    disk();
    const storage = await createJourneyFilmStorage(1, signal());
    await expect(storage.retainForDownload()).rejects.toThrow("journey_film_output_invalid");
    await storage.dispose();
    await expect(storage.retainForDownload()).rejects.toThrow("journey_film_output_invalid");
  });

  it("drains overlapping retention before releasing the lease without deleting the download", async () => {
    const gate = deferred();
    const mock = disk({ retainGate: gate });
    const storage = await createJourneyFilmStorage(1, signal());
    const writer = writerFor(storage);
    await writer.write(chunk(0, [1, 2])); await writer.close(); await storage.finish();
    const retaining = storage.retainForDownload();
    await mock.retainStarted.promise;
    const disposal = storage.dispose();
    const id = [...mock.directory.directories.keys()][0];
    expect(mock.locks.isHeld(`startrips-film-export:${id}`)).toBe(true);
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    gate.resolve();
    await retaining; await disposal;
    expect(mock.locks.isHeld(`startrips-film-export:${id}`)).toBe(false);
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    expect(await listRetainedJourneyFilmDownloads()).toEqual({ count: 1, bytes: 2 });
    expect(await clearRetainedJourneyFilmDownloads()).toEqual({ count: 0, bytes: 0 });
  });

  it("aborts a queued registry-lock acquisition without leaking a lease or reservation", async () => {
    const mock = disk();
    const releaseRegistry = await mock.locks.hold("startrips-film-registry");
    const controller = new AbortController();
    const creating = createJourneyFilmStorage(100 * MIB, controller.signal);
    await mock.locks.whenQueued("startrips-film-registry");
    controller.abort();
    // The rejected acquisition must settle even though another tab still owns the registry lock.
    await expect(creating).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.directory.directories.size).toBe(0);
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    await releaseRegistry();
    const retry = await createJourneyFilmStorage(100 * MIB, signal());
    await retry.dispose();
  });

  it("counts persisted retained files toward the eight-export bound", async () => {
    const mock = disk();
    for (let index = 0; index < 8; index++) mock.seed(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, {
      retained: { version: 1, bytes: 1 },
    });
    expect(await listRetainedJourneyFilmDownloads()).toEqual({ count: 8, bytes: 8 });
    await expect(createJourneyFilmStorage(1, signal())).rejects.toMatchObject({
      message: "journey_film_downloads_pending", requiredBytes: 1,
      availableBytes: FILM_UNKNOWN_STORAGE_OUTPUT_BYTES - 8, exportCount: 8, exportLimit: 8,
    });
    expect(mock.directory.directories.size).toBe(8);
    expect(mock.write).not.toHaveBeenCalled();
    await clearRetainedJourneyFilmDownloads();
    const storage = await createJourneyFilmStorage(1, signal());
    expect(storage.storageMode).toBe("disk");
    await storage.dispose();
  });

  it("counts retained bytes and concurrent active reservations toward the aggregate bound", async () => {
    const mock = disk();
    mock.seed("00000000-0000-4000-8000-000000000001", { retained: { version: 1, bytes: 511 * MIB } });
    await expect(createJourneyFilmStorage(2 * MIB, signal())).rejects.toThrow("journey_film_downloads_pending");
    await clearRetainedJourneyFilmDownloads();
    const first = await createJourneyFilmStorage(300 * MIB, signal());
    expect(first.byteLimit).toBe(375 * MIB);
    await expect(createJourneyFilmStorage(140 * MIB, signal())).rejects.toThrow("journey_film_downloads_pending");
    await first.dispose();
    const second = await createJourneyFilmStorage(140 * MIB, signal());
    await second.dispose();
  });

  it("reclaims only unretained orphans, leaving active tabs and retained downloads alone", async () => {
    const mock = disk();
    const orphan = "00000000-0000-4000-8000-000000000001";
    const retained = "00000000-0000-4000-8000-000000000002";
    const active = "00000000-0000-4000-8000-000000000003";
    mock.seed(orphan, { reserved: MIB });
    mock.seed(retained, { retained: { version: 1, bytes: 1 } });
    mock.seed(active, { reserved: MIB });
    const release = await mock.locks.hold(`startrips-film-export:${active}`);
    const storage = await createJourneyFilmStorage(1, signal());
    expect(mock.directory.directories.has(orphan)).toBe(false);
    expect(mock.directory.directories.has(retained)).toBe(true);
    expect(mock.directory.directories.has(active)).toBe(true);
    expect(mock.directory.removeEntry).toHaveBeenCalledTimes(1);
    expect(mock.directory.removeEntry).toHaveBeenCalledWith(orphan, { recursive: true });
    await storage.dispose(); await release();
    await clearRetainedJourneyFilmDownloads();
  });

  it("treats malformed retained markers conservatively until explicit cleanup", async () => {
    const mock = disk();
    mock.seed("00000000-0000-4000-8000-000000000001", { retained: { damaged: true } });
    expect(await listRetainedJourneyFilmDownloads()).toEqual({ count: 1, bytes: FILM_UNKNOWN_STORAGE_OUTPUT_BYTES });
    await expect(createJourneyFilmStorage(1, signal())).rejects.toThrow("journey_film_downloads_pending");
    expect(mock.directory.removeEntry).not.toHaveBeenCalled();
    expect(await clearRetainedJourneyFilmDownloads()).toEqual({ count: 0, bytes: 0 });
  });
});
