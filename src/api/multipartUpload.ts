export type UploadedMediaAsset = {
  id: string;
  journeyId: string;
  routePointId: string | null;
  storageDriver: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  contentHash?: string | null;
};

type Fetcher = typeof fetch;

type MultipartUploadOptions = {
  file: Blob;
  fileName: string;
  journeyId: string;
  routePointId?: string | null;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { uploadedBytes: number; totalBytes: number }) => void;
  fetcher?: Fetcher;
};

type StartedUpload = {
  uploadId: string;
  partSize: number;
  partCount: number;
};

type CompletedPart = {
  partNumber: number;
  etag: string;
};

async function apiJson<T>(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<T> {
  const response = await fetcher(input, {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function abortError() {
  return new DOMException("Upload aborted", "AbortError");
}

async function waitBeforeRetry(attempt: number, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timeout = globalThis.setTimeout(finish, 250 * 3 ** attempt);
    const cancel = () => {
      globalThis.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

// Hashing larger files would buffer them fully in memory; deduplication is
// scoped to photos and short videos where the memory cost is acceptable.
const MAX_HASH_BYTES = 128 * 1024 * 1024;

export async function contentHashOfFile(file: Blob): Promise<string | undefined> {
  if (file.size > MAX_HASH_BYTES) return undefined;
  try {
    const buffer = await file.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

async function waitBeforeCompletionRetry(
  attempt: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw abortError();
  const delay = Math.min(500 * 2 ** attempt, 5_000);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timeout = globalThis.setTimeout(finish, delay);
    const cancel = () => {
      globalThis.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function uploadPart(
  fetcher: Fetcher,
  started: StartedUpload,
  file: Blob,
  partNumber: number,
  signal?: AbortSignal,
): Promise<CompletedPart> {
  const start = (partNumber - 1) * started.partSize;
  const body = file.slice(start, Math.min(start + started.partSize, file.size));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const signed = await apiJson<{
        url: string;
        headers: Record<string, string>;
      }>(
        fetcher,
        `/api/uploads/${started.uploadId}/parts/${partNumber}`,
        { method: "POST", signal },
      );
      const response = await fetcher(signed.url, {
        method: "PUT",
        body,
        headers: signed.headers,
        signal,
      });
      if (!response.ok) throw new Error(`Part ${partNumber} failed (${response.status})`);
      const etag = response.headers.get("etag")?.trim();
      if (!etag) {
        throw new Error("Object storage must expose the ETag response header");
      }
      return { partNumber, etag };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (attempt === 2) throw error;
      await waitBeforeRetry(attempt, signal);
    }
  }

  throw new Error(`Part ${partNumber} failed`);
}

export async function uploadMediaInParts({
  file,
  fileName,
  journeyId,
  routePointId,
  concurrency = 3,
  signal,
  onProgress,
  fetcher = fetch,
}: MultipartUploadOptions): Promise<UploadedMediaAsset> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    throw new Error("Upload concurrency must be between 1 and 6");
  }
  if (signal?.aborted) throw abortError();

  const started = await apiJson<StartedUpload>(fetcher, "/api/uploads/start", {
    method: "POST",
    body: JSON.stringify({
      journeyId,
      routePointId: routePointId ?? null,
      fileName,
      mimeType: file.type,
      bytes: file.size,
      contentHash: await contentHashOfFile(file),
    }),
    signal,
  });

  const completed = new Array<CompletedPart>(started.partCount);
  let nextPart = 1;
  let uploadedBytes = 0;
  const workerAbort = new AbortController();
  const workerSignal = signal
    ? AbortSignal.any([signal, workerAbort.signal])
    : workerAbort.signal;

  async function worker() {
    while (nextPart <= started.partCount) {
      const partNumber = nextPart;
      nextPart += 1;
      const result = await uploadPart(
        fetcher,
        started,
        file,
        partNumber,
        workerSignal,
      );
      completed[partNumber - 1] = result;
      const partStart = (partNumber - 1) * started.partSize;
      uploadedBytes += Math.min(started.partSize, file.size - partStart);
      onProgress?.({ uploadedBytes, totalBytes: file.size });
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, started.partCount) },
    () => worker(),
  );
  try {
    await Promise.all(workers);
  } catch (error) {
    workerAbort.abort();
    await Promise.allSettled(workers);
    await fetcher(`/api/uploads/${started.uploadId}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => undefined);
    throw error;
  }

  let completionError: unknown;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try {
      const result = await apiJson<{ asset: UploadedMediaAsset }>(
        fetcher,
        `/api/uploads/${started.uploadId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ parts: completed }),
          signal,
        },
      );
      return result.asset;
    } catch (error) {
      completionError = error;
      if (signal?.aborted) throw abortError();
      if (attempt < 8) await waitBeforeCompletionRetry(attempt, signal);
    }
  }

  // Completion can be ambiguous after a network timeout. Preserve the server
  // upload record for idempotent retry or reconciliation instead of aborting it.
  throw completionError;
}
