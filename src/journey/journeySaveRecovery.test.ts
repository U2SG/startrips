import { describe, expect, it } from "vitest";
import { JourneyApiError } from "./journeyApi";
import {
  LOCATION_SEARCH_UNAVAILABLE_COPY,
  journeyLocationSearchErrorMessage,
} from "./journeyLocationSearchError";
import {
  resolveJourneyArrivalHandoff,
  resolveJourneySaveRecovery,
} from "./journeySaveRecovery";
import type { Journey, JourneyInput } from "./types";

const submitted: JourneyInput = {
  title: "Night train",
  startedOn: "2026-08-11",
  endedOn: "2026-08-12",
  note: "Across the water",
  lightColor: "#f4ce73",
  lightEffect: null,
  routePoints: [{
    latitude: 31.2304,
    longitude: 121.4737,
    label: "Shanghai",
    isStop: true,
    occurredAt: "2026-08-11T01:00:00.000Z",
    note: null,
  }],
};

function persisted(overrides: Partial<Journey> = {}): Journey {
  return {
    id: "journey-server-id",
    atlasId: "atlas-1",
    title: submitted.title,
    startedOn: submitted.startedOn,
    endedOn: submitted.endedOn,
    note: submitted.note,
    lightColor: submitted.lightColor,
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 1,
    createdByUserId: "user-1",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    routePoints: [{
      id: "point-server-id",
      journeyId: "journey-server-id",
      sortOrder: 0,
      latitude: 31.2304,
      longitude: 121.4737,
      label: "Shanghai",
      isStop: true,
      occurredAt: "2026-08-11T01:00:00.000Z",
      note: null,
      createdAt: "2026-08-11T00:00:00.000Z",
    }],
    media: [],
    ...overrides,
  };
}

describe("journey save recovery", () => {
  it("adopts the unique server Journey whose canonical submitted fields match", () => {
    const decision = resolveJourneySaveRecovery(submitted, [
      persisted({ id: "other", title: "Different Journey" }),
      persisted(),
    ]);
    expect(decision).toMatchObject({
      status: "already-persisted",
      journey: { id: "journey-server-id" },
    });
  });

  it("ignores an identical Journey that already existed before the create attempt", () => {
    const oldJourney = persisted({
      id: "journey-old",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    const newJourney = persisted({
      id: "journey-new",
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    expect(resolveJourneySaveRecovery(
      submitted,
      [oldJourney, newJourney],
      { knownJourneyIdsBeforeCreate: new Set(["journey-old"]) },
    )).toMatchObject({
      status: "already-persisted",
      journey: { id: "journey-new" },
    });
  });

  it("does not adopt an arbitrary identity when multiple new Journeys match", () => {
    const first = persisted({
      id: "journey-new-a",
      createdAt: "2026-08-11T00:00:01.000Z",
    });
    const second = persisted({
      id: "journey-new-b",
      createdAt: "2026-08-11T00:00:02.000Z",
    });

    expect(resolveJourneySaveRecovery(submitted, [second, first])).toEqual({
      status: "ambiguous",
      matchingJourneyIds: ["journey-new-a", "journey-new-b"],
    });
  });

  it("returns not-persisted when the read-back has no canonical match", () => {
    expect(resolveJourneySaveRecovery(submitted, [
      persisted({ title: "Different Journey" }),
    ])).toEqual({ status: "not-persisted" });
  });

  it("does not adopt a Journey with only a similar route", () => {
    const nearMatch = persisted({
      routePoints: [{
        ...persisted().routePoints[0],
        longitude: 121.4738,
      }],
    });
    expect(resolveJourneySaveRecovery(submitted, [nearMatch]))
      .toEqual({ status: "not-persisted" });
  });

  it("hands arrival ownership to the first create callback only", () => {
    expect(resolveJourneyArrivalHandoff({
      journeyId: "journey-server-id",
      editingJourneyId: null,
      callbackScope: "initial-save",
    })).toBe("journey-server-id");
    expect(resolveJourneyArrivalHandoff({
      journeyId: "journey-server-id",
      editingJourneyId: null,
      callbackScope: "media-retry",
    })).toBeNull();
    expect(resolveJourneyArrivalHandoff({
      journeyId: "journey-server-id",
      editingJourneyId: "journey-server-id",
      callbackScope: "initial-save",
    })).toBeNull();
  });

  it("maps LOCATION_SEARCH_UNAVAILABLE to truthful alternate input guidance", () => {
    const message = journeyLocationSearchErrorMessage(new JourneyApiError(
      503,
      "LOCATION_SEARCH_UNAVAILABLE",
      "adapter missing",
    ));
    expect(message).toBe(LOCATION_SEARCH_UNAVAILABLE_COPY);
    expect(message).toContain("地球上取点");
    expect(message).toContain("精确位置");
    expect(message).toContain("纬度");
    expect(message).toContain("经度");
    expect(message).not.toContain("adapter missing");
  });
});
