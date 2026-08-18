import { describe, expect, it, vi } from "vitest";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  reconcileUploadCandidates,
  type ReconciliationDependencies,
  type UploadRecord,
} from "./uploads";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const CUTOFF = new Date("2026-08-13T12:00:00.000Z");

function upload(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    atlasId: "00000000-0000-4000-8000-000000000002",
    journeyId: "00000000-0000-4000-8000-000000000003",
    routePointId: null,
    mediaAssetId: null,
    storageDriver: "primary-media-v1",
    storageKey: "atlas/journey/object",
    providerUploadId: "provider-upload-1",
    fileName: "memory.jpg",
    mimeType: "image/jpeg",
    bytes: 16,
    contentHash: null,
    partSize: 8,
    partCount: 2,
    status: "initiated",
    completionAttemptId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-08-12T00:00:00.000Z"),
    updatedAt: new Date("2026-08-12T00:00:00.000Z"),
    ...overrides,
  };
}

function storageWithInspection(
  inspection: { exists: false } | { exists: true; bytes: number },
) {
  const storage: MultipartStorage = {
    driver: "primary-media-v1",
    async startMultipartUpload() {
      return { providerUploadId: "unused" };
    },
    async signUploadPart() {
      return { url: "https://unused", expiresAt: NOW };
    },
    async completeMultipartUpload() {},
    abortMultipartUpload: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    inspectObject: vi.fn(async () => inspection),
    async createPrivateReadUrl() {
      return { url: "https://unused", expiresAt: NOW };
    },
  };
  return storage;
}

function dependencies(storage: MultipartStorage) {
  return {
    claim: vi.fn<ReconciliationDependencies["claim"]>(
      async (candidate): Promise<UploadRecord | undefined> => ({
        ...candidate,
        status: "reconciling",
      }),
    ),
    storageForBackend: vi.fn<ReconciliationDependencies["storageForBackend"]>(
      () => storage,
    ),
    finalize: vi.fn<ReconciliationDependencies["finalize"]>(
      async () => undefined,
    ),
    markAborted: vi.fn<ReconciliationDependencies["markAborted"]>(
      async () => undefined,
    ),
    markRetryable: vi.fn<ReconciliationDependencies["markRetryable"]>(
      async () => undefined,
    ),
    onError: vi.fn<ReconciliationDependencies["onError"]>(),
  } satisfies ReconciliationDependencies;
}

describe("stale multipart reconciliation", () => {
  it("does not claim an upload refreshed after the cutoff", async () => {
    const storage = storageWithInspection({ exists: false });
    const deps = dependencies(storage);
    deps.claim.mockImplementation(async (candidate) =>
      candidate.updatedAt < CUTOFF
        ? { ...candidate, status: "reconciling" }
        : undefined);

    await reconcileUploadCandidates([
      upload({ updatedAt: new Date("2026-08-14T11:59:00.000Z") }),
    ], NOW, CUTOFF, deps);

    expect(deps.storageForBackend).not.toHaveBeenCalled();
    expect(deps.markAborted).not.toHaveBeenCalled();
  });

  it("finalizes a completed object with the declared size", async () => {
    const storage = storageWithInspection({ exists: true, bytes: 16 });
    const deps = dependencies(storage);

    await reconcileUploadCandidates([upload()], NOW, CUTOFF, deps);

    expect(deps.finalize).toHaveBeenCalledOnce();
    expect(deps.markAborted).not.toHaveBeenCalled();
  });

  it("deletes and aborts the record for a wrong-size object", async () => {
    const storage = storageWithInspection({ exists: true, bytes: 17 });
    const deps = dependencies(storage);

    await reconcileUploadCandidates([upload()], NOW, CUTOFF, deps);

    expect(storage.deleteObject).toHaveBeenCalledWith({
      key: "atlas/journey/object",
    });
    expect(deps.markAborted).toHaveBeenCalledOnce();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("aborts a missing incomplete multipart upload", async () => {
    const storage = storageWithInspection({ exists: false });
    const deps = dependencies(storage);

    await reconcileUploadCandidates([upload()], NOW, CUTOFF, deps);

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith({
      key: "atlas/journey/object",
      providerUploadId: "provider-upload-1",
    });
    expect(deps.markAborted).toHaveBeenCalledOnce();
  });

  it("keeps an unknown backend retryable and continues the batch", async () => {
    const storage = storageWithInspection({ exists: false });
    const deps = dependencies(storage);
    deps.storageForBackend.mockImplementation((backendId) => {
      if (backendId === "old-backend") throw new Error("not configured");
      return storage;
    });

    await reconcileUploadCandidates([
      upload({ id: "00000000-0000-4000-8000-000000000004", storageDriver: "old-backend" }),
      upload({ id: "00000000-0000-4000-8000-000000000005" }),
    ], NOW, CUTOFF, deps);

    expect(deps.markRetryable).toHaveBeenCalledOnce();
    expect(storage.abortMultipartUpload).toHaveBeenCalledOnce();
    expect(deps.markAborted).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent claim of the same candidate", async () => {
    const storage = storageWithInspection({ exists: false });
    const deps = dependencies(storage);
    let claimed = false;
    deps.claim.mockImplementation(async (candidate) => {
      if (claimed) return undefined;
      claimed = true;
      return { ...candidate, status: "reconciling" };
    });
    const candidate = upload();

    await Promise.all([
      reconcileUploadCandidates([candidate], NOW, CUTOFF, deps),
      reconcileUploadCandidates([candidate], NOW, CUTOFF, deps),
    ]);

    expect(storage.abortMultipartUpload).toHaveBeenCalledOnce();
    expect(deps.markAborted).toHaveBeenCalledOnce();
  });

  it("leaves a lost finalization lease in a retryable state", async () => {
    const storage = storageWithInspection({ exists: true, bytes: 16 });
    const deps = dependencies(storage);
    deps.finalize.mockRejectedValue(new Error("Upload completion lease was lost"));

    await reconcileUploadCandidates([upload()], NOW, CUTOFF, deps);

    expect(deps.markRetryable).toHaveBeenCalledOnce();
    expect(deps.markAborted).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
