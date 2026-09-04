import { describe, expect, it } from "vitest";
import {
  buildSharedJourneyView,
  type SharedJourneyRows,
} from "./shared-journey-repository";

const EXPIRES_AT = new Date("2026-09-10T12:00:00.000Z");
const GRANT = { expiresAt: EXPIRES_AT };
const SHARED_A = "11111111-1111-4111-8111-111111111111";
const SHARED_B = "22222222-2222-4222-8222-222222222222";
const SHARED_C = "33333333-3333-4333-8333-333333333333";
const UNSHARED = "99999999-9999-4999-8999-999999999999";

function journeyRow(id: string, title: string) {
  return {
    id,
    title,
    startedOn: "2026-08-11",
    endedOn: "2026-08-12",
    note: "shared note",
    lightColor: "#f4ce73",
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 1,
  };
}

function routePointRow(journeyId: string, id: string) {
  return {
    journeyId,
    id,
    latitude: 1.3521,
    longitude: 103.8198,
    label: "Singapore",
    isStop: true,
    occurredAt: new Date("2026-08-11T00:00:00.000Z"),
    note: null,
  };
}

function mediaRow(journeyId: string, id: string) {
  return {
    journeyId,
    id,
    routePointId: null,
    fileName: "shared.jpg",
    mimeType: "image/jpeg",
    bytes: 1024,
  };
}

function rows(overrides: Partial<SharedJourneyRows> = {}): SharedJourneyRows {
  return { journeys: [], routePoints: [], media: [], ...overrides };
}

describe("shared journey view scope closure", () => {
  it("closes previous/next navigation over the granted set", () => {
    const view = buildSharedJourneyView(GRANT, rows({
      journeys: [
        journeyRow(SHARED_A, "First"),
        journeyRow(SHARED_B, "Second"),
        journeyRow(SHARED_C, "Third"),
      ],
    }));

    expect(view.journeys.map((journey) => journey.id)).toEqual([
      SHARED_A,
      SHARED_B,
      SHARED_C,
    ]);
    // The first and the last granted journey have no neighbour outside the
    // set, and the middle one only ever points back inside it.
    expect(view.journeys[0]).toMatchObject({
      previousJourneyId: null,
      nextJourneyId: SHARED_B,
    });
    expect(view.journeys[1]).toMatchObject({
      previousJourneyId: SHARED_A,
      nextJourneyId: SHARED_C,
    });
    expect(view.journeys[2]).toMatchObject({
      previousJourneyId: SHARED_B,
      nextJourneyId: null,
    });
    const reachable = view.journeys.flatMap((journey) =>
      [journey.previousJourneyId, journey.nextJourneyId].filter(
        (id): id is string => id !== null,
      ));
    expect(new Set(reachable)).toEqual(new Set([SHARED_A, SHARED_B, SHARED_C]));
  });

  it("gives a single-journey grant no neighbour in either direction", () => {
    const view = buildSharedJourneyView(GRANT, rows({
      journeys: [journeyRow(SHARED_A, "Only")],
    }));
    expect(view.share).toEqual({ expiresAt: EXPIRES_AT, journeyCount: 1 });
    expect(view.journeys[0]).toMatchObject({
      previousJourneyId: null,
      nextJourneyId: null,
    });
  });

  it("keeps the order it was handed, which is the grant's recorded order", () => {
    // Reverse chronology on purpose: the read order is the grant's stored
    // selection order, never re-derived from the journey dates.
    const view = buildSharedJourneyView(GRANT, rows({
      journeys: [
        { ...journeyRow(SHARED_C, "Recorded first"), startedOn: "2026-09-01" },
        { ...journeyRow(SHARED_A, "Recorded second"), startedOn: "2026-07-01" },
      ],
    }));
    expect(view.journeys.map((journey) => journey.id)).toEqual([
      SHARED_C,
      SHARED_A,
    ]);
  });

  it("drops route points and media belonging to a journey outside the set", () => {
    const view = buildSharedJourneyView(GRANT, rows({
      journeys: [journeyRow(SHARED_A, "Shared")],
      routePoints: [
        routePointRow(SHARED_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        routePointRow(UNSHARED, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      ],
      media: [
        mediaRow(SHARED_A, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        mediaRow(UNSHARED, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      ],
    }));

    expect(view.journeys).toHaveLength(1);
    expect(view.journeys[0].routePoints.map((point) => point.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
    expect(view.journeys[0].media.map((asset) => asset.id)).toEqual([
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
    expect(JSON.stringify(view)).not.toContain(UNSHARED);
  });

  it("answers an emptied grant scope with an empty set, not a partial one", () => {
    const view = buildSharedJourneyView(GRANT, rows({
      routePoints: [routePointRow(UNSHARED, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")],
      media: [mediaRow(UNSHARED, "ffffffff-ffff-4fff-8fff-ffffffffffff")],
    }));
    expect(view).toEqual({
      share: { expiresAt: EXPIRES_AT, journeyCount: 0 },
      journeys: [],
    });
  });

  it("counts only the journeys it returns", () => {
    const view = buildSharedJourneyView(GRANT, rows({
      journeys: [journeyRow(SHARED_A, "First"), journeyRow(SHARED_B, "Second")],
    }));
    expect(view.share.journeyCount).toBe(view.journeys.length);
    expect(view.share.journeyCount).toBe(2);
  });

  it("carries no owner or storage field on a journey, route point or asset", () => {
    const view = buildSharedJourneyView(GRANT, rows({
      journeys: [journeyRow(SHARED_A, "Shared")],
      routePoints: [routePointRow(SHARED_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")],
      media: [mediaRow(SHARED_A, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")],
    }));

    expect(Object.keys(view.journeys[0]).sort()).toEqual([
      "coverMediaAssetId",
      "endedOn",
      "id",
      "lightColor",
      "lightEffect",
      "media",
      "nextJourneyId",
      "note",
      "previousJourneyId",
      "revision",
      "routePoints",
      "startedOn",
      "title",
    ]);
    // `journeyId` is gone because the rows are nested under their journey, and
    // no `sortOrder` reaches the browser: payload order is the order.
    expect(Object.keys(view.journeys[0].routePoints[0]).sort()).toEqual([
      "id",
      "isStop",
      "label",
      "latitude",
      "longitude",
      "note",
      "occurredAt",
    ]);
    expect(Object.keys(view.journeys[0].media[0]).sort()).toEqual([
      "bytes",
      "fileName",
      "id",
      "mimeType",
      "routePointId",
    ]);
  });
});
