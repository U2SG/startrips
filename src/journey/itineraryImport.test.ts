import { describe, expect, it } from "vitest";
import {
  applyItineraryImport,
  buildItineraryImportDraft,
  defaultItinerarySelection,
  itineraryDraftEntries,
  itineraryDraftToRoutePoints,
  itineraryImportJobKey,
  resolveItineraryEntryPosition,
  withAddedRoutePointCount,
} from "./itineraryImport";
import { readTextItinerary } from "./itineraryText";
import { journeyToDraftPoints, routeDraftToInput } from "./routeDraft";
import type { Journey } from "./types";

/**
 * #512. Three writings of one plan: Chinese only, English only, and the mix a
 * real shared itinerary actually is. Equivalent content has to read as the
 * same plan — same days, same order, same number of places — because the
 * member pasting the mixed one is not asking for a lesser import.
 *
 * Each fixture is synthetic. Nothing here reproduces the owner's private
 * sample, which stays out of the repository, the snapshots and the CI log.
 */

const CHINESE_ITINERARY = `成都重庆 3日游
共 6 个地点

Day 1 · 2026年3月14日 周六 · 成都
住宿 成都尼依格罗酒店 @30.6570,104.0658
景点 宽窄巷子 → 人民公园 @30.6640,104.0510

Day 2 · 2026年3月15日 周日 · 成都
住宿 成都尼依格罗酒店 @30.6570,104.0658
景点 成都自然历史博物馆 @30.6800,104.0850

Day 3 · 2026年3月16日 周一 · 重庆
交通 成都 至 重庆
景点 洪崖洞 @29.5630,106.5810
`;

const ENGLISH_ITINERARY = `Chengdu Chongqing 3-day trip
6 places

Day 1 · Mar 14, 2026 (Sat) · Chengdu
Stay: The Niccolo Chengdu @30.6570,104.0658
Visit: Kuanzhai Alley -> People's Park @30.6640,104.0510

Day 2 · Mar 15, 2026 (Sun) · Chengdu
Stay: The Niccolo Chengdu @30.6570,104.0658
Visit: Chengdu Museum of Natural History @30.6800,104.0850

Day 3 · Mar 16, 2026 (Mon) · Chongqing
Flight: Chengdu to Chongqing
Visit: Hongya Cave @29.5630,106.5810
`;

const MIXED_ITINERARY = `成都 Chengdu · 重庆 Chongqing 3日游
共 6 个地点

Day 1 · 2026-03-14 周六 · 成都 Chengdu
住宿 成都尼依格罗酒店 The Niccolo Chengdu @30.6570,104.0658
Visit: 宽窄巷子 Kuanzhai Alley → 人民公园 People's Park @30.6640,104.0510

Day 2 · 2026-03-15 Sun · 成都 Chengdu
住宿 成都尼依格罗酒店 The Niccolo Chengdu @30.6570,104.0658
景点 Chengdu Museum of Natural History @30.6800,104.0850

Day 3 · 2026-03-16 Mon · 重庆 Chongqing
交通 成都 Chengdu 至 重庆 Chongqing
景点 洪崖洞 Hongya Cave @29.5630,106.5810
`;

function draftOf(text: string, label: string) {
  return buildItineraryImportDraft(
    readTextItinerary(text),
    itineraryImportJobKey("text", label),
  );
}

const FIXTURES = [
  ["Chinese", CHINESE_ITINERARY],
  ["English", ENGLISH_ITINERARY],
  ["mixed", MIXED_ITINERARY],
] as const;

describe("bilingual itinerary recognition", () => {
  it.each(FIXTURES)(
    "reads the same plan shape from the %s writing",
    (label, text) => {
      const draft = draftOf(text, label);
      expect(draft.days.map((day) => day.dayNumber)).toEqual([1, 2, 3]);
      expect(draft.days.map((day) => day.calendarDate)).toEqual([
        "2026-03-14",
        "2026-03-15",
        "2026-03-16",
      ]);
      expect(draft.counts.recognizedEntryCount).toBe(7);
      expect(draft.days.map((day) => day.entries.length)).toEqual([3, 2, 2]);
      expect(draft.days.flatMap((day) =>
        day.entries.map((entry) => entry.role)
      )).toEqual([
        "accommodation",
        "attraction",
        "attraction",
        "accommodation",
        "attraction",
        "transport",
        "attraction",
      ]);
    },
  );

  it("keeps an arrow line in printed order without splitting on spaces", () => {
    const entries = itineraryDraftEntries(draftOf(ENGLISH_ITINERARY, "en"))
      .filter((entry) => entry.dayNumber === 1 && entry.role === "attraction");
    expect(entries.map((entry) => entry.name)).toEqual([
      "Kuanzhai Alley",
      "People's Park",
    ]);
    expect(
      itineraryDraftEntries(draftOf(ENGLISH_ITINERARY, "en"))
        .some((entry) => entry.name === "Chengdu Museum of Natural History"),
    ).toBe(true);
  });

  it("records the source's own count beside the recognised one", () => {
    const draft = draftOf(CHINESE_ITINERARY, "zh");
    // The page claims six places; seven entries were read, because the source
    // does not count its transport leg. Neither number is adjusted.
    expect(draft.counts.sourceReportedPlaceCount).toBe(6);
    expect(draft.counts.recognizedEntryCount).toBe(7);
    expect(draft.notices).toContain("source-place-count-mismatch");
    // Entries still waiting for a position outrank the count difference: the
    // draft is something to review, not something already reconciled.
    expect(draft.state).toBe("needs-review");
  });

  it("keeps a transport leg as one entry carrying both endpoints", () => {
    for (const [label, text] of FIXTURES) {
      const leg = itineraryDraftEntries(draftOf(text, label))
        .find((entry) => entry.role === "transport");
      expect(leg?.transitEndpoints?.from).toBeTruthy();
      expect(leg?.transitEndpoints?.to).toBeTruthy();
      expect(leg?.transitEndpoints?.from).not.toBe(leg?.transitEndpoints?.to);
    }
  });

  it("preserves the region each entry was listed under", () => {
    const draft = draftOf(MIXED_ITINERARY, "mixed");
    expect(draft.days.map((day) => day.regionContext)).toEqual([
      "成都 Chengdu",
      "成都 Chengdu",
      "重庆 Chongqing",
    ]);
    // The region heading is context, never an extra Route Point of its own.
    expect(
      itineraryDraftEntries(draft).some((entry) => entry.name === "成都 Chengdu"),
    ).toBe(false);
  });
});

