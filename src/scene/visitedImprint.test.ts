import { describe, expect, it } from "vitest";
import type { JourneyRoute } from "../journey/types";
import {
  VISITED_IMPRINT_GAIN_CAP,
  VISITED_IMPRINT_REGION_DEGREES,
  buildVisitedImprintField,
  encodeVisitedImprintTexture,
  visitedImprintGain,
  visitedImprintGainAt,
  visitedImprintZoomAttenuation,
} from "./visitedImprint";

function route(
  id: string,
  points: Array<{ lat: number; lon: number }>,
): JourneyRoute {
  return {
    id,
    color: "#76e3d0",
    points: points.map((point, index) => ({
      id: `${id}-${index}`,
      ...point,
      isStop: true,
    })),
  };
}

describe("visited imprint policy", () => {
  it("uses the owner-approved saturating gain curve and never exceeds the cap", () => {
    expect(visitedImprintGain(0)).toBe(0);
    expect(visitedImprintGain(1)).toBeCloseTo(
      VISITED_IMPRINT_GAIN_CAP * (1 - Math.exp(-1 / 3)),
      10,
    );
    expect(visitedImprintGain(6)).toBeGreaterThan(visitedImprintGain(3));
    expect(visitedImprintGain(100)).toBeLessThanOrEqual(VISITED_IMPRINT_GAIN_CAP);
    expect(visitedImprintGain(100)).toBeCloseTo(VISITED_IMPRINT_GAIN_CAP, 10);
  });

  it("deduplicates dense Route Points from the same Journey within one region", () => {
    const sparse = buildVisitedImprintField([
      route("journey-a", [{ lat: 22.1, lon: 114.1 }]),
    ]);
    const denseSameJourney = buildVisitedImprintField([
      route("journey-a", [
        { lat: 22.1, lon: 114.1 },
        { lat: 22.2, lon: 114.2 },
        { lat: 22.3, lon: 114.3 },
        { lat: 22.4, lon: 114.4 },
      ]),
    ]);
    expect(visitedImprintGainAt(denseSameJourney, 22.2, 114.2))
      .toBeCloseTo(visitedImprintGainAt(sparse, 22.1, 114.1), 10);

    const twoJourneys = buildVisitedImprintField([
      route("journey-a", [{ lat: 22.1, lon: 114.1 }]),
      route("journey-b", [{ lat: 22.2, lon: 114.2 }]),
    ]);
    expect(visitedImprintGainAt(twoJourneys, 22.2, 114.2))
      .toBeGreaterThan(visitedImprintGainAt(sparse, 22.1, 114.1));
  });

  it("follows the existing temporal reveal at first Journey, mid timeline and now", () => {
    const routes = [
      route("journey-a", [{ lat: 22, lon: 114 }]),
      route("journey-b", [{ lat: 22.4, lon: 114.4 }]),
      route("journey-c", [{ lat: 22.8, lon: 114.8 }]),
    ];
    const reveal = (values: [number, number, number]) => ({
      journeys: new Map([
        ["journey-a", values[0]],
        ["journey-b", values[1]],
        ["journey-c", values[2]],
      ]),
      points: new Map([
        ["journey-a:0", values[0]],
        ["journey-b:0", values[1]],
        ["journey-c:0", values[2]],
      ]),
    });
    const first = buildVisitedImprintField(routes, reveal([1, 0, 0]));
    const mid = buildVisitedImprintField(routes, reveal([1, 0.5, 0]));
    const now = buildVisitedImprintField(routes, reveal([1, 1, 1]));
    const firstGain = visitedImprintGainAt(first, 22.2, 114.2);
    const midGain = visitedImprintGainAt(mid, 22.2, 114.2);
    const nowGain = visitedImprintGainAt(now, 22.2, 114.2);

    expect(firstGain).toBeGreaterThan(0);
    expect(midGain).toBeGreaterThan(firstGain);
    expect(nowGain).toBeGreaterThan(midGain);

    const rewound = buildVisitedImprintField(routes, reveal([1, 0, 0]));
    expect(visitedImprintGainAt(rewound, 22.2, 114.2)).toBeCloseTo(firstGain, 10);
  });

  it("builds only from the Journey routes supplied to the viewer", () => {
    const shared = route("shared", [{ lat: 35.7, lon: 139.7 }]);
    const privateRoute = route("private", [{ lat: 51.5, lon: -0.1 }]);
    const guestField = buildVisitedImprintField([shared]);
    const ownerField = buildVisitedImprintField([shared, privateRoute]);

    expect(visitedImprintGainAt(guestField, 35.7, 139.7)).toBeGreaterThan(0);
    expect(visitedImprintGainAt(guestField, 51.5, -0.1)).toBe(0);
    expect(visitedImprintGainAt(ownerField, 51.5, -0.1)).toBeGreaterThan(0);
  });

  it("keeps sparse route corridors broad, weaker and bounded", () => {
    const sparse = buildVisitedImprintField([
      route("journey-long", [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 120 },
      ]),
    ]);
    const pointGain = visitedImprintGainAt(sparse, 0, 0);
    const corridorGain = visitedImprintGainAt(sparse, 0, 52);

    expect(corridorGain).toBeGreaterThan(0);
    expect(corridorGain).toBeLessThan(pointGain);
    expect(sparse.activeRegionCount).toBeLessThanOrEqual(10);
  });

  it("attenuates decoration as semantic geography becomes close", () => {
    expect(visitedImprintZoomAttenuation("planet")).toBe(1);
    expect(visitedImprintZoomAttenuation("macro"))
      .toBeLessThan(visitedImprintZoomAttenuation("planet"));
    expect(visitedImprintZoomAttenuation("regional"))
      .toBeLessThan(visitedImprintZoomAttenuation("macro"));
    expect(visitedImprintZoomAttenuation("local", 0))
      .toBeLessThan(visitedImprintZoomAttenuation("regional"));
    expect(visitedImprintZoomAttenuation("local", 1))
      .toBeLessThan(visitedImprintZoomAttenuation("local", 0));
  });

  it("encodes one fixed low-resolution texture independent of route density", () => {
    const field = buildVisitedImprintField([
      route("journey-a", [{ lat: 0, lon: 0 }]),
    ]);
    expect(field.width).toBe(360 / VISITED_IMPRINT_REGION_DEGREES);
    expect(field.height).toBe(180 / VISITED_IMPRINT_REGION_DEGREES);
    expect(encodeVisitedImprintTexture(field)).toHaveLength(
      field.width * field.height * 4,
    );
  });
});
