import { describe, expect, it } from "vitest";
import {
  BOOK_OVERLAY_NOTE_LIMIT,
  journeyBookPageRoutePointId,
  journeyBookPages,
  journeyBookStartPage,
  type JourneyBookPage,
} from "./journeyBookPages";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

const base: Journey = {
  id: "journey-1",
  atlasId: "atlas-1",
  title: "Across the island",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "",
  lightColor: "#f4ce73",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [],
  media: [],
};

function point(id: string, note: string | null = null): RoutePoint {
  return {
    id,
    journeyId: base.id,
    sortOrder: 0,
    latitude: 0,
    longitude: 0,
    label: id,
    isStop: true,
    occurredAt: null,
    note,
    createdAt: base.createdAt,
  };
}

function asset(id: string, routePointId: string | null, sortOrder: number, mimeType = "image/jpeg"): JourneyMediaAsset {
  return {
    id,
    journeyId: base.id,
    routePointId,
    storageDriver: "test",
    storageKey: `journey-1/${id}`,
    fileName: `${id}.bin`,
    mimeType,
    bytes: 128,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: base.createdAt,
  };
}

function shape(pages: readonly JourneyBookPage[]): string[] {
  return pages.map((page) => {
    if (page.kind === "media") return `media:${page.asset.id}${page.note ? "+note" : ""}`;
    if (page.kind === "note") return `note:${page.routePoint?.id ?? "journey"}`;
    return page.kind;
  });
}

describe("journeyBookPages", () => {
  it("keeps a note-only Route Point between its neighbours in both reading directions", () => {
    const journey: Journey = {
      ...base,
      routePoints: [point("a"), point("b", "只有一句感想"), point("c")],
      media: [asset("photo-a", "a", 0), asset("video-c", "c", 0, "video/mp4")],
    };
    const pages = shape(journeyBookPages(journey));
    expect(pages).toEqual(["cover", "media:photo-a", "note:b", "media:video-c", "blank", "end"]);
    const reversed = [...pages].reverse();
    expect(reversed.indexOf("note:b")).toBeGreaterThan(reversed.indexOf("media:video-c"));
    expect(reversed.indexOf("note:b")).toBeLessThan(reversed.indexOf("media:photo-a"));
  });

  it("gives no page to a point with neither note nor media", () => {
    const journey: Journey = {
      ...base,
      routePoints: [point("a"), point("pass-through"), point("c", "  ")],
      media: [asset("photo-a", "a", 0)],
    };
    expect(shape(journeyBookPages(journey))).toEqual(["cover", "media:photo-a", "blank", "end"]);
  });

  it("lays a short note over the first picture of its point only", () => {
    const journey: Journey = {
      ...base,
      routePoints: [point("a", "海风很大")],
      media: [asset("second", "a", 1), asset("first", "a", 0)],
    };
    expect(shape(journeyBookPages(journey))).toEqual(["cover", "media:first+note", "media:second", "end"]);
  });

  it("gives a long note its own page before the point's pictures", () => {
    const long = "长".repeat(BOOK_OVERLAY_NOTE_LIMIT + 1);
    const journey: Journey = {
      ...base,
      routePoints: [point("a", long)],
      media: [asset("photo", "a", 0)],
    };
    const pages = journeyBookPages(journey);
    expect(shape(pages)).toEqual(["cover", "note:a", "media:photo", "end"]);
    expect(pages[1]).toMatchObject({ kind: "note", note: long });
  });

  it("gives a note its own page when its point opens with a video", () => {
    const journey: Journey = {
      ...base,
      routePoints: [point("a", "风很大")],
      media: [asset("clip", "a", 0, "video/mp4"), asset("photo", "a", 1)],
    };
    expect(shape(journeyBookPages(journey))).toEqual(["cover", "note:a", "media:clip", "media:photo", "blank", "end"]);
  });

  it("puts the Journey note on the first page and Journey-level media before the route", () => {
    const journey: Journey = {
      ...base,
      note: "整段旅程的感想",
      coverMediaAssetId: "photo-a",
      routePoints: [point("a")],
      media: [asset("photo-a", "a", 0), asset("intro", null, 0)],
    };
    const pages = journeyBookPages(journey);
    expect(shape(pages)).toEqual(["cover", "note:journey", "media:intro", "media:photo-a", "blank", "end"]);
    // #555: the cover is a presentation copy; the asset keeps its own page.
    expect(pages[0]).toMatchObject({ kind: "cover", asset: { id: "photo-a" } });
    expect(pages[0]).not.toHaveProperty("note");
    expect(pages[1]).toMatchObject({ kind: "note", routePoint: null, note: "整段旅程的感想" });
  });

  it("never pages a soundtrack", () => {
    const journey: Journey = {
      ...base,
      routePoints: [point("a")],
      media: [asset("photo", "a", 0), asset("song", null, 0, "audio/mpeg")],
    };
    expect(shape(journeyBookPages(journey))).toEqual(["cover", "media:photo", "blank", "end"]);
  });
});

describe("journeyBookStartPage", () => {
  const journey: Journey = {
    ...base,
    routePoints: [point("a"), point("b", "感想")],
    media: [asset("photo-a", "a", 0), asset("photo-a2", "a", 1)],
  };
  const pages = journeyBookPages(journey);

  it("opens at the asset, then the point, then the cover", () => {
    expect(journeyBookStartPage(pages, { assetId: "photo-a2" })).toBe(2);
    expect(journeyBookStartPage(pages, { routePointId: "b" })).toBe(3);
    expect(journeyBookStartPage(pages, { routePointId: "missing" })).toBe(0);
  });

  it("reports the Route Point a page belongs to", () => {
    expect(journeyBookPageRoutePointId(pages[3])).toBe("b");
    expect(journeyBookPageRoutePointId(pages[0])).toBeNull();
  });
});
