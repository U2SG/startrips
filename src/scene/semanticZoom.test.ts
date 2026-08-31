import { describe, expect, it } from "vitest";
import { resolveGlobeSemanticZoom, resolveGlobeSemanticZoomForFrame } from "./semanticZoom";

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
});
