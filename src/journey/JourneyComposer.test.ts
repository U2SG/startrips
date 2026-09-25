import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  JourneyComposer,
  JourneyMediaContinuationError,
  persistJourneyDraft,
  reconcileUnknownJourneyCreate,
} from "./JourneyComposer";
import { uploadJourneyMedia } from "./journeyMediaUpload";
import { COMPACT_MOBILE_MEDIA_QUERY } from "./mobileLayout";
import { journeyToDraftPoints, type RouteDraftPoint } from "./routeDraft";
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
    expect(markup).toContain("先保存这段 Journey");
    expect(markup).not.toContain("导入这份 GPX");
  });

  it("renders the #375 mobile-primary task surface under the compact query", () => {
    // `useCompactMobileLayout` seeds from `matchMedia` in its state initializer,
    // so a stub is enough to render the real compact surface here; no DOM
    // environment is introduced for one test.
    const previous = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query === COMPACT_MOBILE_MEDIA_QUERY,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof globalThis.matchMedia;
    try {
      const markup = renderToStaticMarkup(createElement(JourneyComposer, {
        open: true,
        journey: undefined,
        onClose: () => undefined,
        onSaved: () => undefined,
        onGlobePickRequest: () => undefined,
      }));

      // Primary: title, add/search, the Route Point list and the sticky save.
      expect(markup).toContain('data-composer-task="primary"');
      expect(markup).toContain('data-composer-scroll-owner="editor"');
      expect(markup).toContain("journey-title-field");
      expect(markup).toContain("journey-location-search");
      expect(markup).toContain("journey-route-draft");
      expect(markup).toContain("保存到星球");

      // Secondary and More capabilities are entered, never shown inline.
      expect(markup).toContain('data-composer-task-entry="journey-info"');
      expect(markup).toContain('data-composer-task-entry="media"');
      expect(markup).toContain("journey-composer__task-more");
      expect(markup).not.toContain('type="date"');
      expect(markup).not.toContain("journey-light-colors");
      expect(markup).not.toContain("journey-precise-location");
      expect(markup).not.toContain("journey-media-picker");

      // The archive-style section numbering is desktop chrome: numbering a
      // sequence the person no longer sees is worse than not numbering it.
      expect(markup).not.toContain("01 · MEMORY");
      expect(markup).not.toContain("02 · JOURNEY");
      expect(markup).not.toContain("03 · TRACE");
      expect(markup).toContain("在地图上留下它");
    } finally {
      if (previous) globalThis.matchMedia = previous;
      else delete (globalThis as { matchMedia?: unknown }).matchMedia;
    }
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

  it("keeps a confirmed server Journey authoritative when media assignment fails after create", async () => {
    const file = { name: "point.jpg", size: 10, type: "image/jpeg" } as File;
    const persist = vi.fn(async () => journey);
    const routePoints = [{
      draftId: "draft-point",
      latitude: 31.2304,
      longitude: 121.4737,
      label: "Shanghai",
      isStop: true,
      occurredAt: null,
    }] satisfies RouteDraftPoint[];

    let failure: unknown;
    try {
      await persistJourneyDraft({
        input,
        mediaFiles: [{ file, routePointDraftId: "draft-point" }],
        routePoints,
        persist,
      });
    } catch (error) {
      failure = error;
    }

    expect(persist).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(JourneyMediaContinuationError);
    expect(failure).toMatchObject({
      journey: { id: "journey-1" },
      message: expect.stringContaining("媒体归属无法确认"),
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
    expect(markup).toContain('data-route-point-draft-id="saved-route-point-1"');
    expect(markup).toContain('data-route-point-expanded="false"');
    expect(markup).toContain(">Shenzhen</strong>");
    expect(markup).toContain("1 个已有媒体");
    expect(markup).toContain("保存修改");
    expect(markup).toContain("记录轨迹");
    expect(markup).toContain("导入这份 GPX");
    expect(markup).not.toContain("先保存这段 Journey");
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
  it("keeps an unverifiable single canonical match confirmation-only", async () => {
    const recoveredJourney = {
      id: "server-created-id",
      atlasId: "atlas-1",
      title: input.title,
      startedOn: input.startedOn,
      endedOn: input.endedOn,
      note: input.note,
      lightColor: input.lightColor,
      lightEffect: null,
      revision: 1,
      createdByUserId: "user-1",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      routePoints: [{
        id: "server-point-id",
        journeyId: "server-created-id",
        sortOrder: 0,
        latitude: 31.2304,
        longitude: 121.4737,
        label: "Shanghai",
        isStop: true,
        occurredAt: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      }],
      media: [],
    } as Journey;
    const readJourneys = vi.fn(async () => [recoveredJourney]);

    await expect(reconcileUnknownJourneyCreate(input, readJourneys)).resolves.toEqual({
      status: "confirmation-required",
      matchingJourneyId: "server-created-id",
    });
    expect(readJourneys).toHaveBeenCalledTimes(1);
  });

  it("marks an unknown create explicitly not saved so one resubmission is permitted", async () => {
    const readJourneys = vi.fn(async () => [] as Journey[]);

    await expect(reconcileUnknownJourneyCreate(input, readJourneys)).resolves.toEqual({
      status: "not-persisted",
    });
    expect(readJourneys).toHaveBeenCalledTimes(1);
  });

  it("keeps repeated reconciliation failures exit-safe without reopening create ownership", async () => {
    const readJourneys = vi.fn(async () => {
      throw new Error("journey list unavailable");
    });
    const knownJourneyIdsBeforeCreate = new Set(["known-before-attempt"]);

    await expect(
      reconcileUnknownJourneyCreate(input, readJourneys, knownJourneyIdsBeforeCreate),
    ).rejects.toThrow("journey list unavailable");
    await expect(
      reconcileUnknownJourneyCreate(input, readJourneys, knownJourneyIdsBeforeCreate),
    ).rejects.toThrow("journey list unavailable");

    const onSaved = vi.fn();
    const pendingAttempt = {
      input,
      knownJourneyIdsBeforeCreate: [...knownJourneyIdsBeforeCreate],
      mode: "recheck" as const,
    };
    const markup = renderToStaticMarkup(createElement(JourneyComposer, {
      open: true,
      initialUnknownCreateAttempt: pendingAttempt,
      onClose: () => undefined,
      onSaved,
    }));
    const closeButton = markup.match(/<button[^>]*aria-label="关闭创建器"[^>]*>/)?.[0];

    expect(readJourneys).toHaveBeenCalledTimes(2);
    expect(closeButton).toBeDefined();
    expect(closeButton).not.toContain("disabled");
    expect(markup).toContain("重新确认保存结果");
    expect(markup).not.toContain(">保存到星球<");
    expect(markup).toContain('value="Night train"');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("reopens an unresolved create in reconciliation mode instead of a blind create", () => {
    const pendingAttempt = {
      input,
      knownJourneyIdsBeforeCreate: ["known-before-attempt"],
      mode: "recheck" as const,
    };
    const renderReopened = () => renderToStaticMarkup(createElement(JourneyComposer, {
      open: true,
      initialUnknownCreateAttempt: pendingAttempt,
      onClose: () => undefined,
      onSaved: () => undefined,
    }));

    const firstReopen = renderReopened();
    const secondReopen = renderReopened();
    for (const markup of [firstReopen, secondReopen]) {
      expect(markup).toContain("重新确认保存结果");
      expect(markup).not.toContain(">保存到星球<");
      expect(markup).toContain('value="Night train"');
    }
  });

  it("preserves pending media while blocking concurrent-writer adoption and continuation", async () => {
    const file = { name: "memory.jpg", size: 10, type: "image/jpeg", lastModified: 1 } as File;
    const recoveryRoutePoints = [{
      draftId: "draft-shanghai",
      latitude: 31.2304,
      longitude: 121.4737,
      label: "Shanghai",
      isStop: true,
      occurredAt: null,
    }] satisfies RouteDraftPoint[];
    const pendingAttempt = {
      input,
      knownJourneyIdsBeforeCreate: ["known-before-attempt"],
      mode: "recheck" as const,
      routePoints: recoveryRoutePoints,
      mediaFiles: [{ file, routePointDraftId: "draft-shanghai" }],
    };

    const otherWriterJourney = {
      id: "other-session-id",
      atlasId: "atlas-1",
      title: input.title,
      startedOn: input.startedOn,
      endedOn: input.endedOn,
      note: input.note,
      lightColor: input.lightColor,
      lightEffect: null,
      revision: 1,
      createdByUserId: "other-session-user",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      routePoints: [{
        id: "other-session-point",
        journeyId: "other-session-id",
        sortOrder: 0,
        latitude: 31.2304,
        longitude: 121.4737,
        label: "Shanghai",
        isStop: true,
        occurredAt: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      }],
      media: [],
    } as Journey;
    const readJourneys = vi.fn(async () => [otherWriterJourney]);
    const recovery = await reconcileUnknownJourneyCreate(
      pendingAttempt.input,
      readJourneys,
      new Set(pendingAttempt.knownJourneyIdsBeforeCreate),
    );

    expect(recovery).toEqual({
      status: "confirmation-required",
      matchingJourneyId: "other-session-id",
    });

    const createAgain = vi.fn();
    const upload = vi.fn();
    const onSaved = vi.fn();
    const confirmationAttempt = {
      ...pendingAttempt,
      mode: "confirmation-required" as const,
    };
    const reopened = renderToStaticMarkup(createElement(JourneyComposer, {
      open: true,
      initialUnknownCreateAttempt: confirmationAttempt,
      onClose: () => undefined,
      onSaved,
    }));
    expect(readJourneys).toHaveBeenCalledTimes(1);
    expect(reopened).toContain("memory.jpg");
    expect(reopened).toContain("没有能证明它属于这次保存请求的服务端尝试标识");
    expect(reopened).toContain("不会自动采用它、上传媒体或触发抵达焦点");
    expect(reopened).toContain("请关闭后核对 Atlas");
    expect(reopened).not.toContain(">保存到星球<");
    expect(reopened).toContain('disabled=""');
    expect(createAgain).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

});

describe("place search Journey context", () => {
  it("biases the composer search towards the last Route Point of the current draft only", () => {
    // #546: node-only suite, so the wiring is asserted on the source. The
    // helper itself (last point, none for an empty Route) is unit-tested in
    // routeDraft.test.ts.
    const composer = readFileSync(new URL("./JourneyComposer.tsx", import.meta.url), "utf8");
    expect(composer).toMatch(
      /searchLocations\(query, fetch, \{\s*focus: routeDraftSearchFocus\(routePointsRef\.current\),\s*\}\)/,
    );
    expect(composer.match(/routeDraftSearchFocus\(/g)).toHaveLength(1);

    // Itinerary import stays focus-free until it has a confirmed Route Point.
    const itineraryImport = readFileSync(new URL("./ItineraryImportPanel.tsx", import.meta.url), "utf8");
    expect(itineraryImport).toMatch(/searchLocations\(/);
    expect(itineraryImport).not.toMatch(/focus/);
  });
});
