import { describe, expect, it } from "vitest";
import { previewJournalImport } from "./dailyJournal";
import {
  journeyStreamEntries,
  journeyStreamJournalDays,
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
    id, journeyId: base.id, routePointId, fileName: id,
    mimeType, bytes: 1, sortOrder, createdAt: base.createdAt,
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
  it("keeps an explicitly linked empty point addressable without inventing a note", () => {
    const journey = { ...base, routePoints: [point("a"), point("b")] };
    expect(shape(journeyStreamEntries(journey))).toEqual(["intro"]);
    expect(journeyStreamEntries(journey, "b")[1]).toMatchObject({ kind: "note", place: "b", note: "", routePoint: { id: "b" } });
    expect(shape(journeyStreamEntries(journey, "foreign"))).toEqual(["intro"]);
  });
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

it("groups readable chapters by date without regrouping Route media", () => {
  const chapters = previewJournalImport(
    "2026-08-12 第二天\n待确认：她沿海边散步（未核实）\n2026-08-11 第一天\n实际：抵达市区\n计划：看海\n起床：未记录\\\n小票：未核实\n航班号未记录，但我们顺利抵达。\n取消：原定花园\n取消：因下雨没去成花园，改去看展。\n2026-08-11 补记\n睡前：看见满天星光。",
    base.startedOn,
  );
  const [later, earlier] = chapters;
  earlier.title = "### 第一天\\";
  earlier.events[0].routePointId = "city";
  earlier.events[0].mediaIds = ["manual"];
  later.events[0].mediaIds = ["manual"];
  const journey = {
    ...base,
    routePoints: [point("coast", null, "2026-08-12T15:00:00Z"), point("city")],
    media: [asset("coast-photo", "coast", 0), asset("city-photo", "city", 0), asset("manual", null, 0), asset("extra", null, 1)],
  };
  const original = structuredClone(chapters);
  const days = journeyStreamJournalDays(chapters, new Map(journey.routePoints.map(routePoint => [routePoint.id, routePoint])));
  expect(days.map(day => day.date)).toEqual(["2026-08-11", "2026-08-12"]);
  expect(days.map(day => day.chapters.map(chapter => chapter.title))).toEqual([["第一天", "补记"], ["第二天"]]);
  expect(days.map(day => day.chapters.flatMap(chapter => chapter.events.map(event => event.text)))).toEqual([
    ["抵达市区", "航班号未记录，但我们顺利抵达。", "因下雨没去成花园，改去看展。", "睡前：看见满天星光。"],
    ["她沿海边散步"],
  ]);
  expect(days[0].chapters[0].events[0].point?.id).toBe("city");
  expect(journeyStreamEntries(journey).map(entry => entry.key)).toEqual([
    "intro", "media:manual", "media:extra", "media:coast-photo", "media:city-photo",
  ]);
  expect(chapters).toEqual(original);
});

it("keeps an explicitly linked accommodation from older planned and uncertain imports", () => {
  const [chapter] = previewJournalImport(
    "2026-08-11\n住宿：虚构酒店\n住宿：另一间虚构酒店\n计划：看海\n住宿：未记录",
    base.startedOn,
  );
  const hotel = { ...point("hotel"), placeRole: "accommodation" as const };
  chapter.events[0] = { ...chapter.events[0], status: "planned", routePointId: hotel.id };
  chapter.events[1] = { ...chapter.events[1], status: "uncertain", routePointId: hotel.id };
  chapter.events[2].routePointId = hotel.id;
  const [day] = journeyStreamJournalDays([chapter], new Map([[hotel.id, hotel]]));
  expect(day.chapters[0].events.map(({ text, point }) => [text, point?.id])).toEqual([
    ["住宿：虚构酒店", hotel.id], ["住宿：另一间虚构酒店", hotel.id],
  ]);
});

it("retains legacy source paragraphs and drops days made entirely of placeholders", () => {
  const chapters = previewJournalImport(
    "2026-08-11\n起床：未记录\\\n睡前：未确认\n2026-08-12\n她在码头看日落。\n\n小票：未记录\\\n第二段正文。",
    base.startedOn,
  ).map(chapter => ({ ...chapter, events: [] }));
  expect(journeyStreamJournalDays(chapters, new Map())).toEqual([{
    date: "2026-08-12",
    chapters: [{ id: chapters[1].id, title: "", source: "她在码头看日落。\n\n第二段正文。", events: [] }],
  }]);
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
