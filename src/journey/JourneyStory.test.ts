import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JourneyStory,
  journeyDeleteDescription,
  mediaForRoutePoint,
  replaceJourneySoundtrack,
  storyAssetIndexForId,
  storyAutoplayNextIndex,
  storyChapterMedia,
  shouldHoldWholeJourneyTerminalFrame,
  storyInitialMediaSelection,
  storyMediaNeighborIndex,
  storySelectionContainsRoutePointMedia,
  storyUploadedAssetIndex,
} from "./JourneyStory";
import type { Journey, JourneyMediaAsset } from "./types";

const journey: Journey = {
  id: "journey-1",
  atlasId: "atlas-1",
  title: "Across the island",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "A quiet route home.",
  lightColor: "#f4ce73",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [],
  media: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function asset(
  id: string,
  mimeType: string,
  sortOrder: number,
  fileName = `${id}.bin`,
): JourneyMediaAsset {
  return {
    id,
    journeyId: journey.id,
    routePointId: null,
    storageDriver: "test",
    storageKey: `journey-1/${id}`,
    fileName,
    mimeType,
    bytes: 128,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: journey.createdAt,
  };
}

describe("storyInitialMediaSelection (#18 follow-up)", () => {
  it("opens a Journey card on its explicit cover instead of visualMedia[0]", () => {
    const first = asset("first", "image/jpeg", 0, "first.jpg");
    const cover = asset("cover", "image/jpeg", 1, "cover.jpg");
    const withExplicitCover: Journey = {
      ...journey,
      coverMediaAssetId: cover.id,
      media: [first, cover],
    };

    expect(storyInitialMediaSelection(withExplicitCover, null)).toEqual({
      routePointId: null,
      assetIndex: 1,
      assetId: cover.id,
    });
  });

  it("keeps whole-Journey mode when the explicit cover belongs to a route point", () => {
    const journeyLevel = asset("journey-level", "image/jpeg", 0, "journey.jpg");
    const pointFirst = {
      ...asset("point-first", "image/jpeg", 1, "point-first.jpg"),
      routePointId: "point-1",
    };
    const pointCover = {
      ...asset("point-cover", "image/jpeg", 2, "point-cover.jpg"),
      routePointId: "point-1",
    };
    const withPointCover: Journey = {
      ...journey,
      coverMediaAssetId: pointCover.id,
      routePoints: [{
        id: "point-1",
        journeyId: journey.id,
        sortOrder: 0,
        latitude: 22.5431,
        longitude: 114.0579,
        label: "深圳",
        isStop: true,
        occurredAt: null,
        note: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      }],
      media: [journeyLevel, pointFirst, pointCover],
    };

    expect(storyInitialMediaSelection(withPointCover, null)).toEqual({
      routePointId: null,
      assetIndex: 2,
      assetId: pointCover.id,
    });
    expect(storyInitialMediaSelection(withPointCover, "point-1")).toEqual({
      routePointId: "point-1",
      assetIndex: 0,
      assetId: pointFirst.id,
    });
  });
});



describe("storyMediaNeighborIndex (#76)", () => {
  it("does not wrap the whole-Journey narrative at either end", () => {
    expect(storyMediaNeighborIndex(0, 4, -1, false)).toBeNull();
    expect(storyMediaNeighborIndex(3, 4, 1, false)).toBeNull();
    expect(storyMediaNeighborIndex(1, 4, 1, false)).toBe(2);
  });

  it("preserves the existing wrap behavior for a route-point browse scope", () => {
    expect(storyMediaNeighborIndex(0, 4, -1, true)).toBe(3);
    expect(storyMediaNeighborIndex(3, 4, 1, true)).toBe(0);
  });
});

describe("storyAutoplayNextIndex (#76)", () => {
  it("stops at the end of the whole-Journey narrative", () => {
    expect(storyAutoplayNextIndex(0, 3, true)).toBe(1);
    expect(storyAutoplayNextIndex(2, 3, true)).toBeNull();
    expect(storyAutoplayNextIndex(0, 1, true)).toBeNull();
  });

  it("preserves route-point autoplay looping", () => {
    expect(storyAutoplayNextIndex(0, 3, false)).toBe(1);
    expect(storyAutoplayNextIndex(2, 3, false)).toBe(0);
    expect(storyAutoplayNextIndex(0, 1, false)).toBeNull();
  });
});

describe("shouldHoldWholeJourneyTerminalFrame (#76 review)", () => {
  it("keeps the final whole-Journey frame playing for its terminal interval", () => {
    expect(shouldHoldWholeJourneyTerminalFrame(2, 3, true)).toBe(true);
    expect(shouldHoldWholeJourneyTerminalFrame(0, 1, true)).toBe(true);
  });

  it("does not turn route-point or non-terminal frames into delayed stops", () => {
    expect(shouldHoldWholeJourneyTerminalFrame(1, 3, true)).toBe(false);
    expect(shouldHoldWholeJourneyTerminalFrame(2, 3, false)).toBe(false);
    expect(shouldHoldWholeJourneyTerminalFrame(0, 0, true)).toBe(false);
  });
});

describe("storyUploadedAssetIndex (#76 review)", () => {
  it("selects a deduplicated intro asset instead of the first route-point boundary", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    const pointMedia = {
      ...asset("point", "image/jpeg", 1, "point.jpg"),
      routePointId: "point-1",
    };
    expect(storyUploadedAssetIndex([intro, pointMedia], [intro.id])).toBe(0);
  });

  it("selects the first successful newly uploaded asset by id", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    const added = asset("added", "image/jpeg", 1, "added.jpg");
    const pointMedia = {
      ...asset("point", "image/jpeg", 2, "point.jpg"),
      routePointId: "point-1",
    };
    expect(storyUploadedAssetIndex([intro, added, pointMedia], [added.id])).toBe(1);
  });

  it("returns null when refresh cannot find any successful uploaded asset", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    expect(storyUploadedAssetIndex([intro], ["missing"])).toBeNull();
  });
});

