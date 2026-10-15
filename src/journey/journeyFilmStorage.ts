import { StreamTarget, type StreamTargetChunk } from "mediabunny";

const MIB = 1024 * 1024;
export const FILM_MEMORY_OUTPUT_BYTES = 96 * MIB;
export const FILM_UNKNOWN_STORAGE_OUTPUT_BYTES = 512 * MIB;
export const FILM_STORAGE_CHUNK_BYTES = MIB;
export const FILM_STORAGE_MAX_EXPORTS = 8;
const TEMP_DIRECTORY = "startrips-film-temporary";
const REGISTRY_LOCK = "startrips-film-registry";
const leaseName = (id: string) => `startrips-film-export:${id}`;
const exportName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JourneyFilmDownloadSummary { count: number; bytes: number; }

export interface JourneyFilmStorage {
  target: StreamTarget;
  readonly storageMode: "disk" | "memory";
  readonly byteLimit: number;
  /** Call after Output.finalize(). The returned Blob retains this storage until dispose(). */
  finish(): Promise<Blob>;
  /** Persist completion before starting an anchor download whose completion is unobservable. */
  retainForDownload(): Promise<void>;
  /** Idempotent. Call after canceling/draining the encoder, or when the artifact is discarded. */
  dispose(): Promise<void>;
}

function limitError(code: string, requiredBytes?: number, availableBytes?: number): Error {
  return Object.assign(new Error(code), {
    ...(Number.isSafeInteger(requiredBytes) && requiredBytes! >= 0 ? { requiredBytes } : {}),
    ...(Number.isSafeInteger(availableBytes) && availableBytes! >= 0 ? { availableBytes } : {}),
  });
}
function outputLimit(requiredBytes?: number, availableBytes?: number): Error {
  return limitError("journey_film_output_limit", requiredBytes, availableBytes);
}
function unavailable(cause?: unknown, requiredBytes?: number, availableBytes?: number): Error {
  return Object.assign(new Error("journey_film_storage_unavailable", { cause }), {
    ...(Number.isSafeInteger(requiredBytes) && requiredBytes! >= 0 ? { requiredBytes } : {}),
    ...(Number.isSafeInteger(availableBytes) && availableBytes! >= 0 ? { availableBytes } : {}),
  });
}
function downloadsPending(requiredBytes: number, availableBytes: number, exportCount: number): Error {
  return Object.assign(limitError("journey_film_downloads_pending", requiredBytes, Math.max(0, availableBytes)), {
    exportCount, exportLimit: FILM_STORAGE_MAX_EXPORTS,
  });
}
function isMissing(error: unknown): boolean { return error instanceof DOMException && error.name === "NotFoundError"; }

async function writeRecord(directory: FileSystemDirectoryHandle, name: string, value: object): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try { await writable.write(JSON.stringify(value)); await writable.close(); }
  catch (error) { await writable.abort().catch(() => {}); throw error; }
}

async function readRecord(directory: FileSystemDirectoryHandle, name: string): Promise<{ present: boolean; value: unknown }> {
  let file: File;
  try { file = await (await directory.getFileHandle(name)).getFile(); }
  catch (error) { if (isMissing(error)) return { present: false, value: null }; throw error; }
  if (file.size > 256) return { present: true, value: null };
  try { return { present: true, value: JSON.parse(await file.text()) as unknown }; }
  catch { return { present: true, value: null }; }
}

function recordBytes(value: unknown, key: "bytes" | "byteLimit"): number {
  if (value && typeof value === "object" && "version" in value && value.version === 1 && key in value) {
    const bytes = (value as Record<string, unknown>)[key];
    if (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= FILM_UNKNOWN_STORAGE_OUTPUT_BYTES) return bytes;
  }
  // Corruption must not cause retained downloads to be silently deleted or under-counted.
  return FILM_UNKNOWN_STORAGE_OUTPUT_BYTES;
}

