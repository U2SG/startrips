import type { PrivateMediaRead } from "./types";

export type MediaPreviewLayerRead = Pick<PrivateMediaRead, "url" | "preview">;

export type MediaPreviewLayer = {
  assetId: string;
  kind: "preview" | "original";
  url: string;
  frame: { width: number; height: number } | null;
};

/**
 * One asset owns both layers. The explicit readAssetId closes the only hole a
 * caller could otherwise create: reusing another asset's warm preview as a
 * generic placeholder while the requested original is still loading.
 */
export function mediaPreviewLayer(input: {
  assetId: string;
  readAssetId: string;
  read: MediaPreviewLayerRead;
  originalReady: boolean;
}): MediaPreviewLayer | null {
  if (input.assetId !== input.readAssetId) return null;
  if (!input.originalReady && input.read.preview) {
    return {
      assetId: input.assetId,
      kind: "preview",
      url: input.read.preview.url,
      frame: { width: input.read.preview.width, height: input.read.preview.height },
    };
  }
  return {
    assetId: input.assetId,
    kind: "original",
    url: input.read.url,
    frame: input.read.preview
      ? { width: input.read.preview.width, height: input.read.preview.height }
      : null,
  };
}

/** Same-asset prefetch order: preview first, then the authoritative original. */
export function mediaPreviewPrefetchUrls(
  assetId: string,
  readAssetId: string,
  read: MediaPreviewLayerRead,
): string[] {
  if (assetId !== readAssetId) return [];
  return read.preview ? [read.preview.url, read.url] : [read.url];
}
