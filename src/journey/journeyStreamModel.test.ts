import { describe, expect, it } from "vitest";
import {
  journeyStreamEntries,
  journeyStreamLayout,
  streamAspect,
  streamDate,
  streamPictureSize,
  type JourneyStreamEntry,
} from "./journeyStreamModel";
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

function point(id: string, note: string | null = null, occurredAt: string | null = null): RoutePoint {
  return {
    id, journeyId: base.id, sortOrder: 0, latitude: 0, longitude: 0, label: id,
    isStop: true, occurredAt, note, createdAt: base.createdAt,
  };
}

function asset(id: string, routePointId: string | null, sortOrder: number, mimeType = "image/jpeg"): JourneyMediaAsset {
  return {
    id, journeyId: base.id, routePointId, storageDriver: "test", storageKey: id, fileName: id,
    mimeType, bytes: 1, sortOrder, uploadedByUserId: "user-1", createdAt: base.createdAt,
  };
}

function shape(entries: readonly JourneyStreamEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === "media") return `media:${entry.asset.id}${entry.note ? "+note" : ""}`;
    if (entry.kind === "note") return `note:${entry.routePoint.id}`;
    return "intro";
  });
}

describe("journeyStreamEntries", () => {
  it("keeps a note-only Route Point as a bead between its neighbours", () => {
    const journey: Journey = {
      ...base,
      routePoints: [point("a"), point("b", "只有一句感想"), point("c")],
      media: [asset("photo-a", "a", 0), asset("video-c", "c", 0, "video/mp4")],
    };
    expect(shape(journeyStreamEntries(journey))).toEqual(["intro", "media:photo-a", "note:b", "media:video-c"]);
  });

  it("writes a point's note, place and date beside its first picture only", () => {
    const journey: Journey = {
      ...base,
      routePoints: [point("a", "海风很大", "2026-08-12T09:30:00.000Z")],
      media: [asset("second", "a", 1), asset("first", "a", 0)],
    };
    const entries = journeyStreamEntries(journey);
    expect(shape(entries)).toEqual(["intro", "media:first+note", "media:second"]);
    expect(entries[1]).toMatchObject({ place: "a", date: "2026-08-12" });
    expect(entries[2]).toMatchObject({ place: null, date: null });
  });

  it("opens with the Journey note and Journey-level media, and skips empty points", () => {
    const journey: Journey = {
      ...base,
      note: "  整段旅程  ",
      routePoints: [point("pass-through")],
      media: [asset("intro-photo", null, 0), asset("song", null, 1, "audio/mpeg")],
    };
    const entries = journeyStreamEntries(journey);
    expect(shape(entries)).toEqual(["intro", "media:intro-photo"]);
    expect(entries[0]).toMatchObject({ note: "整段旅程" });
  });
});

describe("stream sizing", () => {
  it("prefers the loaded size, then the stored size, then a 4:3 guess", () => {
    const stored = { displayWidth: 3000, displayHeight: 2000 };
    expect(streamAspect(stored, null, { width: 1000, height: 1000 })).toBe(1);
    expect(streamAspect(stored)).toBe(1.5);
    expect(streamAspect({ displayWidth: null, displayHeight: null }, { width: 900, height: 1200 })).toBe(0.75);
    expect(streamAspect({ displayWidth: null, displayHeight: null })).toBeCloseTo(4 / 3);
  });

  it("writes notes beside pictures on a wide screen and below them on a phone", () => {
    expect(journeyStreamLayout(1440, 900).beside).toBe(true);
    expect(journeyStreamLayout(390, 760).beside).toBe(false);
  });

  it("never makes a picture taller than most of the screen", () => {
    const layout = journeyStreamLayout(390, 600);
    const size = streamPictureSize(0.3, layout);
    expect(size.height).toBeLessThanOrEqual(layout.maxPictureHeight);
  });
});

describe("streamDate", () => {
  it("keeps the calendar part only", () => {
    expect(streamDate("2026-08-12T09:30:00.000Z")).toBe("2026-08-12");
    expect(streamDate("2026-08-12")).toBe("2026-08-12");
    expect(streamDate(null)).toBeNull();
  });
});
