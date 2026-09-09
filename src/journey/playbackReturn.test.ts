import { describe, expect, it } from "vitest";
import type { Journey } from "./types";
import { capturePlaybackEntry, resolvePlaybackReturn } from "./playbackReturn";

const journey: Journey = {
  id: "journey-a",
  atlasId: "atlas-a",
  title: "Journey A",
  startedOn: "2026-01-01",
  endedOn: null,
  note: "",
  lightColor: "#fff",
  revision: 1,
  createdByUserId: "user-a",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  routePoints: [
    { id: "point-a", journeyId: "journey-a", sortOrder: 0, latitude: 1, longitude: 2, label: "A", isStop: true, occurredAt: null, createdAt: "2026-01-01T00:00:00Z" },
    { id: "point-d", journeyId: "journey-a", sortOrder: 1, latitude: 3, longitude: 4, label: "D", isStop: true, occurredAt: null, createdAt: "2026-01-01T00:00:00Z" },
  ],
  media: [
    { id: "asset-a", journeyId: "journey-a", routePointId: "point-a", storageDriver: "s3", storageKey: "a", fileName: "a.jpg", mimeType: "image/jpeg", bytes: 1, sortOrder: 0, uploadedByUserId: "user-a", createdAt: "2026-01-01T00:00:00Z" },
    { id: "asset-d", journeyId: "journey-a", routePointId: "point-d", storageDriver: "s3", storageKey: "d", fileName: "d.jpg", mimeType: "image/jpeg", bytes: 1, sortOrder: 1, uploadedByUserId: "user-a", createdAt: "2026-01-01T00:00:00Z" },
  ],
};

const entry = capturePlaybackEntry({
  journeyId: journey.id,
  routePointId: "point-d",
  assetId: "asset-d",
  intentRevision: 7,
  source: "story",
  storySnapState: "expanded",
});

describe("playback return handoff", () => {
  it("captures a detached logical entry without mutating the input", () => {
    const input = { ...entry };
    const captured = capturePlaybackEntry(input);
    expect(captured).toEqual(input);
    expect(captured).not.toBe(input);
    expect(input).toEqual(entry);
  });

  it("returns the last committed media position and keeps its current ownership", () => {
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: { journeyId: journey.id, routePointId: "point-d", assetId: "asset-d" },
      reason: "exited",
      currentIntentRevision: 7,
      journeys: [journey],
    })).toMatchObject({
      surface: "story",
      reason: "exited",
      fallbackReason: "none",
      journeyId: journey.id,
      routePointId: "point-d",
      assetId: "asset-d",
    });
  });

  it("uses the current Story observation when playback has not committed a more specific place", () => {
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: { journeyId: journey.id, routePointId: null, assetId: null },
      reason: "exited",
      currentIntentRevision: 7,
      journeys: [journey],
    })).toMatchObject({ routePointId: "point-d", assetId: "asset-d" });
  });

  it("degrades a deleted asset to its still-valid Route Point", () => {
    const withoutAsset = { ...journey, media: journey.media.filter((asset) => asset.id !== "asset-d") };
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: { journeyId: journey.id, routePointId: "point-d", assetId: "asset-d" },
      reason: "exited",
      currentIntentRevision: 7,
      journeys: [withoutAsset],
    })).toMatchObject({
      surface: "story",
      routePointId: "point-d",
      assetId: null,
      fallbackReason: "asset-unavailable",
    });
  });

  it("follows a moved asset to its current Route Point", () => {
    const moved = {
      ...journey,
      media: journey.media.map((asset) => asset.id === "asset-d" ? { ...asset, routePointId: "point-a" } : asset),
    };
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: { journeyId: journey.id, routePointId: "point-d", assetId: "asset-d" },
      reason: "exited",
      currentIntentRevision: 7,
      journeys: [moved],
    })).toMatchObject({ routePointId: "point-a", assetId: "asset-d", fallbackReason: "none" });
  });

  it("degrades a missing Route Point to whole-Journey Story context", () => {
    const withoutPoint = {
      ...journey,
      routePoints: journey.routePoints.filter((point) => point.id !== "point-d"),
      media: journey.media.filter((asset) => asset.id !== "asset-d"),
    };
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: { journeyId: journey.id, routePointId: "point-d", assetId: "asset-d" },
      reason: "exited",
      currentIntentRevision: 7,
      journeys: [withoutPoint],
    })).toMatchObject({
      surface: "story",
      routePointId: null,
      assetId: null,
      fallbackReason: "route-point-unavailable",
    });
  });

  it("degrades an unavailable Journey to Atlas with a typed reason", () => {
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: null,
      reason: "exited",
      currentIntentRevision: 7,
      journeys: [],
    })).toEqual({
      surface: "atlas",
      reason: "exited",
      fallbackReason: "journey-unavailable",
      journeyId: null,
      routePointId: null,
      assetId: null,
      storySnapState: "closed",
    });
  });

  it("drops a stale exit instead of overriding a newer intent", () => {
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: null,
      reason: "exited",
      currentIntentRevision: 8,
      journeys: [journey],
    })).toBeNull();
  });

  it("keeps completion at Atlas with the same Journey selected", () => {
    expect(resolvePlaybackReturn({
      entry,
      committedPosition: { journeyId: journey.id, routePointId: "point-d", assetId: "asset-d" },
      reason: "completed",
      currentIntentRevision: 7,
      journeys: [journey],
    })).toEqual({
      surface: "atlas",
      reason: "completed",
      fallbackReason: "none",
      journeyId: journey.id,
      routePointId: null,
      assetId: null,
      storySnapState: "closed",
    });
  });
});
