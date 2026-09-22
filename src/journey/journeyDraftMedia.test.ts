import { describe, expect, it } from "vitest";
import {
  clearRemovedMediaTarget,
  composerMediaSummary,
  resolvePendingMediaUploads,
} from "./journeyDraftMedia";
import { moveRoutePoint, type RouteDraftPoint } from "./routeDraft";
import type { Journey, JourneyMediaAsset } from "./types";

const journey = {
  id: "journey-1",
  routePoints: [],
  media: [],
} as unknown as Journey;

describe("composerMediaSummary", () => {
  const media = (id: string, routePointId: string | null, mimeType = "image/jpeg", sortOrder = 0) => ({
    id, routePointId, mimeType, sortOrder, fileName: `${id}.jpg`,
  }) as JourneyMediaAsset;
  const pending = (name: string, routePointDraftId: string | null) => ({
    file: { name, type: "image/jpeg" } as File,
    routePointDraftId,
  });

  it("keeps persisted input order before pending order and excludes the soundtrack", () => {
    const existing = { media: [
      media("model-first", "point-a", "video/mp4", 8),
      media("soundtrack", "point-a", "audio/legacy", 0),
      media("model-second", "point-a", "image/jpeg", 1),
      media("point-b", "point-b"),
      media("whole-journey", null),
    ] };
    const summary = composerMediaSummary(existing, [
      { id: "point-a", draftId: "draft-a" },
      { id: "point-b", draftId: "draft-b" },
      { draftId: "new-point" },
      { draftId: "empty-point" },
    ], [
      pending("pending-a.jpg", "draft-a"),
      pending("pending-b-first.jpg", "draft-b"),
      pending("pending-b-second.jpg", "draft-b"),
      pending("new-first.jpg", "new-point"),
      pending("new-second.jpg", "new-point"),
    ]);

    expect(summary.existingVisualMediaCount).toBe(4);
    expect([...summary.byDraftId]).toEqual([
      ["draft-a", { count: 3, label: "model-first.jpg、model-second.jpg 等 3 个" }],
      ["draft-b", { count: 3, label: "point-b.jpg、pending-b-first.jpg 等 3 个" }],
      ["new-point", { count: 2, label: "new-first.jpg、new-second.jpg" }],
      ["empty-point", { count: 0, label: "暂无媒体归属此地点" }],
    ]);
    expect(existing.media.map((asset) => asset.id)).toEqual([
      "model-first", "soundtrack", "model-second", "point-b", "whole-journey",
    ]);
  });

  it("does not confuse persisted ids with draft ids or adopt deleted-point media", () => {
    const files = [
      pending("correct.jpg", "draft-a"),
      pending("wrong-id.jpg", "point-a"),
      pending("deleted.jpg", "deleted-draft"),
      pending("journey.jpg", null),
    ];
    const existing = { media: [media("saved", "point-a"), media("orphan", "deleted-point")] };
    const points = [{ id: "point-a", draftId: "draft-a" }, { draftId: "new-draft" }];
    const before = composerMediaSummary(existing, points, files);
    expect(before.existingVisualMediaCount).toBe(2);
    expect(before.byDraftId.get("draft-a")).toEqual({ count: 2, label: "saved.jpg、correct.jpg" });
    expect(before.byDraftId.get("new-draft")?.count).toBe(0);
    expect(before.byDraftId.has("deleted-draft")).toBe(false);

    const after = composerMediaSummary(existing, [points[1]], clearRemovedMediaTarget(files, "draft-a"));
    expect([...after.byDraftId]).toEqual([["new-draft", { count: 0, label: "暂无媒体归属此地点" }]]);
    expect(files[0].routePointDraftId).toBe("draft-a");
  });

  it("reflects new files and reassignment without mutating the previous summary", () => {
    const points = [{ draftId: "a" }, { draftId: "b" }];
    const first = composerMediaSummary(undefined, points, [pending("same.jpg", "a")]);
    const next = composerMediaSummary(null, points, [pending("same.jpg", "b"), pending("same.jpg", "b")]);
    expect(first.existingVisualMediaCount).toBe(0);
    expect(first.byDraftId.get("a")).toEqual({ count: 1, label: "same.jpg" });
    expect(next.byDraftId.get("a")?.count).toBe(0);
    expect(next.byDraftId.get("b")).toEqual({ count: 2, label: "same.jpg、same.jpg" });
  });
});

describe("pending draft media ownership", () => {
  it("resolves pending media to retained and newly persisted route points", () => {
    const existingFile = { name: "existing.jpg", size: 10 } as File;
    const newFile = { name: "new.jpg", size: 10 } as File;
    const routePoints = [
      {
        draftId: "new-point",
        latitude: 35.6762,
        longitude: 139.6503,
        label: "Tokyo",
        isStop: true,
        occurredAt: null,
      },
      {
        draftId: "saved-existing-point",
        id: "existing-point",
        latitude: 22.5431,
        longitude: 114.0579,
        label: "Shenzhen",
        isStop: true,
        occurredAt: null,
      },
    ] satisfies RouteDraftPoint[];
    const persisted = {
      ...journey,
      routePoints: [
        { id: "new-persisted-point", sortOrder: 0 },
        { id: "existing-point", sortOrder: 1 },
      ],
    } as Journey;

    expect(resolvePendingMediaUploads([
      { file: existingFile, routePointDraftId: "saved-existing-point" },
      { file: newFile, routePointDraftId: "new-point" },
    ], routePoints, persisted)).toEqual([
      { file: existingFile, routePointId: "existing-point" },
      { file: newFile, routePointId: "new-persisted-point" },
    ]);
  });

  it("keeps pending media bound to the same draftId when that whole record is reordered", () => {
    const file = { name: "record-03.jpg", size: 10 } as File;
    const routePoints = [
      { draftId: "record-01", latitude: 22.5, longitude: 114.0, label: "A", isStop: true, occurredAt: null },
      { draftId: "record-02", latitude: 22.543096, longitude: 114.057865, label: "Shared", isStop: false, occurredAt: null },
      { draftId: "record-03", latitude: 23.1, longitude: 115.1, label: "C", note: "selected", isStop: true, occurredAt: "2026-09-03T08:00:00.000Z" },
      { draftId: "record-07", latitude: 22.543096, longitude: 114.057865, label: "Shared", isStop: true, occurredAt: null },
    ] satisfies RouteDraftPoint[];
    const moved = moveRoutePoint(routePoints, "record-03", -1);
    const persisted = {
      ...journey,
      routePoints: moved.map((point, sortOrder) => ({ id: `persisted-${point.draftId}`, sortOrder })),
    } as Journey;

    expect(moved[1]).toMatchObject({ draftId: "record-03", note: "selected", isStop: true });
    expect(resolvePendingMediaUploads([
      { file, routePointDraftId: "record-03" },
    ], moved, persisted)).toEqual([
      { file, routePointId: "persisted-record-03" },
    ]);
  });

  it("falls media back to the whole journey when its draft point is removed", () => {
    const retainedFile = { name: "retained.jpg", size: 10 } as File;
    const resetFile = { name: "reset.jpg", size: 10 } as File;

    expect(clearRemovedMediaTarget([
      { file: retainedFile, routePointDraftId: "point-a" },
      { file: resetFile, routePointDraftId: "point-b" },
    ], "point-b")).toEqual([
      { file: retainedFile, routePointDraftId: "point-a" },
      { file: resetFile, routePointDraftId: null },
    ]);
  });
});