describe("aggregate organizer ownership (#76 review)", () => {
  it("derives arrow-sort neighbors from the active ownership chapter", () => {
    const pointA1 = { ...asset("a1", "image/jpeg", 0), routePointId: "point-a" };
    const pointB = { ...asset("b", "image/jpeg", 1), routePointId: "point-b" };
    const pointA2 = { ...asset("a2", "image/jpeg", 2), routePointId: "point-a" };
    expect(storyChapterMedia([pointA1, pointA2, pointB], pointA1).map((item) => item.id))
      .toEqual(["a1", "a2"]);
  });

  it("offers the journey-level destination when aggregate selection includes chapter media", () => {
    const intro = asset("intro", "image/jpeg", 0);
    const point = { ...asset("point", "image/jpeg", 1), routePointId: "point-a" };
    expect(storySelectionContainsRoutePointMedia([intro, point], new Set([point.id])))
      .toBe(true);
    expect(storySelectionContainsRoutePointMedia([intro, point], new Set([intro.id])))
      .toBe(false);
  });
});

describe("storyAssetIndexForId (#76)", () => {
  it("keeps the settled asset selected when a reassignment changes sequence order", () => {
    const intro = asset("intro", "image/jpeg", 0, "intro.jpg");
    const moved = asset("moved", "image/jpeg", 1, "moved.jpg");
    const other = asset("other", "image/jpeg", 2, "other.jpg");
    expect(storyAssetIndexForId([intro, other, moved], moved.id, 1)).toBe(2);
  });

  it("clamps the numeric fallback when the settled asset disappeared", () => {
    const only = asset("only", "image/jpeg", 0, "only.jpg");
    expect(storyAssetIndexForId([only], "gone", 4)).toBe(0);
  });
});

