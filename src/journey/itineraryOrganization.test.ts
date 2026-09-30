import { describe, expect, it } from "vitest";
import {
  applyItineraryImport,
  applyItineraryOrganization,
  buildItineraryImportDraft,
  defaultItinerarySelection,
  itineraryDraftEntries,
  itineraryDraftToRoutePoints,
  retainItineraryImportEdits,
  resolveItineraryEntryPosition,
  type ItineraryRecognition,
} from "./itineraryImport";
import { routeDraftToInput } from "./routeDraft";

// Synthetic shape: repeated lodging, a day trip and a later return to A.
const recognition: ItineraryRecognition = {
  contractVersion: 1, sourceKind: "text", recognizerVersion: "synthetic/1",
  sourceTitle: "Coast route", sourceReportedDayCount: 3, sourceReportedPlaceCount: 7,
  days: [1, 2, 3].map((dayNumber) => ({ dayNumber, sourceDayTitle: `Day ${dayNumber}`,
    calendarDate: `2026-03-${13 + dayNumber}`, partialDate: null, regionContext: "Coast",
  })),
  entries: ["Hotel A", "Lunch", "Lookout", "Hotel A", "Town B", "Bridge", "Town A"].map((name, index) => ({
    sourceEntryId: `source-${index}`, dayNumber: index < 3 ? 1 : index < 5 ? 2 : 3,
    orderInDay: index < 3 ? index + 1 : index < 5 ? index - 2 : index - 4,
    name, role: index === 0 || index === 3 ? "accommodation" : "attraction",
    latitude: 20 + index / 100, longitude: 110 + index / 100,
  })),
};
const choices = [
  { index: 0, isStop: true, stayAnchorIndex: null, regionContext: "Town A" },
  { index: 1, isStop: false, stayAnchorIndex: 0, regionContext: "Town A" },
  { index: 2, isStop: false, stayAnchorIndex: 0, regionContext: "Town A" },
  { index: 3, isStop: false, stayAnchorIndex: 0, regionContext: "Town A" },
  { index: 4, isStop: true, stayAnchorIndex: null, regionContext: "Town B" },
  { index: 5, isStop: false, stayAnchorIndex: 6, regionContext: "Town A" },
  { index: 6, isStop: true, stayAnchorIndex: null, regionContext: "Town A" },
];
const makeDraft = () => buildItineraryImportDraft(recognition, "same-job");

describe("automatic editable itinerary organization", () => {
  it("preserves every dated visit while producing exact previous/next ownership", () => {
    const original = makeDraft();
    const draft = applyItineraryOrganization(original, choices);
    const entries = itineraryDraftEntries(draft);
    const points = itineraryDraftToRoutePoints(draft, defaultItinerarySelection(draft)).map((row) => row.point);
    expect(entries.map((entry) => entry.name)).toEqual(recognition.entries.map((entry) => entry.name));
    expect(entries.map((entry) => entry.entryId)).toEqual(itineraryDraftEntries(original).map((entry) => entry.entryId));
    expect(points.map((point) => point.isStop)).toEqual([true, false, false, false, true, false, true]);
    expect(points[3].label).toBe(points[0].label);
    expect(points[3].occurredAt).not.toBe(points[0].occurredAt);
    expect(points[3].id).not.toBe(points[0].id);
    expect(points[1].stayAnchorRoutePointId).toBe(points[0].id);
    expect(points[3].stayAnchorRoutePointId).toBe(points[0].id);
    expect(points[5].stayAnchorRoutePointId).toBe(points[6].id);
    expect(points[6].id).not.toBe(points[0].id);
    expect(itineraryDraftToRoutePoints(draft, defaultItinerarySelection(draft)).map((row) => row.point.id))
      .toEqual(points.map((point) => point.id));
    expect(routeDraftToInput(points)[1].stayAnchorRoutePointId).toBe(points[0].id);
  });

  it("rejects self, missing, non-Stop and non-adjacent ownership, including a deselected owner", () => {
    const draft = applyItineraryOrganization(makeDraft(), choices);
    for (const stayAnchorIndex of [1, 2, 6, 99]) {
      const rejected = applyItineraryOrganization(draft, [{ index: 1, isStop: false, stayAnchorIndex }]);
      expect(itineraryDraftEntries(rejected)[1].stayAnchorEntryId).toBeNull();
    }
    const entries = itineraryDraftEntries(draft);
    const points = itineraryDraftToRoutePoints(draft, entries.slice(1).map((entry) => entry.entryId));
    expect(points[0].point.stayAnchorRoutePointId).toBeNull();
    const independent = applyItineraryOrganization(draft, [{ index: 1, stayAnchorIndex: null }]);
    expect(itineraryDraftToRoutePoints(independent, defaultItinerarySelection(independent))[1].point.stayAnchorRoutePointId).toBeNull();
  });

  it("keeps a human owner span and position through a retry and late model promotions", () => {
    let edited = applyItineraryOrganization(makeDraft(), choices);
    const entries = itineraryDraftEntries(edited);
    edited = resolveItineraryEntryPosition(edited, entries[3].entryId, { latitude: 21, longitude: 111, alias: "Chosen hotel" });
    const protectedIds = new Set([entries[3].entryId]);
    const retried = retainItineraryImportEdits(edited, makeDraft(), protectedIds, protectedIds);
    const late = applyItineraryOrganization(retried, [
      { index: 0, isStop: false }, { index: 1, isStop: true },
      { index: 2, isStop: true }, { index: 3, isStop: true },
    ], protectedIds);
    const after = itineraryDraftEntries(late);
    expect(after.slice(0, 4).map((entry) => entry.isStop)).toEqual([true, false, false, false]);
    expect(after[3]).toMatchObject({ pointId: entries[3].pointId, latitude: 21, longitude: 111,
      stayAnchorEntryId: entries[0].entryId, isStop: false,
    });
    expect(after[3].aliases).toContain("Chosen hotel");
    expect(after.map((entry) => entry.pointId)).toEqual(entries.map((entry) => entry.pointId));
  });

  it("replays without replacing manual rows or rebinding a new child to a demoted Stop", () => {
    const draft = applyItineraryOrganization(makeDraft(), choices);
    const projected = itineraryDraftToRoutePoints(draft, defaultItinerarySelection(draft));
    const initial = applyItineraryImport([], projected.slice(0, 1)).routePoints;
    const human = initial.map((point) => ({ ...point, label: "Human label", note: "Keep this", isStop: false }));
    const reread = applyItineraryOrganization(makeDraft(), choices);
    const retry = applyItineraryImport(human, itineraryDraftToRoutePoints(reread, defaultItinerarySelection(reread)));
    expect(retry.routePoints).toHaveLength(7);
    expect(retry.routePoints[0]).toEqual(human[0]);
    expect(retry.routePoints[1].stayAnchorRoutePointId).toBeNull();
    const replay = applyItineraryImport(retry.routePoints, projected);
    expect(replay.replayed).toBe(true);
    expect(replay.routePoints).toEqual(retry.routePoints);
  });
});