describe("applying a reviewed itinerary draft", () => {
  it("adds Route Points in plan order and counts them separately", () => {
    const draft = draftOf(CHINESE_ITINERARY, "zh");
    const imported = itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    );
    // The transport leg resolved no position, so it is not a Route Point yet.
    expect(imported.map((item) => item.point.label)).toEqual([
      "成都尼依格罗酒店",
      "人民公园",
      "成都尼依格罗酒店",
      "成都自然历史博物馆",
      "洪崖洞",
    ]);
    const applied = applyItineraryImport([], imported);
    expect(applied.addedRoutePointCount).toBe(5);
    const counted = withAddedRoutePointCount(draft, applied.addedRoutePointCount);
    expect(counted.counts).toMatchObject({
      sourceReportedPlaceCount: 6,
      recognizedEntryCount: 7,
      addedRoutePointCount: 5,
    });
    expect(counted.counts.pendingConfirmationCount).toBeGreaterThan(0);
  });

  it("marks a pure-transit position as a non-Stop Route Point", () => {
    const draft = draftOf(
      "Day 1 · 2026-03-14 · Chengdu\n途经 剑门关 @32.1300,105.5900\n",
      "transit",
    );
    const [imported] = itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    );
    expect(imported.role).toBe("pure-transit");
    expect(imported.point.isStop).toBe(false);
  });

  it("imports an entry only once its position is confirmed", () => {
    const draft = draftOf(CHINESE_ITINERARY, "zh");
    const unresolved = itineraryDraftEntries(draft)
      .find((entry) => entry.name === "宽窄巷子");
    expect(unresolved?.flags).toContain("unresolved-position");
    expect(defaultItinerarySelection(draft)).not.toContain(unresolved?.entryId);

    const resolved = resolveItineraryEntryPosition(
      draft,
      unresolved!.entryId,
      { latitude: 30.6695, longitude: 104.0585, alias: "Kuanzhai Alley" },
    );
    const entry = itineraryDraftEntries(resolved)
      .find((item) => item.entryId === unresolved!.entryId);
    // The printed name is never replaced; a confirmed rendering joins it.
    expect(entry?.name).toBe("宽窄巷子");
    expect(entry?.aliases).toEqual(["Kuanzhai Alley"]);
    expect(entry?.flags).not.toContain("unresolved-position");
    expect(defaultItinerarySelection(resolved)).toContain(unresolved!.entryId);
    expect(resolved.counts.pendingConfirmationCount)
      .toBe(draft.counts.pendingConfirmationCount - 1);
  });

  it("appends into an existing Journey draft without touching its points", () => {
    const journey = {
      routePoints: [
        {
          id: "saved-1",
          journeyId: "j1",
          sortOrder: 0,
          latitude: 1,
          longitude: 2,
          label: "已有地点",
          isStop: true,
          occurredAt: null,
          note: "手写备注",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as unknown as Journey;
    const existing = journeyToDraftPoints(journey);
    const draft = draftOf(CHINESE_ITINERARY, "zh");
    const imported = itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    );

    const applied = applyItineraryImport(existing, imported);
    expect(applied.routePoints.slice(0, 1)).toEqual(existing);
    expect(applied.addedRoutePointCount).toBe(imported.length);
    expect(applied.replayed).toBe(false);

    // The same job again — a retry or a lost response — moves nothing.
    const replay = applyItineraryImport(applied.routePoints, imported);
    expect(replay.addedRoutePointCount).toBe(0);
    expect(replay.replayed).toBe(true);
    expect(replay.routePoints).toEqual(applied.routePoints);
  });

  it("sends only Route Point fields, with no plan-only context on the wire", () => {
    const draft = draftOf(CHINESE_ITINERARY, "zh");
    const imported = itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    );
    for (const point of routeDraftToInput(imported.map((item) => item.point))) {
      expect(Object.keys(point).sort()).toEqual([
        "isStop",
        "label",
        "latitude",
        "longitude",
        "note",
        "occurredAt",
      ]);
    }
    // The reading context #514 wants survives beside the point, not inside it.
    expect(imported.every((item) => item.regionContext !== null)).toBe(true);
  });
});