describe("replaceJourneySoundtrack", () => {
  const file = { name: "night.mp3", size: 64, type: "audio/mpeg" } as File;

  it("uploads and confirms the new track before removing the old one", async () => {
    const calls: string[] = [];
    const previous = asset("old-track", "audio/mpeg", 0, "old.mp3");
    const upload = vi.fn(async () => {
      calls.push("upload");
      return { uploadedCount: 1, mediaErrors: [], assets: [] };
    });
    const refresh = vi.fn(async () => {
      calls.push("refresh");
      return journey;
    });
    const remove = vi.fn(async () => {
      calls.push("remove");
    });

    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: upload as never,
      refresh,
      remove,
    });

    expect(calls).toEqual(["upload", "refresh", "remove", "refresh"]);
    expect(remove).toHaveBeenCalledWith("old-track");
    expect(result).toMatchObject({
      uploaded: true,
      refreshFailed: false,
      cleanupFailed: false,
    });
  });

  it("keeps the track when replacing it with the exact same file", async () => {
    // Soundtracks are always small enough to be content hashed, so the server
    // deduplicates this upload to the asset that is already active.
    const previous = asset("old-track", "audio/mpeg", 0, "night.mp3");
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: (async () => ({
        uploadedCount: 1,
        mediaErrors: [],
        assets: [{
          id: previous.id,
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey-1/old-track",
          fileName: "night.mp3",
          mimeType: "audio/mpeg",
          bytes: 64,
        }],
      })) as never,
      refresh: async () => journey,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uploaded: true,
      unchanged: true,
      cleanupFailed: false,
    });
  });

  it("still replaces when the upload resolves to a different asset", async () => {
    const previous = asset("old-track", "audio/mpeg", 0, "old.mp3");
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: (async () => ({
        uploadedCount: 1,
        mediaErrors: [],
        assets: [{
          id: "new-track",
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey-1/new-track",
          fileName: "night.mp3",
          mimeType: "audio/mpeg",
          bytes: 64,
        }],
      })) as never,
      refresh: async () => journey,
      remove,
    });

    expect(remove).toHaveBeenCalledWith("old-track");
    expect(result).toMatchObject({ uploaded: true, unchanged: false });
  });

  it("keeps the previous track when the new upload fails", async () => {
    const remove = vi.fn();
    const refresh = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: asset("old-track", "audio/mpeg", 0, "old.mp3"),
      upload: (async () => ({
        uploadedCount: 0,
        mediaErrors: [{ fileIndex: 0, fileName: "night.mp3", message: "storage unavailable" }],
        assets: [],
      })) as never,
      refresh,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uploaded: false,
      uploadError: "storage unavailable",
    });
  });

  it("reports a failed cleanup without discarding the new track", async () => {
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: asset("old-track", "audio/mpeg", 0, "old.mp3"),
      upload: (async () => ({ uploadedCount: 1, mediaErrors: [], assets: [] })) as never,
      refresh: async () => journey,
      remove: async () => {
        throw new Error("delete failed");
      },
    });

    expect(result).toMatchObject({ uploaded: true, cleanupFailed: true });
  });

  it("skips removal for a journey that had no soundtrack", async () => {
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: null,
      upload: (async () => ({ uploadedCount: 1, mediaErrors: [], assets: [] })) as never,
      refresh: async () => null,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    // A refresh that returns nothing is reported, not silently swallowed.
    expect(result).toMatchObject({ uploaded: true, refreshFailed: true });
  });
});