type RegistryEntry = { retained: boolean; bytes: number };
async function scanRegistry(
  directory: FileSystemDirectoryHandle,
  locks: LockManager,
  mode: "read" | "reclaim" | "clear-retained",
): Promise<RegistryEntry[]> {
  const entries: RegistryEntry[] = [];
  const iterable = directory as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
  for await (const handle of iterable.values()) {
    if (handle.kind !== "directory" || !exportName.test(handle.name)) continue;
    await locks.request(leaseName(handle.name), { mode: "exclusive", ifAvailable: true }, async (lease) => {
      const child = await directory.getDirectoryHandle(handle.name);
      const retained = await readRecord(child, "retained.json");
      if (lease && ((mode === "reclaim" && !retained.present) || (mode === "clear-retained" && retained.present))) {
        await directory.removeEntry(handle.name, { recursive: true });
        return;
      }
      const reservation = retained.present ? retained : await readRecord(child, "reservation.json");
      let bytes = recordBytes(reservation.value, retained.present ? "bytes" : "byteLimit");
      if (retained.present) {
        try {
          const file = await (await child.getFileHandle("film.mp4")).getFile();
          // A stale/damaged marker must not under-count the actual retained file.
          bytes = Math.max(bytes, Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : FILM_UNKNOWN_STORAGE_OUTPUT_BYTES);
        } catch (error) { if (!isMissing(error)) throw error; }
      }
      entries.push({ retained: retained.present, bytes });
    });
  }
  return entries;
}

function retainedSummary(entries: RegistryEntry[]): JourneyFilmDownloadSummary {
  return entries.reduce((summary, entry) => entry.retained
    ? { count: summary.count + 1, bytes: summary.bytes + entry.bytes } : summary, { count: 0, bytes: 0 });
}

async function inspectRetained(clear: boolean): Promise<JourneyFilmDownloadSummary> {
  const storage = globalThis.navigator?.storage;
  const locks = globalThis.navigator?.locks;
  if (!storage?.getDirectory || !locks?.request) return { count: 0, bytes: 0 };
  return locks.request(REGISTRY_LOCK, { mode: "exclusive" }, async () => {
    const root = await storage.getDirectory();
    let directory: FileSystemDirectoryHandle;
    try { directory = await root.getDirectoryHandle(TEMP_DIRECTORY); }
    catch (error) { if (isMissing(error)) return { count: 0, bytes: 0 }; throw error; }
    return retainedSummary(await scanRegistry(directory, locks, clear ? "clear-retained" : "read"));
  });
}

export function listRetainedJourneyFilmDownloads(): Promise<JourneyFilmDownloadSummary> { return inspectRetained(false); }
/** Only call after the user confirms all downloads have finished. Active export leases are always skipped. */
export function clearRetainedJourneyFilmDownloads(): Promise<JourneyFilmDownloadSummary> { return inspectRetained(true); }

async function acquireLease(locks: LockManager, id: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  const request = locks.request(leaseName(id), { mode: "exclusive" }, async () => { acquired(); await held; });
  void request.catch(failed);
  await ready;
  return async () => { release(); await request; };
}

interface DiskReservation {
  directory: FileSystemDirectoryHandle;
  maxBytes: number;
  retain(bytes: number): Promise<void>;
  dispose(retained: boolean): Promise<void>;
}

async function reserveDisk(
  root: FileSystemDirectoryHandle,
  locks: LockManager,
  expectedBytes: number,
  wantedLimit: number,
  signal: AbortSignal,
): Promise<DiskReservation> {
  const id = crypto.randomUUID();
  const release = await acquireLease(locks, id);
  const owned: { directory: FileSystemDirectoryHandle | null; created: boolean } = { directory: null, created: false };
  try {
    return await locks.request(REGISTRY_LOCK, { mode: "exclusive", signal }, async () => {
      signal.throwIfAborted();
      const directory = await root.getDirectoryHandle(TEMP_DIRECTORY, { create: true });
      owned.directory = directory;
      const entries = await scanRegistry(directory, locks, "reclaim");
      const occupied = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      const remaining = FILM_UNKNOWN_STORAGE_OUTPUT_BYTES - occupied;
      if (entries.length >= FILM_STORAGE_MAX_EXPORTS || expectedBytes > remaining) throw downloadsPending(expectedBytes, remaining, entries.length);
      const maxBytes = Math.min(wantedLimit, remaining);
      const child = await directory.getDirectoryHandle(id, { create: true });
      owned.created = true;
      await writeRecord(child, "reservation.json", { version: 1, byteLimit: maxBytes });
      signal.throwIfAborted();
      const ownerDirectory = directory;
      return {
        directory: child,
        maxBytes,
        retain: async (bytes) => {
          await locks.request(REGISTRY_LOCK, { mode: "exclusive" }, () =>
            writeRecord(child, "retained.json", { version: 1, bytes }));
        },
        dispose: async (retained) => {
          try {
            if (!retained) await locks.request(REGISTRY_LOCK, { mode: "exclusive" }, async () => {
              try { await ownerDirectory.removeEntry(id, { recursive: true }); }
              catch (error) { if (!isMissing(error)) throw error; }
            });
          } finally { await release(); }
        },
      };
    });
  } catch (error) {
    try {
      if (owned.directory && owned.created) {
        const ownerDirectory = owned.directory;
        await locks.request(REGISTRY_LOCK, { mode: "exclusive" }, () => ownerDirectory.removeEntry(id, { recursive: true }));
      }
    } finally { await release(); }
    throw error;
  }
}

