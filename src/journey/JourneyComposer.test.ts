import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  clearRemovedMediaTarget,
  JourneyComposer,
  journeyToDraftPoints,
  parseCoordinateInput,
  persistJourneyDraft,
  resolvePendingMediaUploads,
  uploadJourneyMedia,
} from "./JourneyComposer";
import type { RouteDraftPoint } from "./routeDraft";
import type { Journey, JourneyInput } from "./types";

const input: JourneyInput = {
  title: "Night train",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "",
  lightColor: "#f4ce73",
  routePoints: [{
    latitude: 31.2304,
    longitude: 121.4737,
    label: "Shanghai",
    isStop: true,
    occurredAt: null,
  }],
};

const journey = {
  id: "journey-1",
  routePoints: [],
  media: [],
} as unknown as Journey;

describe("persistJourneyDraft", () => {
  it("does not silently turn an empty coordinate into zero", () => {
    expect(parseCoordinateInput("", -90, 90)).toBeNull();
    expect(parseCoordinateInput("   ", -180, 180)).toBeNull();
    expect(parseCoordinateInput("0", -90, 90)).toBe(0);
    expect(parseCoordinateInput("22.543096", -90, 90)).toBe(22.543096);
    expect(parseCoordinateInput("-90", -90, 90)).toBe(-90);
    expect(parseCoordinateInput("180", -180, 180)).toBe(180);
    expect(parseCoordinateInput("90.000001", -90, 90)).toBeNull();
    expect(parseCoordinateInput("-180.000001", -180, 180)).toBeNull();
  });

  it("renders one composer surface with precise coordinates collapsed", () => {
    const markup = renderToStaticMarkup(createElement(JourneyComposer, {
      open: true,
      onClose: () => undefined,
      onSaved: () => undefined,
      onGlobePickRequest: () => undefined,
    }));

    expect(markup).not.toContain("journey-composer__steps");
    expect(markup).toContain("01 · MEMORY");
    expect(markup).toContain("02 · JOURNEY");
    expect(markup).toContain("03 · TRACE");
    expect(markup).toContain('<details class="journey-precise-location">');
    expect(markup).toContain("保存到星球");
  });

  it("creates first, uploads files sequentially with two part workers, and reports progress", async () => {
    const calls: string[] = [];
    const persist = vi.fn(async () => {
      calls.push("create");
      return journey;
    });
    const upload = vi.fn(async (options: Parameters<NonNullable<Parameters<typeof persistJourneyDraft>[0]["upload"]>>[0]) => {
      calls.push(options.fileName);
      expect(options.concurrency).toBe(2);
      options.onProgress?.({ uploadedBytes: options.file.size, totalBytes: options.file.size });
      return {} as Awaited<ReturnType<NonNullable<Parameters<typeof persistJourneyDraft>[0]["upload"]>>>;
    });
    const files = [
      { name: "a.jpg", size: 10, type: "image/jpeg" },
      { name: "b.mp4", size: 20, type: "video/mp4" },
    ] as File[];
    const onProgress = vi.fn();

    const result = await persistJourneyDraft({
      input,
      mediaFiles: files.map((file) => ({ file, routePointDraftId: null })),
      routePoints: [],
      persist,
      upload,
      onProgress,
    });

    expect(calls).toEqual(["create", "a.jpg", "b.mp4"]);
    expect(result).toMatchObject({ journey, uploadedCount: 2, mediaErrors: [] });
    expect(onProgress).toHaveBeenLastCalledWith({
      fileName: "b.mp4",
      uploadedBytes: 30,
      totalBytes: 30,
    });
  });

  it("keeps the saved journey and reports individual media failures", async () => {
    const files = [
      { name: "a.jpg", size: 10, type: "image/jpeg" },
      { name: "b.jpg", size: 10, type: "image/jpeg" },
    ] as File[];
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({});

    const result = await persistJourneyDraft({
      input,
      mediaFiles: files.map((file) => ({ file, routePointDraftId: null })),
      routePoints: [],
      persist: async () => journey,
      upload,
    });

    expect(result.uploadedCount).toBe(1);
    expect(result.mediaErrors).toEqual([{
      fileIndex: 0,
      fileName: "a.jpg",
      message: "storage unavailable",
    }]);
  });

  it("passes route point ownership through each media upload", async () => {
    const file = { name: "point.jpg", size: 10, type: "image/jpeg" } as File;
    type Upload = NonNullable<Parameters<typeof uploadJourneyMedia>[0]["upload"]>;
    const upload = vi.fn<Upload>(async () => ({
      id: "media-1",
      journeyId: "journey-1",
      routePointId: "point-1",
      storageDriver: "test",
      storageKey: "point-1/photo.jpg",
      fileName: "point.jpg",
      mimeType: "image/jpeg",
      bytes: 10,
    }));

    await uploadJourneyMedia({
      journeyId: "journey-1",
      routePointId: "point-1",
      files: [file],
      upload,
    });

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      journeyId: "journey-1",
      routePointId: "point-1",
    }));
  });

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

  it("preserves an existing journey as an editable draft", () => {
    const existing = {
      ...journey,
      title: "Southbound light",
      startedOn: "2026-04-16",
      endedOn: "2026-05-03",
      note: "Across the water",
      lightColor: "#77c8c2",
      routePoints: [{
        id: "route-point-1",
        journeyId: journey.id,
        sortOrder: 0,
        latitude: 22.543096,
        longitude: 114.057865,
        label: "Shenzhen",
        isStop: true,
        occurredAt: null,
        createdAt: "2026-04-16T00:00:00.000Z",
      }],
      media: [{ id: "media-1" }],
    } as Journey;

    expect(journeyToDraftPoints(existing)).toEqual([expect.objectContaining({
      draftId: "saved-route-point-1",
      id: "route-point-1",
      latitude: 22.543096,
      longitude: 114.057865,
      label: "Shenzhen",
      isStop: true,
    })]);

    const markup = renderToStaticMarkup(createElement(JourneyComposer, {
      open: true,
      journey: existing,
      onClose: () => undefined,
      onSaved: () => undefined,
    }));
    expect(markup).toContain('value="Southbound light"');
    expect(markup).toContain('value="2026-04-16"');
    expect(markup).toContain('value="Shenzhen"');
    expect(markup).toContain("1 个已有媒体");
    expect(markup).toContain("保存修改");
  });

  it("counts only photos and videos as existing composer media", () => {
    const scored = {
      ...journey,
      media: [
        { id: "media-1", mimeType: "image/jpeg" },
        { id: "media-2", mimeType: "audio/mpeg" },
      ],
    } as Journey;

    const markup = renderToStaticMarkup(createElement(JourneyComposer, {
      open: true,
      journey: scored,
      onClose: () => undefined,
      onSaved: () => undefined,
    }));

    expect(markup).toContain("1 个已有媒体");
    expect(markup).not.toContain("2 个已有媒体");
  });
});
