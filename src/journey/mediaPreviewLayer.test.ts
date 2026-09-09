import { describe, expect, it } from "vitest";
import type { PrivateMediaRead } from "./types";
import { mediaPreviewLayer, mediaPreviewPrefetchUrls } from "./mediaPreviewLayer";

const READ: PrivateMediaRead = {
  url: "https://media.example/original",
  expiresAt: "2026-09-10T04:00:00.000Z",
  preview: {
    url: "https://media.example/preview",
    expiresAt: "2026-09-10T04:00:00.000Z",
    mimeType: "image/jpeg",
    width: 960,
    height: 540,
  },
};

describe("mediaPreviewLayer (#264)", () => {
  it("uses this asset's preview as the initial base layer and reports its frame", () => {
    expect(mediaPreviewLayer({ assetId: "asset-a", readAssetId: "asset-a", read: READ, originalReady: false })).toEqual({
      assetId: "asset-a",
      kind: "preview",
      url: READ.preview!.url,
      frame: { width: 960, height: 540 },
    });
  });

  it("replaces the preview in place with the same asset's original", () => {
    expect(mediaPreviewLayer({ assetId: "asset-a", readAssetId: "asset-a", read: READ, originalReady: true })).toEqual({
      assetId: "asset-a",
      kind: "original",
      url: READ.url,
      frame: { width: 960, height: 540 },
    });
  });

  it("never substitutes a different asset's warm preview", () => {
    expect(mediaPreviewLayer({ assetId: "asset-a", readAssetId: "asset-b", read: READ, originalReady: false })).toBeNull();
    expect(mediaPreviewPrefetchUrls("asset-a", "asset-b", READ)).toEqual([]);
  });

  it("prefetches the same asset preview before its original", () => {
    expect(mediaPreviewPrefetchUrls("asset-a", "asset-a", READ)).toEqual([READ.preview!.url, READ.url]);
  });
});