function checkedEnd(chunk: StreamTargetChunk, maxBytes: number): number {
  const end = chunk.position + chunk.data.byteLength;
  if (!Number.isSafeInteger(chunk.position) || chunk.position < 0 || !Number.isSafeInteger(end) || end > maxBytes) {
    throw outputLimit(end, maxBytes);
  }
  return end;
}

function memoryStorage(signal: AbortSignal, onWrite?: (writtenBytes: number) => void): JourneyFilmStorage {
  const pages = new Map<number, Uint8Array<ArrayBuffer>>();
  let length = 0;
  let closed = false;
  let disposed = false;
  let result: Blob | null = null;
  let disposal: Promise<void> | null = null;
  let controller: WritableStreamDefaultController;
  const check = () => {
    signal.throwIfAborted();
    if (disposed) throw unavailable();
  };
  const writable = new WritableStream<StreamTargetChunk>({
    start(value) { controller = value; },
    write(chunk) {
      check();
      const end = checkedEnd(chunk, FILM_MEMORY_OUTPUT_BYTES);
      for (let source = 0; source < chunk.data.byteLength;) {
        const position = chunk.position + source;
        const pageIndex = Math.floor(position / FILM_STORAGE_CHUNK_BYTES);
        const offset = position % FILM_STORAGE_CHUNK_BYTES;
        const count = Math.min(chunk.data.byteLength - source, FILM_STORAGE_CHUNK_BYTES - offset);
        let page = pages.get(pageIndex);
        if (!page) { page = new Uint8Array(FILM_STORAGE_CHUNK_BYTES); pages.set(pageIndex, page); }
        page.set(chunk.data.subarray(source, source + count), offset);
        source += count;
      }
      length = Math.max(length, end);
      onWrite?.(length);
    },
    close() { closed = true; },
  });
  const abort = () => { void dispose(); };
  const dispose = (): Promise<void> => {
    disposal ??= Promise.resolve().then(() => { pages.clear(); result = null; });
    disposed = true;
    controller.error(signal.aborted ? signal.reason : unavailable());
    signal.removeEventListener("abort", abort);
    return disposal;
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    target: new StreamTarget(writable, { chunked: true, chunkSize: FILM_STORAGE_CHUNK_BYTES }),
    storageMode: "memory",
    byteLimit: FILM_MEMORY_OUTPUT_BYTES,
    async finish() {
      check();
      if (!closed || !length) throw new Error("journey_film_output_invalid");
      if (!result) {
        const parts: Uint8Array<ArrayBuffer>[] = [];
        for (let position = 0; position < length; position += FILM_STORAGE_CHUNK_BYTES) {
          const page = pages.get(position / FILM_STORAGE_CHUNK_BYTES) ?? new Uint8Array(FILM_STORAGE_CHUNK_BYTES);
          parts.push(page.subarray(0, Math.min(FILM_STORAGE_CHUNK_BYTES, length - position)));
        }
        result = new Blob(parts, { type: "video/mp4" });
        pages.clear();
      }
      // Ownership transfers to the artifact; an old run's timeout must not delete it later.
      signal.removeEventListener("abort", abort);
      return result;
    },
    async retainForDownload() {
      if (disposed || !result) throw new Error("journey_film_output_invalid");
      // The immutable Blob owns its bytes; it has no OPFS backing file to retain.
    },
    dispose,
  };
}

