import { describe, expect, it } from "vitest";
import { buildPlaybackSteps } from "./journeyPlayback";
import type { HomeNarrativeContext } from "./homeBasePrelude";
import { quickRecapRouteGeometry } from "./quickRecapPlayback";
import type { Journey } from "./types";
import { buildRouteArcSamples } from "../scene/geo";

const JOURNEY: Journey = {
  id: "journey-home-geometry", atlasId: "atlas-1", title: "Route truth",
  startedOn: "2026-01-01", endedOn: "2026-01-03", note: "", lightColor: "#fff", revision: 1,
  createdByUserId: "user-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  routePoints: [
    { id: "p0", journeyId: "journey-home-geometry", sortOrder: 0, latitude: 22.3, longitude: 114.1, label: "A", isStop: true, occurredAt: null, note: null, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "p1", journeyId: "journey-home-geometry", sortOrder: 1, latitude: 35.6, longitude: 139.7, label: "B", isStop: true, occurredAt: null, note: null, createdAt: "2026-01-01T00:00:00.000Z" },
  ],
  media: [],
};

const HOME: HomeNarrativeContext = {
  prelude: {
    eligible: true, reason: "eligible",
    cameraTarget: { kind: "home", homeBaseId: "home", latitude: 1.2345, longitude: 2.3456, anchor: { x: 1, y: 0, z: 0 } },
  },
  epilogue: { eligible: false, reason: "ends-near-home" },
};

describe("Home Playback route truth (#235)", () => {
  it("does not change canonical route arc or Quick Recap route geometry", () => {
    const routeBefore = structuredClone(JOURNEY.routePoints);
    const locations = JOURNEY.routePoints.map((point) => ({ point: { lat: point.latitude, lon: point.longitude } }));
    const arcBefore = buildRouteArcSamples(locations);
    const recapBefore = quickRecapRouteGeometry(JOURNEY, JOURNEY.routePoints.map((point) => point.id));

    const steps = buildPlaybackSteps(JOURNEY, HOME);

    const arcAfter = buildRouteArcSamples(locations);
    const recapAfter = quickRecapRouteGeometry(JOURNEY, JOURNEY.routePoints.map((point) => point.id));
    expect(arcAfter.directions).toEqual(arcBefore.directions);
    expect(arcAfter.lifts).toEqual(arcBefore.lifts);
    expect(recapAfter).toEqual(recapBefore);
    expect(JOURNEY.routePoints).toEqual(routeBefore);
    expect(JOURNEY.routePoints.some((point) => (
      point.latitude === 1.2345 || point.longitude === 2.3456
    ))).toBe(false);
    expect(steps[0]?.kind).toBe("home-prelude");
  });
});
