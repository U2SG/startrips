import { describe, expect, it } from "vitest";
import { GEOGRAPHIC_SURFACE_RADIUS, routePointAnchor } from "../scene/geo";
import type { HomeBasePeriod } from "./homeBase";
import { resolveHomeBaseCameraIntent } from "./homeBaseCameraPolicy";

const CURRENT_HOME: HomeBasePeriod = {
  id: "home-current",
  label: "深圳",
  latitude: 22.5431,
  longitude: 114.0579,
  startedOn: "2026-01-01",
  endedOn: null,
  source: "manual",
};

describe("resolveHomeBaseCameraIntent (#233)", () => {
  it("may seed a fresh Atlas from confirmed current Home", () => {
    const intent = resolveHomeBaseCameraIntent({
      currentPeriod: CURRENT_HOME,
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: null,
    });
    expect(intent).toMatchObject({
      kind: "initial-home",
      homeBaseId: CURRENT_HOME.id,
      latitude: CURRENT_HOME.latitude,
      longitude: CURRENT_HOME.longitude,
    });
    expect(intent?.anchor.toArray()).toEqual(
      routePointAnchor(CURRENT_HOME.latitude, CURRENT_HOME.longitude, GEOGRAPHIC_SURFACE_RADIUS).toArray(),
    );
  });

  it("never recenters Home after manual camera interaction", () => {
    expect(resolveHomeBaseCameraIntent({
      currentPeriod: CURRENT_HOME,
      atlasIsFresh: true,
      hasManualCameraInteraction: true,
      selectedJourneyId: null,
    })).toBeNull();
  });

  it("yields camera ownership whenever a Journey is selected", () => {
    expect(resolveHomeBaseCameraIntent({
      currentPeriod: CURRENT_HOME,
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: "journey-1",
    })).toBeNull();
  });

  it("does not center an ended period or a non-fresh Atlas", () => {
    expect(resolveHomeBaseCameraIntent({
      currentPeriod: { ...CURRENT_HOME, endedOn: "2026-08-01" },
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: null,
    })).toBeNull();
    expect(resolveHomeBaseCameraIntent({
      currentPeriod: CURRENT_HOME,
      atlasIsFresh: false,
      hasManualCameraInteraction: false,
      selectedJourneyId: null,
    })).toBeNull();
  });
});
