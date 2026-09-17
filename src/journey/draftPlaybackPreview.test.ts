import { describe, expect, it } from "vitest";
import type { RouteDraftPoint } from "./routeDraft";
import type { Journey, JourneyInput } from "./types";
import {
  buildDraftPlaybackPreviewSnapshot,
  draftPlaybackPreviewOwnerKey,
  draftPlaybackPreviewStillOwnsComposer,
  NEW_JOURNEY_DRAFT_PLAYBACK_ID,
} from "./draftPlaybackPreview";

const generatedAt = "2026-09-17T03:30:00.000Z";

function sourceJourney(): Journey {
  return {
    id: "journey-1",
    atlasId: "atlas-1",
    title: "Persisted title",
    startedOn: "2026-09-01",
    endedOn: "2026-09-03",
    note: "persisted note",
    lightColor: "#123456",
    lightEffect: null,
    coverMediaAssetId: "asset-removed",
    revision: 7,
    createdByUserId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    routePoints: [
      { id: "point-a", journeyId: "journey-1", sortOrder: 0, latitude: 1, longitude: 2, label: "A", isStop: true, occurredAt: null, note: "A note", createdAt: "2026-09-01T01:00:00.000Z" },
      { id: "point-b", journeyId: "journey-1", sortOrder: 1, latitude: 3, longitude: 4, label: "B", isStop: false, occurredAt: null, note: null, createdAt: "2026-09-01T02:00:00.000Z" },
    ],
    media: [
      { id: "asset-journey", journeyId: "journey-1", routePointId: null, storageDriver: "qa", storageKey: "journey", fileName: "journey.jpg", mimeType: "image/jpeg", bytes: 10, sortOrder: 0, uploadedByUserId: "user-1", createdAt: generatedAt },
      { id: "asset-kept", journeyId: "journey-1", routePointId: "point-a", storageDriver: "qa", storageKey: "kept", fileName: "kept.jpg", mimeType: "image/jpeg", bytes: 10, sortOrder: 1, uploadedByUserId: "user-1", createdAt: generatedAt },
      { id: "asset-removed", journeyId: "journey-1", routePointId: "point-b", storageDriver: "qa", storageKey: "removed", fileName: "removed.jpg", mimeType: "image/jpeg", bytes: 10, sortOrder: 2, uploadedByUserId: "user-1", createdAt: generatedAt },
    ],
  };
}

const input: JourneyInput = {
  title: "Unsaved title",
  startedOn: "2026-09-02",
  endedOn: "2026-09-05",
  note: "Unsaved Journey note",
  lightColor: "#abcdef",
  lightEffect: "aurora",
  revision: 7,
  routePoints: [],
};

describe("draft Playback Preview", () => {
  it("freezes unsaved fields and route order without inventing persistence", () => {
    const points: RouteDraftPoint[] = [
      { draftId: "draft-new", latitude: 9, longitude: 10, label: " New point ", isStop: false, occurredAt: "2026-09-04T03:00:00.000Z", note: "new note" },
      { draftId: "saved-a", id: "point-a", latitude: 1.5, longitude: 2.5, label: " Edited A ", isStop: false, occurredAt: "2026-09-02T03:00:00.000Z", note: "edited A" },
    ];
    const snapshot = buildDraftPlaybackPreviewSnapshot({
      sourceJourney: sourceJourney(),
      input,
      routePoints: points,
      snapshotRevision: 3,
      excludedPendingMediaCount: 2,
      generatedAt,
    });

    expect(snapshot.snapshotRevision).toBe(3);
    expect(snapshot.excludedPendingMediaCount).toBe(2);
    expect(snapshot.journey).toMatchObject({
      id: "journey-1",
      title: "Unsaved title",
      startedOn: "2026-09-02",
      endedOn: "2026-09-05",
      note: "Unsaved Journey note",
      lightColor: "#abcdef",
      lightEffect: "aurora",
      revision: 7,
      coverMediaAssetId: null,
    });
    expect(snapshot.journey.routePoints.map((point) => ({
      id: point.id,
      label: point.label,
      isStop: point.isStop,
      note: point.note,
    }))).toEqual([
      { id: "draft-preview-route-point:draft-new", label: "New point", isStop: false, note: "new note" },
      { id: "point-a", label: "Edited A", isStop: false, note: "edited A" },
    ]);
    expect(snapshot.route.points.map((point) => point.id)).toEqual([
      "draft-preview-route-point:draft-new",
      "point-a",
    ]);
    expect(snapshot.journey.media.map((asset) => asset.id)).toEqual(["asset-journey", "asset-kept"]);
  });

  it("keeps same-coordinate draft records distinct and excludes every local pending file", () => {
    const points: RouteDraftPoint[] = [
      { draftId: "same-1", latitude: 22.543096, longitude: 114.057865, label: "First", isStop: false, occurredAt: null },
      { draftId: "same-2", latitude: 22.543096, longitude: 114.057865, label: "Second", isStop: true, occurredAt: null },
    ];
    const snapshot = buildDraftPlaybackPreviewSnapshot({
      sourceJourney: null,
      input: { ...input, revision: undefined },
      routePoints: points,
      snapshotRevision: 1,
      excludedPendingMediaCount: 4,
      generatedAt,
    });

    expect(snapshot.journey.id).toBe(NEW_JOURNEY_DRAFT_PLAYBACK_ID);
    expect(snapshot.journey.revision).toBe(0);
    expect(snapshot.journey.media).toEqual([]);
    expect(snapshot.journey.routePoints.map((point) => point.id)).toEqual([
      "draft-preview-route-point:same-1",
      "draft-preview-route-point:same-2",
    ]);
    expect(new Set(snapshot.journey.routePoints.map((point) => point.id)).size).toBe(2);
  });

  it("releases a stale preview when the Composer owner changes or closes", () => {
    const preview = buildDraftPlaybackPreviewSnapshot({
      sourceJourney: sourceJourney(),
      input,
      routePoints: [{ draftId: "saved-a", id: "point-a", latitude: 1, longitude: 2, label: "A", isStop: true, occurredAt: null }],
      snapshotRevision: 1,
      excludedPendingMediaCount: 0,
      generatedAt,
    });
    expect(draftPlaybackPreviewOwnerKey("journey-1")).toBe("journey-1");
    expect(draftPlaybackPreviewOwnerKey(null)).toBe(NEW_JOURNEY_DRAFT_PLAYBACK_ID);
    expect(draftPlaybackPreviewStillOwnsComposer(preview, true, "journey-1")).toBe(true);
    expect(draftPlaybackPreviewStillOwnsComposer(preview, false, "journey-1")).toBe(false);
    expect(draftPlaybackPreviewStillOwnsComposer(preview, true, "journey-2")).toBe(false);
  });
});
