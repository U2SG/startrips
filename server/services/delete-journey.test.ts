import { describe, expect, it, vi } from "vitest";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  deleteJourneyWithStorage,
  reconcileJourneyDeletionCandidates,
  type DeleteJourneyDependencies,
} from "./delete-journey";

type DeletionCandidate = NonNullable<
  Awaited<ReturnType<DeleteJourneyDependencies["getCandidate"]>>
>;

function candidate(
  overrides: Partial<DeletionCandidate> = {},
): DeletionCandidate {
  return {
    id: "journey-1",
    media: [],
    uploads: [],
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
      return { url: "https://unused", expiresAt: new Date(0) };
    },
    async completeMultipartUpload() {},
    abortMultipartUpload: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    inspectObject: vi.fn(async () => inspection),
    async createPrivateReadUrl() {
      return { url: "https://unused", expiresAt: new Date(0) };
    },
  };
  return storage;
}

function dependencies(
  storage: MultipartStorage,
  deletionCandidate: DeletionCandidate | undefined = candidate(),
) {
  return {
    markForDeletion: vi.fn<DeleteJourneyDependencies["markForDeletion"]>(
      async (journeyId) => ({ id: journeyId }),
    ),
    getCandidate: vi.fn<DeleteJourneyDependencies["getCandidate"]>(
      async () => deletionCandidate,
    ),
    deleteJourney: vi.fn<DeleteJourneyDependencies["deleteJourney"]>(
      async (journeyId) => ({ id: journeyId }),
    ),
    deferRetry: vi.fn<DeleteJourneyDependencies["deferRetry"]>(
      async (journeyId) => ({ id: journeyId }),
    ),
    listPending: vi.fn<DeleteJourneyDependencies["listPending"]>(
      async () => [],
    ),
    storageForBackend: vi.fn<DeleteJourneyDependencies["storageForBackend"]>(
      () => storage,
    ),
    onCleanupError: vi.fn<DeleteJourneyDependencies["onCleanupError"]>(),
  } satisfies DeleteJourneyDependencies;
}

