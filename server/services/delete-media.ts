import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { journeys, mediaAssets } from "../db/app-schema";
import type { MultipartStorage } from "../storage/multipart-storage";
import { getMultipartStorage } from "../storage/storage-registry";

export type DeleteMediaDependencies = {
  findAsset: (
    assetId: string,
    atlasId: string,
  ) => Promise<typeof mediaAssets.$inferSelect | undefined>;
  storageForBackend: (backendId: string) => MultipartStorage;
  deleteRow: (assetId: string) => Promise<void>;
};

const defaultDependencies: DeleteMediaDependencies = {
  async findAsset(assetId, atlasId) {
    const [row] = await db
      .select({ asset: mediaAssets })
      .from(mediaAssets)
      .innerJoin(journeys, eq(journeys.id, mediaAssets.journeyId))
      .where(and(
        eq(mediaAssets.id, assetId),
        eq(journeys.atlasId, atlasId),
        isNull(journeys.deletionStartedAt),
      ))
      .limit(1);
    return row?.asset;
  },
  storageForBackend: getMultipartStorage,
  async deleteRow(assetId) {
    await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId));
  },
};

export async function deleteMediaAssetForAtlas(
  assetId: string,
  atlasId: string,
  dependencies: DeleteMediaDependencies = defaultDependencies,
) {
  const asset = await dependencies.findAsset(assetId, atlasId);
  if (!asset) return false;
  await dependencies.storageForBackend(asset.storageDriver).deleteObject({
    key: asset.storageKey,
  });
  await dependencies.deleteRow(asset.id);
  return true;
}
