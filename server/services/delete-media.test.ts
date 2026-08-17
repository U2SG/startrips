import { describe, expect, it, vi } from "vitest";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  deleteMediaAssetForAtlas,
  type DeleteMediaDependencies,
} from "./delete-media";

type Asset = NonNullable<
  Awaited<ReturnType<DeleteMediaDependencies["findAsset"]>>
>;

const ASSET: Asset = {
  id: "00000000-0000-4000-8000-000000000001",
  journeyId: "00000000-0000-4000-8000-000000000002",
  routePointId: null,
  storageDriver: "primary-media-v1",
  storageKey: "atlas/journey/object.jpg",
  fileName: "memory.jpg",
  mimeType: "image/jpeg",
  bytes: 16,
  sortOrder: 0,
  uploadedByUserId: "user-1",
  createdAt: new Date("2026-08-12T00:00:00.000Z"),
};

function dependencies(asset: Asset | undefined) {
  const storage: MultipartStorage = {
    driver: "primary-media-v1",
    async startMultipartUpload() {
      return { providerUploadId: "unused" };
    },
    async signUploadPart() {
      return { url: "https://unused", expiresAt: new Date() };
    },
    async completeMultipartUpload() {},
    async abortMultipartUpload() {},
    deleteObject: vi.fn(async () => undefined),
    async inspectObject() {
      return { exists: true, bytes: 16 };
    },
    async createPrivateReadUrl() {
      return { url: "https://unused", expiresAt: new Date() };
    },
  };
  return {
    storage,
    deps: {
      findAsset: vi.fn<DeleteMediaDependencies["findAsset"]>(
        async () => asset,
      ),
      storageForBackend: vi.fn<DeleteMediaDependencies["storageForBackend"]>(
        () => storage,
      ),
      deleteRow: vi.fn<DeleteMediaDependencies["deleteRow"]>(
        async () => undefined,
      ),
    } satisfies DeleteMediaDependencies,
  };
}

describe("deleteMediaAssetForAtlas", () => {
  it("deletes the stored object and the row for an asset in the atlas", async () => {
    const { storage, deps } = dependencies(ASSET);

    const deleted = await deleteMediaAssetForAtlas(ASSET.id, "atlas-1", deps);

    expect(deleted).toBe(true);
    expect(deps.storageForBackend).toHaveBeenCalledWith("primary-media-v1");
    expect(storage.deleteObject).toHaveBeenCalledWith({
      key: "atlas/journey/object.jpg",
    });
    expect(deps.deleteRow).toHaveBeenCalledWith(ASSET.id);
  });

  it("returns false and touches nothing when the asset is not found", async () => {
    const { storage, deps } = dependencies(undefined);

    const deleted = await deleteMediaAssetForAtlas(
      "00000000-0000-4000-8000-000000000099",
      "atlas-1",
      deps,
    );

    expect(deleted).toBe(false);
    expect(deps.storageForBackend).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(deps.deleteRow).not.toHaveBeenCalled();
  });

  it("keeps the row when object deletion fails so the client can retry", async () => {
    const { storage, deps } = dependencies(ASSET);
    storage.deleteObject = vi.fn(async () => {
      throw new Error("object storage is down");
    });

    await expect(deleteMediaAssetForAtlas(ASSET.id, "atlas-1", deps))
      .rejects.toThrow("object storage is down");
    expect(deps.deleteRow).not.toHaveBeenCalled();
  });
});
