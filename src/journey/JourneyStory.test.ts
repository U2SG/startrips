import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JourneyStory,
  journeyDeleteDescription,
  mediaForRoutePoint,
  replaceJourneySoundtrack,
  storyInitialMediaSelection,
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

  it("follows a route-point cover into its matching Story media scope", () => {
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
      media: [journeyLevel, pointFirst, pointCover],
    };

    expect(storyInitialMediaSelection(withPointCover, null)).toEqual({
      routePointId: "point-1",
      assetIndex: 1,
      assetId: pointCover.id,
    });
    expect(storyInitialMediaSelection(withPointCover, "point-1")).toEqual({
      routePointId: "point-1",
      assetIndex: 0,
      assetId: pointFirst.id,
    });
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
    expect(markup).toContain('aria-label="管理当前媒体"');
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="向后调整媒体顺序"');
    expect(markup).not.toContain('aria-label="自动播放照片"');
    expect(markup).not.toContain("全部照片");
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
