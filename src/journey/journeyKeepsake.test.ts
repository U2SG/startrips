import { describe, expect, it } from "vitest";
import { buildPlaybackSteps } from "./journeyPlayback";
import { assertKeepsakeManifestRevision, buildKeepsakeRenderManifest } from "./journeyKeepsake";
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
      expect.objectContaining({ mediaAssetId: "opening", pointIndex: null, routePointId: null }),
      expect.objectContaining({ mediaAssetId: "p0-photo", pointIndex: 0, routePointId: "p0" }),
      expect.objectContaining({ mediaAssetId: "p0-photo-2", pointIndex: 0, routePointId: "p0" }),
      expect.objectContaining({ mediaAssetId: "p1-video", pointIndex: 1, routePointId: "p1" }),
      expect.objectContaining({ mediaAssetId: "p2-photo", pointIndex: 2, routePointId: "p2" }),
    ]);
  });

  it("pins map geography to stable route-point IDs and rejects stale revisions", () => {
    const manifest = buildKeepsakeRenderManifest(journey, 30);
    const arrivals = manifest.scenes.filter(
      (scene) => scene.kind === "map" && scene.role === "arrival",
    );
    expect(arrivals.map((scene) => scene.kind === "map" ? scene.routePointId : null))
      .toEqual(["p0", "p1", "p2"]);
    const travel = manifest.scenes.find(
      (scene) => scene.kind === "map" && scene.role === "travel",
    );
    expect(travel).toMatchObject({
      fromRoutePointId: "p0",
      toRoutePointId: "p1",
      pointIndex: 1,
    });

    const reordered: Journey = {
      ...journey,
      revision: journey.revision + 1,
      routePoints: [journey.routePoints[2], journey.routePoints[0], journey.routePoints[1]],
    };
    expect(() => assertKeepsakeManifestRevision(manifest, reordered))
      .toThrow("keepsake_manifest_revision_mismatch");
    expect(() => assertKeepsakeManifestRevision(manifest, journey)).not.toThrow();
  });

  it("rejects media move, reorder, upload, and deletion even when Journey revision is unchanged", () => {
    const manifest = buildKeepsakeRenderManifest(journey, 30);

    const moved: Journey = {
      ...journey,
      media: journey.media.map((asset) => (
        asset.id === "p1-video" ? { ...asset, routePointId: "p0" } : asset
      )),
    };
    expect(() => assertKeepsakeManifestRevision(manifest, moved))
      .toThrow("keepsake_manifest_narrative_mismatch");

    const reordered: Journey = {
      ...journey,
      media: journey.media.map((asset) => {
        if (asset.id === "p0-photo") return { ...asset, sortOrder: 1 };
        if (asset.id === "p0-photo-2") return { ...asset, sortOrder: 0 };
        return asset;
      }),
    };
    expect(() => assertKeepsakeManifestRevision(manifest, reordered))
      .toThrow("keepsake_manifest_narrative_mismatch");

    const uploaded: Journey = {
      ...journey,
      media: [...journey.media, media("p2-new", "p2", "image/jpeg", 2)],
    };
    expect(() => assertKeepsakeManifestRevision(manifest, uploaded))
      .toThrow("keepsake_manifest_narrative_mismatch");

    const deleted: Journey = {
      ...journey,
      media: journey.media.filter((asset) => asset.id !== "p2-photo"),
    };
    expect(() => assertKeepsakeManifestRevision(manifest, deleted))
      .toThrow("keepsake_manifest_narrative_mismatch");
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

  it("carries the resolver's note and distance sensitivity into the fitted scenes", () => {
    const manifest = buildKeepsakeRenderManifest(journey, 30);
    const arrivals = manifest.scenes.filter(
      (scene) => scene.kind === "map" && scene.role === "arrival",
    );
    // p1 is the only route point with a note, so its arrival must outlast the
    // note-free ones: the resolver's note term survives the preset fit.
    expect(arrivals[1].durationMs).toBeGreaterThan(arrivals[0].durationMs);
    expect(arrivals[1].durationMs).toBeGreaterThan(arrivals[2].durationMs);

    const travels = manifest.scenes.filter(
      (scene) => scene.kind === "map" && scene.role === "travel",
    );
    // p1 -> p2 spans more longitude than p0 -> p1, so the longer leg holds the
    // camera longer instead of both legs collapsing to one travel duration.
    expect(travels[1].durationMs).toBeGreaterThan(travels[0].durationMs);

    const video = manifest.scenes.find(
      (scene) => scene.kind === "media" && scene.mediaType === "video",
    );
    const photo = manifest.scenes.find(
      (scene) => scene.kind === "media" && scene.mediaAssetId === "p2-photo",
    );
    expect(video!.durationMs).toBeGreaterThan(photo!.durationMs);
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
