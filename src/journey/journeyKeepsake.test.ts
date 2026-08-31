import { describe, expect, it } from "vitest";
import { buildPlaybackSteps } from "./journeyPlayback";
import { buildKeepsakeRenderManifest } from "./journeyKeepsake";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

function point(id: string, sortOrder: number, longitude: number): RoutePoint {
  return {
    id,
    journeyId: "journey-reel",
    sortOrder,
    latitude: 22 + sortOrder * 2,
    longitude,
    label: `Stop ${sortOrder + 1}`,
    isStop: true,
    occurredAt: `2026-08-${String(10 + sortOrder).padStart(2, "0")}T08:00:00.000Z`,
    note: sortOrder === 1 ? "A quiet afternoon by the water." : null,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function media(
  id: string,
  routePointId: string | null,
  mimeType: string,
  sortOrder: number,
): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-reel",
    routePointId,
    storageDriver: "s3",
    storageKey: `private/${id}`,
    fileName: `${id}.bin`,
    mimeType,
    bytes: 1024,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

const journey: Journey = {
  id: "journey-reel",
  atlasId: "atlas-1",
  title: "Three quiet stops",
  startedOn: "2026-08-10",
  endedOn: "2026-08-12",
  note: "",
  lightColor: "#f4ce73",
  revision: 7,
  createdByUserId: "user-1",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  routePoints: [point("p0", 0, 114), point("p1", 1, 121), point("p2", 2, 139)],
  media: [
    media("opening", null, "image/jpeg", 0),
    media("p0-photo", "p0", "image/jpeg", 0),
    media("p0-photo-2", "p0", "image/jpeg", 1),
    media("p1-video", "p1", "video/mp4", 0),
    media("p2-photo", "p2", "image/jpeg", 0),
    media("soundtrack", null, "audio/mpeg", 1),
  ],
};

describe("Journey keepsake render manifest (#87)", () => {
  it("uses the same route-point and media ordering as live Journey Playback", () => {
    const manifest = buildKeepsakeRenderManifest(journey, 30);
    const liveSteps = buildPlaybackSteps(journey);
    const livePointOrder = liveSteps
      .filter((step) => step.kind === "stop")
      .map((step) => step.kind === "stop" ? step.pointIndex : -1);
    const reelPointOrder = manifest.scenes
      .filter((scene) => scene.kind === "map" && scene.role === "arrival")
      .map((scene) => scene.pointIndex);
    expect(reelPointOrder).toEqual(livePointOrder);
    expect(manifest.scenes.filter((scene) => scene.kind === "media")).toEqual([
      expect.objectContaining({ mediaAssetId: "opening", pointIndex: null }),
      expect.objectContaining({ mediaAssetId: "p0-photo", pointIndex: 0 }),
      expect.objectContaining({ mediaAssetId: "p0-photo-2", pointIndex: 0 }),
      expect.objectContaining({ mediaAssetId: "p1-video", pointIndex: 1 }),
      expect.objectContaining({ mediaAssetId: "p2-photo", pointIndex: 2 }),
    ]);
  });

  it("uses map scenes as punctuation, not between adjacent media at one stop", () => {
    const manifest = buildKeepsakeRenderManifest(journey, 30);
    const firstPhoto = manifest.scenes.findIndex(
      (scene) => scene.kind === "media" && scene.mediaAssetId === "p0-photo",
    );
    expect(manifest.scenes[firstPhoto + 1]).toMatchObject({
      kind: "media",
      mediaAssetId: "p0-photo-2",
    });
  });

  it("is portrait-first, private, and never embeds private storage coordinates", () => {
    const manifest = buildKeepsakeRenderManifest(journey, 30);
    expect(manifest.output).toEqual({ width: 1080, height: 1920 });
    expect(manifest.privacy).toEqual({
      artifactVisibility: "private",
      mediaResolution: "authorized-server-fetch",
    });
    expect(manifest.soundtrack.mode).toBe("none");
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("private/opening");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("audio/mpeg");
  });

  it("defines deterministic 15/30/60 pacing without randomly deleting content", () => {
    const manifests = [15, 30, 60].map((preset) => (
      buildKeepsakeRenderManifest(journey, preset as 15 | 30 | 60)
    ));
    const ids = manifests.map((manifest) => manifest.scenes
      .filter((scene) => scene.kind === "media")
      .map((scene) => scene.kind === "media" ? scene.mediaAssetId : ""));
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[1]).toEqual(ids[2]);
    expect(manifests[0].actualDurationMs).toBeGreaterThanOrEqual(15_000);
    expect(manifests[1].actualDurationMs).toBeGreaterThanOrEqual(30_000);
    expect(manifests[2].actualDurationMs).toBeGreaterThanOrEqual(60_000);
    expect(buildKeepsakeRenderManifest(journey, 30)).toEqual(manifests[1]);
  });
});
