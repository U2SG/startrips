import { describe, expect, it } from "vitest";
import { GUEST_ATLAS_VIEW_CAPABILITIES, OWNER_ATLAS_VIEW_CAPABILITIES } from "./atlasView";
import type { HomeBasePeriod } from "./homeBase";
import {
  HOME_PRELUDE_SKIP_RADIUS_KM,
  resolveHomeNarrativeContext,
} from "./homeBasePrelude";
import { GEOGRAPHIC_SURFACE_RADIUS, routePointAnchor } from "../scene/geo";

const SHENZHEN: HomeBasePeriod = {
  id: "home-shenzhen",
  label: "Shenzhen",
  latitude: 22.5431,
  longitude: 114.0579,
  startedOn: "2020-01-01",
  endedOn: "2026-09-01",
  source: "manual",
};
const TOKYO: HomeBasePeriod = {
  id: "home-tokyo",
  label: "Tokyo",
  latitude: 35.6762,
  longitude: 139.6503,
  startedOn: "2026-09-01",
  endedOn: null,
  source: "suggested-confirmed",
};

const FAR_FIRST = { latitude: 35.0116, longitude: 135.7681 };
const FAR_LAST = { latitude: 34.6937, longitude: 135.5023 };

function resolve(overrides: Partial<Parameters<typeof resolveHomeNarrativeContext>[0]> = {}) {
  return resolveHomeNarrativeContext({
    startedOn: "2024-04-18",
    endedOn: "2024-04-24",
    firstRoutePoint: FAR_FIRST,
    lastRoutePoint: FAR_LAST,
    periods: [SHENZHEN, TOKYO],
    capabilities: OWNER_ATLAS_VIEW_CAPABILITIES,
    ...overrides,
  });
}

describe("resolveHomeNarrativeContext (#235)", () => {
  it("fails closed when there is no historical Home", () => {
    expect(resolve({ periods: [] })).toEqual({
      prelude: { eligible: false, reason: "no-home-base" },
      epilogue: { eligible: false, reason: "no-home-base" },
    });
  });

  it("uses the historical period instead of the current Home", () => {
    const context = resolve();
    expect(context.prelude.eligible && context.prelude.cameraTarget.homeBaseId).toBe(SHENZHEN.id);
    expect(context.epilogue.eligible && context.epilogue.cameraTarget.homeBaseId).toBe(SHENZHEN.id);
  });

  it("can resolve different historical Homes at the two Journey boundaries", () => {
    const context = resolve({ endedOn: "2028-01-09" });
    expect(context.prelude.eligible && context.prelude.cameraTarget.homeBaseId).toBe(SHENZHEN.id);
    expect(context.epilogue.eligible && context.epilogue.cameraTarget.homeBaseId).toBe(TOKYO.id);
  });

  it("uses the owner-decided 25 km boundary inclusively", () => {
    const earthRadiusKm = 6371.0088;
    const pointAtKm = (km: number) => ({
      latitude: km / earthRadiusKm * 180 / Math.PI,
      longitude: 0,
    });
    const home: HomeBasePeriod = {
      id: "home-origin", label: "Origin", latitude: 0, longitude: 0,
      startedOn: "2020-01-01", endedOn: null, source: "manual",
    };
    expect(HOME_PRELUDE_SKIP_RADIUS_KM).toBe(25);
    for (const km of [24.9, 25]) {
      expect(resolve({ periods: [home], firstRoutePoint: pointAtKm(km) }).prelude)
        .toEqual({ eligible: false, reason: "starts-near-home" });
    }
    expect(resolve({ periods: [home], firstRoutePoint: pointAtKm(25.01) }).prelude.eligible).toBe(true);
  });

  it("skips only the epilogue when the last recorded point is already near Home", () => {
    const context = resolve({ lastRoutePoint: { latitude: 22.5431, longitude: 114.0579 } });
    expect(context.prelude.eligible).toBe(true);
    expect(context.epilogue).toEqual({ eligible: false, reason: "ends-near-home" });
  });

  it("treats an indeterminate start date as unknown for both beats", () => {
    for (const startedOn of [undefined, null, "2024-2-30", "not-a-date"]) {
      expect(resolve({ startedOn })).toEqual({
        prelude: { eligible: false, reason: "unknown-dates" },
        epilogue: { eligible: false, reason: "unknown-dates" },
      });
    }
  });

  it("does not invent an epilogue Home when the Journey end date is unknown", () => {
    const context = resolve({ endedOn: null });
    expect(context.prelude.eligible).toBe(true);
    expect(context.epilogue).toEqual({ eligible: false, reason: "unknown-dates" });
  });

  it("does not reveal private Home context in a guest/read-only Atlas", () => {
    expect(resolve({ capabilities: GUEST_ATLAS_VIEW_CAPABILITIES })).toEqual({
      prelude: { eligible: false, reason: "guest-view" },
      epilogue: { eligible: false, reason: "guest-view" },
    });
  });

  it("derives camera coordinates from the canonical geographic surface", () => {
    const context = resolve();
    if (!context.prelude.eligible) throw new Error("fixture must have Home prelude");
    const expected = routePointAnchor(
      SHENZHEN.latitude, SHENZHEN.longitude, GEOGRAPHIC_SURFACE_RADIUS,
    );
    expect(context.prelude.cameraTarget.anchor).toEqual({ x: expected.x, y: expected.y, z: expected.z });
  });

  it("is deterministic and leaves the period history deeply untouched", () => {
    const periods = structuredClone([SHENZHEN, TOKYO]);
    const before = structuredClone(periods);
    const first = resolve({ periods });
    const second = resolve({ periods });
    expect(second).toEqual(first);
    expect(periods).toEqual(before);
  });
});