describe("JourneyStory", () => {
  it("exposes explicit exit and append-media actions in the story dialog", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="退出旅程故事"');
    expect(markup).toContain(">退出<");
    expect(markup).toContain("添加照片或视频");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("编辑旅程");
    expect(markup).toContain("删除旅程");
    expect(markup).not.toContain("确认删除");
    expect(journeyDeleteDescription(journey)).toBe(
      "先从图谱隐藏；7 天内可撤销，之后才会清理路线和 0 个私有媒体。",
    );
  });

  it("opens a selected route point and scopes its media", () => {
    const pointJourney: Journey = {
      ...journey,
      routePoints: [{
        id: "point-1",
        journeyId: journey.id,
        sortOrder: 0,
        latitude: 22.5431,
        longitude: 114.0579,
        label: "深圳",
        isStop: true,
        occurredAt: null,
        createdAt: journey.createdAt,
      }],
      media: [{
        id: "media-1",
        journeyId: journey.id,
        routePointId: "point-1",
        storageDriver: "test",
        storageKey: "point-1/photo.jpg",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: 128,
        sortOrder: 0,
        uploadedByUserId: "user-1",
        createdAt: journey.createdAt,
      }],
    };

    expect(mediaForRoutePoint(pointJourney, "point-1")).toHaveLength(1);
    expect(mediaForRoutePoint(pointJourney, null)).toHaveLength(0);
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [pointJourney],
      journeyId: pointJourney.id,
      routePointId: "point-1",
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(markup).toContain('data-route-point-id="point-1"');
    expect(markup).toContain("深圳");
    expect(markup).toContain("1 个媒体片段");
    expect(markup).toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain("删除这段媒体？");
  });

  it("hides the media removal control when the scoped media is empty", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain("删除这段媒体？");
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
  });

  it("offers media reordering controls when the journey holds multiple assets", () => {
    const multiMediaJourney: Journey = {
      ...journey,
      media: [
        {
          id: "media-1",
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey/first.jpg",
          fileName: "first.jpg",
          mimeType: "image/jpeg",
          bytes: 128,
          sortOrder: 0,
          uploadedByUserId: "user-1",
          createdAt: journey.createdAt,
        },
        {
          id: "media-2",
          journeyId: journey.id,
          routePointId: null,
          storageDriver: "test",
          storageKey: "journey/second.jpg",
          fileName: "second.jpg",
          mimeType: "image/jpeg",
          bytes: 128,
          sortOrder: 1,
          uploadedByUserId: "user-1",
          createdAt: journey.createdAt,
        },
      ],
    };

    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [multiMediaJourney],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('aria-label="向前调整媒体顺序"');
    expect(markup).toContain('aria-label="向后调整媒体顺序"');
    expect(markup).toContain('aria-label="删除这段媒体"');
    expect(markup).toContain('aria-label="自动播放照片"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('aria-label="全屏查看媒体"');
  });

  it("keeps the mobile media stage gesture-first instead of rendering the desktop toolbar", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const mobileJourney: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0, "first.jpg"),
        asset("media-2", "image/jpeg", 1, "second.jpg"),
      ],
    };

    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [mobileJourney],
      journeyId: mobileJourney.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('data-mobile-layout="true"');
    expect(markup).toContain('data-mobile-mode="viewer"');
    expect(markup).toContain('aria-label="管理旅程"');
    expect(markup).not.toContain('aria-label="管理当前媒体"');
    expect(markup).not.toContain("添加照片或视频");
    expect(markup).not.toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="向后调整媒体顺序"');
    expect(markup).not.toContain('aria-label="自动播放照片"');
    expect(markup).not.toContain("全部照片");
  });

  it("keeps mobile management reachable when the selected media scope is empty", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('data-mobile-mode="viewer"');
    expect(markup).toContain('aria-label="管理旅程"');
    expect(markup).not.toContain("添加照片或视频");
    vi.unstubAllGlobals();
  });

  it("offers a direct-access overview for singleton and multi-media scopes", () => {
    const single = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [asset("media-1", "image/jpeg", 0)] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(single).toContain("全部照片");
    expect(single).toContain('aria-pressed="false"');

    const many: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0),
        asset("media-2", "image/jpeg", 1),
        asset("media-3", "video/mp4", 2),
      ],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [many],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(markup).toContain("全部照片");
    expect(markup).toContain('aria-pressed="false"');
    // The grid itself only appears once the overview is opened.
    expect(markup).not.toContain("journey-story__media-grid");
    expect(markup).toContain("3 个媒体片段");
  });

  it("keeps a soundtrack out of the photo counts and shows it as audio", () => {
    const scored: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0),
        asset("media-2", "image/jpeg", 1),
        asset("track", "audio/mpeg", 2, "night-route.mp3"),
      ],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [scored],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain("JOURNEY SOUNDTRACK");
    // #7: the presentation strips the file extension — the UI shows the
    // friendly name, never `night-route.mp3`.
    expect(markup).toContain("night-route");
    expect(markup).not.toContain("night-route.mp3");
    expect(markup).toContain("替换配乐");
    expect(markup).toContain("移除配乐");
    // Two photos, not three assets.
    expect(markup).toContain("2 个媒体片段");
    // The light strip replaces the native control bar. (The <audio> playback
    // engine only mounts once the signed read resolves at runtime.)
    expect(markup).toContain("journey-story__soundtrack-light");
  });

  it("keeps a soundtrack-only journey silent and free of a broken cover", () => {
    const soundtrackOnly: Journey = {
      ...journey,
      media: [asset("track", "audio/mpeg", 0, "night-route.mp3")],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [soundtrackOnly],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain("整段旅程还没有媒体");
    expect(markup).toContain("night-route");
    expect(markup).not.toContain("night-route.mp3");
    expect(markup).not.toContain("全部照片");
    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
  });

  it("plays the slideshow silently when a journey has no soundtrack", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain("还没有配乐，幻灯片会安静播放");
    expect(markup).toContain("上传配乐");
    expect(markup).not.toContain("<audio");
    expect(markup).not.toContain("移除配乐");
  });

  it("hides permanent deletion when the current member lacks permission", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
  });
});
