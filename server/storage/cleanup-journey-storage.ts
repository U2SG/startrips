import type { MultipartStorage } from "./multipart-storage";

type StorageReference = {
  storageDriver: string;
  storageKey: string;
};

export type JourneyStorageReferences = {
  media: ReadonlyArray<StorageReference & { previewStorageKey: string | null }>;
  uploads: ReadonlyArray<StorageReference & { providerUploadId: string }>;
};

/** Clean one Journey's objects before its caller removes the owning rows. */
export async function cleanupJourneyStorage(
  refs: JourneyStorageReferences,
  storageForBackend: (backendId: string) => MultipartStorage,
): Promise<void> {
  const deletedObjects = new Set<string>();
  const reference = (backendId: string, key: string) => `${backendId}\0${key}`;

  for (const asset of refs.media) {
    // Preview and original share a backend and a deduplication scope. Keep
    // their order: the owning row must survive until both objects are gone.
    for (const key of [asset.previewStorageKey, asset.storageKey]) {
      if (!key) continue;
      const identity = reference(asset.storageDriver, key);
      if (deletedObjects.has(identity)) continue;
      await storageForBackend(asset.storageDriver).deleteObject({ key });
      deletedObjects.add(identity);
    }
  }

  for (const upload of refs.uploads) {
    const identity = reference(upload.storageDriver, upload.storageKey);
    if (deletedObjects.has(identity)) continue;
    const storage = storageForBackend(upload.storageDriver);
    const inspected = await storage.inspectObject({ key: upload.storageKey });
    if (inspected.exists) {
      await storage.deleteObject({ key: upload.storageKey });
    } else {
      await storage.abortMultipartUpload({
        key: upload.storageKey,
        providerUploadId: upload.providerUploadId,
      });
    }
    deletedObjects.add(identity);
  }
}
