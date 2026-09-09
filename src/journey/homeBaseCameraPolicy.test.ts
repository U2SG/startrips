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

const CURRENT_DATE = "2026-09-10";

describe("resolveHomeBaseCameraIntent (#233)", () => {
  it("may seed a fresh Atlas from the Home effective on the supplied date", () => {
    const intent = resolveHomeBaseCameraIntent({
      periods: [CURRENT_HOME],
      effectiveDate: CURRENT_DATE,
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

  it("keeps initial camera ownership on the effective old Home until a future move boundary", () => {
    const moveDate = "2030-01-01";
    const oldHome: HomeBasePeriod = { ...CURRENT_HOME, id: "home-old", endedOn: moveDate };
    const futureHome: HomeBasePeriod = {
      ...CURRENT_HOME,
      id: "home-future",
      label: "东京",
      latitude: 35.6762,
      longitude: 139.6503,
      startedOn: moveDate,
      endedOn: null,
    };
    const common = {
      periods: [oldHome, futureHome],
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: null,
    } as const;
    expect(resolveHomeBaseCameraIntent({ ...common, effectiveDate: "2029-12-31" })?.homeBaseId).toBe(oldHome.id);
    expect(resolveHomeBaseCameraIntent({ ...common, effectiveDate: moveDate })?.homeBaseId).toBe(futureHome.id);
  });

  it("never recenters Home after manual camera interaction", () => {
    expect(resolveHomeBaseCameraIntent({
      periods: [CURRENT_HOME],
      effectiveDate: CURRENT_DATE,
      atlasIsFresh: true,
      hasManualCameraInteraction: true,
      selectedJourneyId: null,
    })).toBeNull();
  });

  it("yields camera ownership whenever a Journey is selected", () => {
    expect(resolveHomeBaseCameraIntent({
      periods: [CURRENT_HOME],
      effectiveDate: CURRENT_DATE,
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: "journey-1",
    })).toBeNull();
  });

  it("does not center a period outside the effective date or a non-fresh Atlas", () => {
    expect(resolveHomeBaseCameraIntent({
      periods: [{ ...CURRENT_HOME, endedOn: "2026-08-01" }],
      effectiveDate: CURRENT_DATE,
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: null,
    })).toBeNull();
    expect(resolveHomeBaseCameraIntent({
      periods: [CURRENT_HOME],
      effectiveDate: CURRENT_DATE,
      atlasIsFresh: false,
      hasManualCameraInteraction: false,
      selectedJourneyId: null,
    })).toBeNull();
  });
});
