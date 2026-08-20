import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { db } from "../db/client";
import { atlases, journeys, mediaAssets, mediaUploads } from "../db/app-schema";
import type { MultipartStorage } from "../storage/multipart-storage";
import { getMultipartStorage } from "../storage/storage-registry";

export type DeleteAtlasDependencies = {
  findAtlas: (
    organizationId: string,
  ) => Promise<typeof atlases.$inferSelect | undefined>;
  listJourneys: (atlasId: string) => Promise<Array<{ id: string }>>;
  listStorageRefs: (journeyId: string) => Promise<{
    media: Array<{ storageDriver: string; storageKey: string }>;
    uploads: Array<{
      storageDriver: string;
      storageKey: string;
      providerUploadId: string;
    }>;
  }>;
  storageForBackend: (backendId: string) => MultipartStorage;
  deleteAtlasRow: (atlasId: string) => Promise<void>;
  markAtlasDeleting?: (atlasId: string) => Promise<boolean>;
  clearAtlasDeleting?: (atlasId: string) => Promise<void>;
};

const defaultDependencies: DeleteAtlasDependencies = {
  async findAtlas(organizationId) {
    const [atlas] = await db
      .select()
      .from(atlases)
      .where(eq(atlases.organizationId, organizationId))
      .limit(1);
    return atlas;
  },
  async listJourneys(atlasId) {
    return db
      .select({ id: journeys.id })
      .from(journeys)
      .where(eq(journeys.atlasId, atlasId));
  },
  async listStorageRefs(journeyId) {
    const [media, uploads] = await Promise.all([
      db
        .select({
          storageDriver: mediaAssets.storageDriver,
          storageKey: mediaAssets.storageKey,
        })
        .from(mediaAssets)
        .where(eq(mediaAssets.journeyId, journeyId)),
      db
        .select({
          storageDriver: mediaUploads.storageDriver,
          storageKey: mediaUploads.storageKey,
          providerUploadId: mediaUploads.providerUploadId,
        })
        .from(mediaUploads)
        .where(and(
          eq(mediaUploads.journeyId, journeyId),
          notInArray(mediaUploads.status, ["completed", "aborted"]),
        )),
    ]);
    return { media, uploads };
  },
  storageForBackend: getMultipartStorage,
  async deleteAtlasRow(atlasId) {
    await db.delete(atlases).where(eq(atlases.id, atlasId));
  },
  async markAtlasDeleting(atlasId) {
    const [marked] = await db
      .update(atlases)
      .set({ deletionStartedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(atlases.id, atlasId), isNull(atlases.deletionStartedAt)))
      .returning({ id: atlases.id });
    return Boolean(marked);
  },
  async clearAtlasDeleting(atlasId) {
    await db
      .update(atlases)
      .set({ deletionStartedAt: null, updatedAt: new Date() })
      .where(and(eq(atlases.id, atlasId), isNotNull(atlases.deletionStartedAt)));
  },
};

function storageReference(storageDriver: string, storageKey: string) {
  return `${storageDriver}\0${storageKey}`;
}

export async function deleteAtlasForOrganization(
  organizationId: string,
  dependencies: DeleteAtlasDependencies = defaultDependencies,
) {
  const atlas = await dependencies.findAtlas(organizationId);
  if (!atlas) return false;
  if (dependencies.markAtlasDeleting && !await dependencies.markAtlasDeleting(atlas.id)) {
    return false;
  }

  try {
    for (const journey of await dependencies.listJourneys(atlas.id)) {
      const refs = await dependencies.listStorageRefs(journey.id);
      const deletedObjects = new Set<string>();
      for (const asset of refs.media) {
        const reference = storageReference(asset.storageDriver, asset.storageKey);
        if (deletedObjects.has(reference)) continue;
        await dependencies.storageForBackend(asset.storageDriver).deleteObject({
          key: asset.storageKey,
        });
        deletedObjects.add(reference);
      }
      for (const upload of refs.uploads) {
        const reference = storageReference(upload.storageDriver, upload.storageKey);
        if (deletedObjects.has(reference)) continue;
        const storage = dependencies.storageForBackend(upload.storageDriver);
        const inspected = await storage.inspectObject({ key: upload.storageKey });
        if (inspected.exists) {
          await storage.deleteObject({ key: upload.storageKey });
        } else {
          await storage.abortMultipartUpload({
            key: upload.storageKey,
            providerUploadId: upload.providerUploadId,
          });
        }
        deletedObjects.add(reference);
      }
    }

    // The atlas row delete cascades to journeys, route points, media assets,
    // and upload rows. The Better Auth organization remains for re-bootstrap.
    await dependencies.deleteAtlasRow(atlas.id);
    return true;
  } catch (error) {
    // A storage failure must leave the atlas retryable; writes remain blocked
    // only for the duration of this cleanup attempt.
    await dependencies.clearAtlasDeleting?.(atlas.id);
    throw error;
  }
}
