import { describe, expect, it } from "vitest";
import {
  GLOBE_SEMANTIC_ZOOM_CEILING,
  GLOBE_SEMANTIC_ZOOM_FLOOR,
  LOCAL_BAND_ENTRY_ZOOM,
  SEMANTIC_ZOOM_RELEASE_ZOOM,
  localBandProgress,
  resolveGlobeSemanticZoom,
  resolveGlobeSemanticZoomForFrame,
} from "./semanticZoom";

describe("globe semantic zoom resolver", () => {
  it("reveals semantic detail monotonically from planet to local", () => {
    expect(resolveGlobeSemanticZoom({ zoom: 1 }).state).toBe("planet");
    expect(resolveGlobeSemanticZoom({ zoom: 1.4 }).state).toBe("macro");
    expect(resolveGlobeSemanticZoom({ zoom: 2.2 }).state).toBe("regional");
    expect(resolveGlobeSemanticZoom({ zoom: 2.8 }).state).toBe("local");
  });

  it("holds the previous band across small boundary oscillations", () => {
    const macro = resolveGlobeSemanticZoom({ zoom: 1.4, previous: "planet" });
    expect(macro.state).toBe("macro");
    expect(resolveGlobeSemanticZoom({ zoom: 1.25, previous: macro.state }).state).toBe("macro");
    expect(resolveGlobeSemanticZoom({ zoom: 1.21, previous: macro.state }).state).toBe("planet");
  });

  it("holds the full semantic snapshot until a focus flight reaches its destination", () => {
    const planet = resolveGlobeSemanticZoom({ zoom: 1 });
    const crossingMacro = resolveGlobeSemanticZoomForFrame({
      zoom: 1.6,
      current: planet,
      focusFlightActive: true,
    });
    const crossingRegional = resolveGlobeSemanticZoomForFrame({
      zoom: 2.3,
      current: crossingMacro,
      focusFlightActive: true,
    });
    expect(crossingMacro).toBe(planet);
    expect(crossingRegional).toBe(planet);
    expect(crossingRegional.cityTier).toBe("capitals");
    expect(crossingRegional.coastlineWeights).toEqual(planet.coastlineWeights);

    const arrived = resolveGlobeSemanticZoomForFrame({
      zoom: 2.8,
      current: crossingRegional,
      focusFlightActive: false,
    });
    expect(arrived.state).toBe("local");
    expect(arrived.cityTier).toBe("all");
    expect(arrived.coastlineLod).toBe("near");
  });

  it("maps semantic state to city tiers and caps expensive coastline detail on low quality", () => {
    expect(resolveGlobeSemanticZoom({ zoom: 1 }).cityTier).toBe("capitals");
    expect(resolveGlobeSemanticZoom({ zoom: 1.4 }).cityTier).toBe("prefectures");
    expect(resolveGlobeSemanticZoom({ zoom: 2.2 }).cityTier).toBe("all");
    const low = resolveGlobeSemanticZoom({ zoom: 2.8, qualityProfile: "low" });
    expect(low.coastlineWeights.near).toBe(0);
    expect(low.coastlineLod).toBe("mid");
  });

  // #252: the Dive consumes continuous progress from this authority, so the
  // snapshot is part of what this module publishes and its contract is
  // asserted here — the one place a zoom boundary or clamp value may appear.
  describe("published dive-progress snapshot", () => {
    it("carries the canonical clamped zoom alongside the band", () => {
      expect(resolveGlobeSemanticZoom({ zoom: 2.8 }).snapshot).toMatchObject({
        level: "local",
        zoom: 2.8,
      });
      expect(resolveGlobeSemanticZoom({ zoom: 99 }).snapshot.zoom)
        .toBe(GLOBE_SEMANTIC_ZOOM_CEILING);
      expect(resolveGlobeSemanticZoom({ zoom: -99 }).snapshot.zoom)
        .toBe(GLOBE_SEMANTIC_ZOOM_FLOOR);
    });

    it("reports zero progress at every band other than local", () => {
      for (const zoom of [GLOBE_SEMANTIC_ZOOM_FLOOR, 1, 1.4, 2.2, 2.5]) {
        const state = resolveGlobeSemanticZoom({ zoom });
        expect(state.snapshot.level).not.toBe("local");
        expect(state.snapshot.localProgress).toBe(0);
      }
    });

    it("is zero at the entry to the local band and one at the canonical maximum", () => {
      expect(localBandProgress(LOCAL_BAND_ENTRY_ZOOM)).toBe(0);
      expect(localBandProgress(GLOBE_SEMANTIC_ZOOM_CEILING)).toBe(1);
      expect(resolveGlobeSemanticZoom({ zoom: GLOBE_SEMANTIC_ZOOM_CEILING }).snapshot)
        .toMatchObject({ level: "local", localProgress: 1 });
    });

    it("clamps progress to [0,1] and never decreases as zoom increases", () => {
      let previous = -1;
      for (let zoom = GLOBE_SEMANTIC_ZOOM_FLOOR - 1; zoom <= GLOBE_SEMANTIC_ZOOM_CEILING + 1; zoom += 0.01) {
        const progress = localBandProgress(zoom);
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThanOrEqual(1);
        expect(progress).toBeGreaterThanOrEqual(previous);
        previous = progress;
      }
      expect(previous).toBe(1);
      expect(localBandProgress(Number.NaN)).toBe(0);
    });

    it("hands the camera back into regional rather than the local band it left", () => {
      // The release value exists so a detail owner can return the camera
      // without the band immediately re-entering `local` on the next frame.
      const released = resolveGlobeSemanticZoom({
        zoom: SEMANTIC_ZOOM_RELEASE_ZOOM,
        previous: "local",
      });
      expect(released.state).toBe("regional");
      expect(released.snapshot.localProgress).toBe(0);
    });
  });
});