function diskStorage(
  reservation: DiskReservation,
  file: FileSystemFileHandle,
  writable: FileSystemWritableFileStream,
  signal: AbortSignal,
  onWrite?: (writtenBytes: number) => void,
): JourneyFilmStorage {
  const maxBytes = reservation.maxBytes;
  const writer = writable.getWriter();
  void writer.closed.catch(() => {});
  let length = 0;
  let closed = false;
  let disposed = false;
  let result: Blob | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();
  let disposal: Promise<void> | null = null;
  let retaining: Promise<void> | null = null;
  let retained = false;
  let controller: WritableStreamDefaultController;
  const check = () => {
    signal.throwIfAborted();
    if (disposed) throw unavailable();
  };
  const stream = new WritableStream<StreamTargetChunk>({
    start(value) { controller = value; },
    async write(chunk) {
      check();
      const end = checkedEnd(chunk, maxBytes);
      inFlight = writer.write(chunk);
      await inFlight;
      length = Math.max(length, end);
      onWrite?.(length);
    },
    async close() {
      check();
      inFlight = writer.close();
      await inFlight;
      closed = true;
    },
  });
  // Mediabunny closes its target on cancel, too. Only this private staging file is exposed to it.
  const abort = () => { void dispose().catch(() => {}); };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    result = null;
    signal.removeEventListener("abort", abort);
    const reason = signal.aborted ? signal.reason : unavailable();
    // Error the muxer's stream immediately, including while Output is already finalizing.
    // Its cancel() is not sufficient in that state. Physical operations still drain below.
    controller.error(reason);
    const aborted = closed ? Promise.resolve() : writer.abort(reason).catch(() => {});
    disposal = (async () => {
      // Future queued writes fail check(); finish the current physical operation before unlinking.
      await inFlight.catch(() => {});
      await aborted;
      writer.releaseLock();
      await retaining?.catch(() => {});
      await reservation.dispose(retained);
    })();
    return disposal;
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    target: new StreamTarget(stream, { chunked: true, chunkSize: FILM_STORAGE_CHUNK_BYTES }),
    storageMode: "disk",
    byteLimit: maxBytes,
    async finish() {
      check();
      if (!closed || !length) throw new Error("journey_film_output_invalid");
      if (!result) {
        const diskFile = await file.getFile();
        check();
        if (diskFile.size !== length || diskFile.size > maxBytes) throw new Error("journey_film_output_invalid");
        // slice changes the MIME type without reading the complete movie into a JS ArrayBuffer.
        result = diskFile.slice(0, diskFile.size, "video/mp4");
      }
      signal.removeEventListener("abort", abort);
      return result;
    },
    retainForDownload() {
      if (disposed || !result) return Promise.reject(new Error("journey_film_output_invalid"));
      retaining ??= reservation.retain(result.size).then(() => { retained = true; });
      return retaining;
    },
    dispose,
  };
}

/** Bounded private staging. No upload, filename/title persistence, or deletion of other runs' files. */
export async function createJourneyFilmStorage(
  expectedOutputBytes: number,
  signal: AbortSignal,
  onWrite?: (writtenBytes: number) => void,
): Promise<JourneyFilmStorage> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(expectedOutputBytes) || expectedOutputBytes <= 0) throw outputLimit();
  const storage = globalThis.navigator?.storage;
  const locks = globalThis.navigator?.locks;
  const fallback = (cause?: unknown): JourneyFilmStorage => {
    signal.throwIfAborted();
    if (expectedOutputBytes > FILM_MEMORY_OUTPUT_BYTES) throw unavailable(cause, expectedOutputBytes, FILM_MEMORY_OUTPUT_BYTES);
    return memoryStorage(signal, onWrite);
  };
  if (!storage?.getDirectory || !locks?.request) return fallback();
  let available = FILM_UNKNOWN_STORAGE_OUTPUT_BYTES;
  try {
    const estimate = await storage.estimate();
    if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)
      && estimate.quota! >= 0 && estimate.usage! >= 0) {
      // Leave half the reported remaining quota for swap files and unrelated origin activity.
      available = Math.max(0, Math.min(FILM_UNKNOWN_STORAGE_OUTPUT_BYTES, Math.floor((estimate.quota! - estimate.usage!) / 2)));
    }
  } catch { /* An unavailable estimate is not an unavailable OPFS; use the explicit bounded ceiling. */ }
  signal.throwIfAborted();
  if (expectedOutputBytes > available) {
    if (expectedOutputBytes <= FILM_MEMORY_OUTPUT_BYTES) return memoryStorage(signal, onWrite);
    throw outputLimit(expectedOutputBytes, available);
  }
  const allowance = Math.max(8 * MIB, Math.ceil(expectedOutputBytes / 4));
  const maxBytes = Math.floor(Math.min(available, expectedOutputBytes + allowance, Number.MAX_SAFE_INTEGER));
  let reservation: DiskReservation | null = null;
  let file: FileSystemFileHandle | null = null;
  let writable: FileSystemWritableFileStream | null = null;
  try {
    const root = await storage.getDirectory();
    signal.throwIfAborted();
    reservation = await reserveDisk(root, locks, expectedOutputBytes, maxBytes, signal);
    file = await reservation.directory.getFileHandle("film.mp4", { create: true });
    signal.throwIfAborted();
    writable = await file.createWritable();
    signal.throwIfAborted();
    return diskStorage(reservation, file, writable, signal, onWrite);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (reservation) await reservation.dispose(false);
    if (error instanceof Error && error.message === "journey_film_downloads_pending") throw error;
    return fallback(error);
  }
}
