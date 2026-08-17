import { describe, expect, it, vi } from "vitest";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  deleteAtlasForOrganization,
  type DeleteAtlasDependencies,
} from "./delete-atlas";

type Atlas = NonNullable<
  Awaited<ReturnType<DeleteAtlasDependencies["findAtlas"]>>
>;

const ATLAS: Atlas = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "org-1",
  title: "Shared Atlas",
  dedication: "",
  createdAt: new Date("2026-08-12T00:00:00.000Z"),
  updatedAt: new Date("2026-08-12T00:00:00.000Z"),
};

function storageWith(uploadExists: boolean) {
  const inspection: { exists: false } | { exists: true; bytes: number } =
    uploadExists ? { exists: true, bytes: 16 } : { exists: false };
  const storage: MultipartStorage = {
    driver: "primary-media-v1",
    async startMultipartUpload() {
      return { providerUploadId: "unused" };
    },
    async signUploadPart() {
      return { url: "https://unused", expiresAt: new Date() };
    },
    async completeMultipartUpload() {},
    abortMultipartUpload: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    inspectObject: vi.fn(async () => inspection),
    async createPrivateReadUrl() {
      return { url: "https://unused", expiresAt: new Date() };
    },
  };
  return storage;
}

function dependencies(overrides: Partial<DeleteAtlasDependencies> = {}) {
  const storage = storageWith(false);
  return {
    storage,
    deps: {
      findAtlas: vi.fn<DeleteAtlasDependencies["findAtlas"]>(
        async () => ATLAS,
      ),
      listJourneys: vi.fn<DeleteAtlasDependencies["listJourneys"]>(
        async () => [{ id: "journey-1" }],
      ),
      listStorageRefs: vi.fn<DeleteAtlasDependencies["listStorageRefs"]>(
        async () => ({
          media: [{
            storageDriver: "primary-media-v1",
            storageKey: "atlas/journey/photo.jpg",
          }],
          uploads: [{
            storageDriver: "primary-media-v1",
            storageKey: "atlas/journey/pending.mp4",
            providerUploadId: "provider-upload-1",
          }],
        }),
      ),
      storageForBackend: vi.fn<DeleteAtlasDependencies["storageForBackend"]>(
        () => storage,
      ),
      deleteAtlasRow: vi.fn<DeleteAtlasDependencies["deleteAtlasRow"]>(
        async () => undefined,
      ),
      ...overrides,
    } satisfies DeleteAtlasDependencies,
  };
}

describe("deleteAtlasForOrganization", () => {
  it("deletes stored objects, aborts pending uploads, and removes the row", async () => {
    const { storage, deps } = dependencies();

    const deleted = await deleteAtlasForOrganization("org-1", deps);

    expect(deleted).toBe(true);
    expect(storage.deleteObject).toHaveBeenCalledWith({
      key: "atlas/journey/photo.jpg",
    });
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith({
      key: "atlas/journey/pending.mp4",
      providerUploadId: "provider-upload-1",
    });
    expect(deps.deleteAtlasRow).toHaveBeenCalledWith(ATLAS.id);
  });

  it("deletes a completed object instead of aborting it", async () => {
    const { storage, deps } = dependencies();
    storage.inspectObject = vi.fn(async () => ({ exists: true, bytes: 16 }));

    await deleteAtlasForOrganization("org-1", deps);

    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(storage.deleteObject).toHaveBeenCalledWith({
      key: "atlas/journey/pending.mp4",
    });
  });

  it("returns false and touches nothing when the atlas does not exist", async () => {
    const { storage, deps } = dependencies({
      findAtlas: vi.fn(async () => undefined),
    });

    const deleted = await deleteAtlasForOrganization("org-missing", deps);

    expect(deleted).toBe(false);
    expect(deps.listJourneys).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(deps.deleteAtlasRow).not.toHaveBeenCalled();
  });

  it("keeps every row when storage cleanup fails so deletion can be retried", async () => {
    const { storage, deps } = dependencies();
    storage.deleteObject = vi.fn(async () => {
      throw new Error("object storage is down");
    });

    await expect(deleteAtlasForOrganization("org-1", deps))
      .rejects.toThrow("object storage is down");
    expect(deps.deleteAtlasRow).not.toHaveBeenCalled();
  });

  it("cleans up every journey of the atlas before deleting it", async () => {
    const { storage, deps } = dependencies({
      listJourneys: vi.fn(async () => [{ id: "journey-1" }, { id: "journey-2" }]),
    });

    await deleteAtlasForOrganization("org-1", deps);

    expect(deps.listStorageRefs).toHaveBeenCalledTimes(2);
    expect(deps.listStorageRefs).toHaveBeenCalledWith("journey-2");
    expect(deps.deleteAtlasRow).toHaveBeenCalledWith(ATLAS.id);
  });
});
