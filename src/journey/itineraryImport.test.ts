import { describe, expect, it } from "vitest";
import {
  applyItineraryImport,
  IMPORTED_ROUTE_POINT_FIELDS,
  buildItineraryImportDraft,
  defaultItinerarySelection,
  itineraryDraftEntries,
  itineraryDraftToRoutePoints,
  itineraryImportJobKey,
  resolveInsertAtIndex,
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

  it("keeps a flight leg without trying to geocode its flight number", () => {
    const draft = buildItineraryImportDraft({
      contractVersion: 1,
      sourceKind: "link",
      recognizerVersion: "reader-test",
      sourceTitle: null,
      sourceReportedDayCount: 1,
      sourceReportedPlaceCount: 1,
      days: [{ dayNumber: 1, sourceDayTitle: "02月11日", calendarDate: null, partialDate: "02-11" }],
      entries: [{
        sourceEntryId: null, dayNumber: 1, orderInDay: 1, name: "UA821",
        role: "pure-transit", transitEndpoints: { from: "香港国际机场", to: "洛杉矶国际机场" },
      }],
    }, "flight-test");
    expect(draft.counts.pendingConfirmationCount).toBe(0);
    expect(defaultItinerarySelection(draft)).toEqual([]);
    expect(itineraryDraftToRoutePoints(draft, [itineraryDraftEntries(draft)[0].entryId]))
      .toEqual([]);
  });

  it("keeps a named pass-through place pending until its position is resolved", () => {
    const draft = draftOf("Day 1 · 2026-03-14 · Chengdu\n途经 剑门关\n", "waypoint");
    const [waypoint] = itineraryDraftEntries(draft);
    expect(waypoint.flags).toContain("unresolved-position");
    const positioned = resolveItineraryEntryPosition(draft, waypoint.entryId, {
      latitude: 32.13, longitude: 105.59,
    });
    const [imported] = itineraryDraftToRoutePoints(positioned, defaultItinerarySelection(positioned));
    expect(imported.point.isStop).toBe(false);
    expect(imported.role).toBe("pure-transit");
  });

  it("treats a pasted flight between endpoints as a leg, not a place", () => {
    const draft = draftOf("Day 1 · 2026-03-14 · Hong Kong\nflight Hong Kong to Los Angeles\n", "flight-text");
    expect(itineraryDraftEntries(draft)[0].transitEndpoints).toEqual({
      from: "Hong Kong", to: "Los Angeles",
    });
    expect(draft.counts.pendingConfirmationCount).toBe(0);
    expect(defaultItinerarySelection(draft)).toEqual([]);
  });

  it("keeps a venue-free concert in the reading without turning it into a place", () => {
    const draft = buildItineraryImportDraft({
      contractVersion: 1,
      sourceKind: "link",
      recognizerVersion: "reader-test",
      sourceTitle: null,
      sourceReportedDayCount: 1,
      sourceReportedPlaceCount: 1,
      days: [{ dayNumber: 1, sourceDayTitle: null, calendarDate: null, partialDate: null }],
      entries: [{
        sourceEntryId: null, dayNumber: 1, orderInDay: 1,
        name: "巡演演出（未列出场馆）", role: "activity",
      }],
    }, "event-test");
    expect(itineraryDraftEntries(draft)).toHaveLength(1);
    expect(draft.counts.pendingConfirmationCount).toBe(0);
    expect(defaultItinerarySelection(draft)).toEqual([]);
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

  it("inserts after a chosen existing stop and leaves the rest in place", () => {
    const journey = {
      routePoints: ["saved-1", "saved-2", "saved-3"].map((id, index) => ({
        id,
        journeyId: "j1",
        sortOrder: index,
        latitude: index,
        longitude: index,
        label: `已有地点 ${index + 1}`,
        isStop: true,
        occurredAt: null,
        note: "手写备注",
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    } as unknown as Journey;
    const existing = journeyToDraftPoints(journey);
    const draft = draftOf(CHINESE_ITINERARY, "zh");
    const imported = itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    );

    // "After the second stop" is a position in the draft, resolved by id
    // rather than by the index the panel happened to render.
    const insertAtIndex = resolveInsertAtIndex(existing, existing[1].draftId);
    expect(insertAtIndex).toBe(2);

    const applied = applyItineraryImport(existing, imported, { insertAtIndex });
    expect(applied.routePoints.slice(0, 2)).toEqual(existing.slice(0, 2));
    expect(applied.routePoints.slice(2, 2 + imported.length))
      .toEqual(imported.map((item) => item.point));
    expect(applied.routePoints.slice(2 + imported.length)).toEqual(existing.slice(2));
    expect(applied.addedRoutePointCount).toBe(imported.length);

    // Every existing point keeps its id, label and unsaved note wherever it
    // ended up relative to the import.
    expect(applied.routePoints.filter((point) => point.note === "手写备注"))
      .toHaveLength(existing.length);

    // The same job again is still a replay, wherever it was inserted.
    const replay = applyItineraryImport(applied.routePoints, imported, { insertAtIndex });
    expect(replay.addedRoutePointCount).toBe(0);
    expect(replay.routePoints).toEqual(applied.routePoints);
  });

  it("appends when no position was chosen, or when the chosen stop is gone", () => {
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
          note: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as unknown as Journey;
    const existing = journeyToDraftPoints(journey);

    expect(resolveInsertAtIndex(existing, null)).toBeUndefined();
    // Deleted from the draft while the review panel was open: appending is the
    // only position nobody has to guess.
    expect(resolveInsertAtIndex(existing, "draft-that-was-removed")).toBeUndefined();
    expect(resolveInsertAtIndex([], "saved-1")).toBeUndefined();
  });

  it("is a plan, not a recording: no capture, no track, no Home Base evidence", () => {
    const draft = draftOf(CHINESE_ITINERARY, "zh");
    const imported = itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    );
    const serialized = JSON.stringify(imported.map((item) => item.point));
    // A recorded track carries samples with these; an imported plan has no
    // shape to put one in, so a plan can never be read back as evidence that
    // anybody was physically there.
    for (const field of [
      "recordedAt",
      "accuracyMeters",
      "segmentOrder",
      "sampleOrder",
      "mediaAssetId",
      "capturedAt",
      "contentHash",
    ]) {
      expect(serialized).not.toContain(field);
    }
    // And nothing it writes reaches the Home Base evidence surface, which
    // reads saved Journeys rather than drafts.
    expect(IMPORTED_ROUTE_POINT_FIELDS).toEqual([
      "latitude",
      "longitude",
      "label",
      "isStop",
      "occurredAt",
      "note",
    ]);
    expect(imported.every((item) => item.point.occurredAt === null
      || /^\d{4}-\d{2}-\d{2}$/.test(item.point.occurredAt))).toBe(true);
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