describe("journey deletion storage cleanup", () => {
  it("persists deletion intent without physically deleting during the request", async () => {
    const events: string[] = [];
    const storage = storageWithInspection({ exists: false });
    vi.mocked(storage.deleteObject).mockImplementation(async () => {
      events.push("object");
    });
    const deps = dependencies(storage, candidate({
      media: [{
        storageDriver: "primary-media-v1",
        storageKey: "atlas/journey/photo.jpg",
      }],
    }));
    deps.markForDeletion.mockImplementation(async (journeyId) => {
      events.push("marked");
      return { id: journeyId };
    });
    deps.deleteJourney.mockImplementation(async (journeyId) => {
      events.push("database");
      return { id: journeyId };
    });

    await expect(deleteJourneyWithStorage(
      "journey-1",
      "atlas-1",
      deps,
    )).resolves.toEqual({ id: "journey-1" });

    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(deps.getCandidate).not.toHaveBeenCalled();
    expect(deps.deleteJourney).not.toHaveBeenCalled();
    expect(events).toEqual(["marked"]);
  });

  it("aborts an unfinished multipart upload when no object exists", async () => {
    const storage = storageWithInspection({ exists: false });
    const deps = dependencies(storage, candidate({
      uploads: [{
        storageDriver: "primary-media-v1",
        storageKey: "atlas/journey/video.mp4",
        providerUploadId: "upload-1",
        status: "initiated",
      }],
    }));

    await reconcileJourneyDeletionCandidates(
      [{ id: "journey-1", atlasId: "atlas-1" }],
      deps,
    );

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith({
      key: "atlas/journey/video.mp4",
      providerUploadId: "upload-1",
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("deletes a recovered completion-unknown object", async () => {
    const storage = storageWithInspection({ exists: true, bytes: 42 });
    const deps = dependencies(storage, candidate({
      uploads: [{
        storageDriver: "primary-media-v1",
        storageKey: "atlas/journey/recovered.jpg",
        providerUploadId: "upload-2",
        status: "completion_unknown",
      }],
    }));

    await reconcileJourneyDeletionCandidates(
      [{ id: "journey-1", atlasId: "atlas-1" }],
      deps,
    );

    expect(storage.deleteObject).toHaveBeenCalledWith({
      key: "atlas/journey/recovered.jpg",
    });
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("deduplicates the same completed object across upload records", async () => {
    const storage = storageWithInspection({ exists: true, bytes: 42 });
    const deps = dependencies(storage, candidate({
      media: [{
        storageDriver: "primary-media-v1",
        storageKey: "atlas/journey/shared.jpg",
      }],
      uploads: [{
        storageDriver: "primary-media-v1",
        storageKey: "atlas/journey/shared.jpg",
        providerUploadId: "upload-3",
        status: "completion_unknown",
      }],
    }));

    await reconcileJourneyDeletionCandidates(
      [{ id: "journey-1", atlasId: "atlas-1" }],
      deps,
    );

    expect(storage.deleteObject).toHaveBeenCalledOnce();
    expect(storage.inspectObject).not.toHaveBeenCalled();
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("returns not found without touching storage or the database", async () => {
    const storage = storageWithInspection({ exists: false });
    const deps = dependencies(storage);
    deps.markForDeletion.mockImplementation(async () => undefined);

    await expect(deleteJourneyWithStorage(
      "missing",
      "atlas-1",
      deps,
    )).resolves.toBeUndefined();

    expect(deps.getCandidate).not.toHaveBeenCalled();
    expect(deps.storageForBackend).not.toHaveBeenCalled();
    expect(deps.deleteJourney).not.toHaveBeenCalled();
  });

  it("keeps deletion durable after partial cleanup and succeeds on retry", async () => {
    const storage = storageWithInspection({ exists: false });
    vi.mocked(storage.deleteObject)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const deletionCandidate = candidate({
      media: [
        {
          storageDriver: "primary-media-v1",
          storageKey: "atlas/journey/first.jpg",
        },
        {
          storageDriver: "primary-media-v1",
          storageKey: "atlas/journey/second.jpg",
        },
      ],
    });
    const deps = dependencies(storage, deletionCandidate);

    await expect(deleteJourneyWithStorage(
      "journey-1",
      "atlas-1",
      deps,
    )).resolves.toEqual({ id: "journey-1" });

    await reconcileJourneyDeletionCandidates(
      [{ id: "journey-1", atlasId: "atlas-1" }],
      deps,
    );

    expect(deps.deleteJourney).not.toHaveBeenCalled();
    expect(deps.deferRetry).toHaveBeenCalledWith("journey-1", "atlas-1");
    expect(deps.onCleanupError).toHaveBeenCalledOnce();

    vi.mocked(storage.deleteObject).mockResolvedValue(undefined);
    await reconcileJourneyDeletionCandidates(
      [{ id: "journey-1", atlasId: "atlas-1" }],
      deps,
    );

    expect(deps.deleteJourney).toHaveBeenCalledWith("journey-1", "atlas-1");
  });

  it("continues a reconciliation batch after one journey fails", async () => {
    const storage = storageWithInspection({ exists: false });
    vi.mocked(storage.deleteObject).mockImplementation(async ({ key }) => {
      if (key.includes("first")) throw new Error("provider unavailable");
    });
    const deps = dependencies(storage);
    deps.getCandidate.mockImplementation(async (journeyId) => candidate({
      id: journeyId,
      media: [{
        storageDriver: "primary-media-v1",
        storageKey: `atlas/${journeyId}/photo.jpg`,
      }],
    }));

    await reconcileJourneyDeletionCandidates([
      { id: "first", atlasId: "atlas-1" },
      { id: "second", atlasId: "atlas-1" },
    ], deps);

    expect(deps.onCleanupError).toHaveBeenCalledOnce();
    expect(deps.deferRetry).toHaveBeenCalledWith("first", "atlas-1");
    expect(deps.deleteJourney).toHaveBeenCalledTimes(1);
    expect(deps.deleteJourney).toHaveBeenCalledWith("second", "atlas-1");
  });
});
