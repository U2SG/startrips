import { describe, expect, it } from "vitest";
import {
  AMAP_RASTER_STYLE,
  DETAILED_EARTH_FALLBACK_CENTER,
  DETAILED_EARTH_HANDOFF_SEED_ZOOM,
  clampDetailedEarthZoom,
  detailedEarthAnchorCorrection,
  getEarthDiveHandoffFrame,
  solveDetailedEarthHandoffZoom,
  createDetailedEarthLabelExpression,
  DEFAULT_DETAILED_EARTH_STYLE_URL,
  DETAILED_EARTH_DRAG_PAN_OPTIONS,
  DETAILED_EARTH_BEARING_PER_PIXEL,
  DETAILED_EARTH_PITCH_PER_PIXEL,
  DETAILED_EARTH_INITIAL_ZOOM,
  DETAILED_EARTH_MAX_PITCH,
  DETAILED_EARTH_MAX_ZOOM,
  DETAILED_EARTH_MIN_ZOOM,
  DETAILED_EARTH_RETURN_ZOOM,
  DETAILED_EARTH_TOUCH_ZOOM_RATE,
  DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD,
  getDetailedEarthStyle,
  getDetailedEarthDragRotation,
  getDetailedEarthRouteFrame,
  getDetailedEarthFocusDuration,
  clampDetailedEarthPitch,
  isDetailedEarthNameLabel,
  isRasterDetailedEarth,
  shouldReturnToParticleEarth,
  useGlobeProjection,
} from "./detailedEarthModel";
import type { ParticleAnchorFrame } from "./detailedEarthModel";
import type { SemanticZoomSnapshot } from "./semanticZoom";

describe("detailedEarthModel", () => {
  it("uses a provider-neutral vector style by default", () => {
    expect(getDetailedEarthStyle()).toBe(DEFAULT_DETAILED_EARTH_STYLE_URL);
    expect(isRasterDetailedEarth()).toBe(false);
    expect(useGlobeProjection()).toBe(true);
  });

  it("keeps globe projection for vector providers but not raster tiles", () => {
    const original = import.meta.env.VITE_ATLAS_MAP_STYLE_URL;
    try {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = AMAP_RASTER_STYLE;
      expect(useGlobeProjection()).toBe(false);
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL =
        "https://startrips.example/api/mapstyle?path=styles%2Ffiord";
      expect(useGlobeProjection()).toBe(true);
    } finally {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = original;
    }
  });

  it("switches to the built-in AMap raster style through the sentinel", () => {
    const original = import.meta.env.VITE_ATLAS_MAP_STYLE_URL;
    try {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = AMAP_RASTER_STYLE;
      expect(isRasterDetailedEarth()).toBe(true);
      const style = getDetailedEarthStyle();
      expect(typeof style).toBe("object");
      const spec = style as { sources: Record<string, { type: string; maxzoom?: number }> };
      expect(spec.sources.amap.type).toBe("raster");
      expect(spec.sources.amap.maxzoom).toBe(18);
    } finally {
      import.meta.env.VITE_ATLAS_MAP_STYLE_URL = original;
    }
  });

  it("prefers simplified Chinese labels and offers an English second line", () => {
    const chineseExpression = createDetailedEarthLabelExpression("zh") as unknown[];
    expect(chineseExpression).toEqual(expect.arrayContaining([
      "coalesce",
      ["get", "name:zh-Hans"],
      ["get", "name:zh"],
    ]));
    expect(chineseExpression[3]).toEqual(["get", "name:nonlatin"]);
    expect(createDetailedEarthLabelExpression("bilingual")).toEqual(expect.arrayContaining([
      "format",
    ]));
  });

  it("only replaces map labels backed by name fields", () => {
    expect(isDetailedEarthNameLabel(["get", "name:nonlatin"])).toBe(true);
    expect(isDetailedEarthNameLabel(["to-string", ["get", "ref"]])).toBe(false);
  });

  it("returns from the regional map before it expands into a world map", () => {
    expect(DETAILED_EARTH_MIN_ZOOM).toBeLessThan(DETAILED_EARTH_RETURN_ZOOM);
    expect(DETAILED_EARTH_INITIAL_ZOOM).toBeGreaterThan(DETAILED_EARTH_RETURN_ZOOM);
    expect(shouldReturnToParticleEarth(DETAILED_EARTH_RETURN_ZOOM + 0.01)).toBe(false);
    expect(shouldReturnToParticleEarth(DETAILED_EARTH_RETURN_ZOOM)).toBe(true);
  });

  it("keeps detailed-map interaction available and reaches polar views", () => {
    expect(DETAILED_EARTH_MAX_ZOOM).toBeGreaterThan(DETAILED_EARTH_INITIAL_ZOOM);
    expect(DETAILED_EARTH_MAX_PITCH).toBeGreaterThan(0);
    expect(DETAILED_EARTH_MAX_PITCH).toBe(85);
    expect(clampDetailedEarthPitch(-10)).toBe(0);
    expect(clampDetailedEarthPitch(DETAILED_EARTH_MAX_PITCH + 10))
      .toBe(DETAILED_EARTH_MAX_PITCH);
    expect(getDetailedEarthDragRotation(0, 0, 10, 20)).toEqual({
      bearing: -10 * DETAILED_EARTH_BEARING_PER_PIXEL,
      pitch: 20 * DETAILED_EARTH_PITCH_PER_PIXEL,
    });
    expect(getDetailedEarthDragRotation(360, 80, -10, 100).bearing).toBe(360 + 10 * DETAILED_EARTH_BEARING_PER_PIXEL);
    expect(DETAILED_EARTH_TOUCH_ZOOM_RATE).toBeLessThan(1);
    expect(DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD).toBeGreaterThan(0.1);
    expect(DETAILED_EARTH_DRAG_PAN_OPTIONS.linearity).toBeLessThan(0.3);
    expect(DETAILED_EARTH_DRAG_PAN_OPTIONS.maxSpeed).toBeLessThan(1_400);
  });
});


describe("detailed-earth route framing", () => {
  it("frames all route points instead of reducing a Journey to one midpoint", () => {
    const frame = getDetailedEarthRouteFrame([
      { lat: 22.54, lon: 114.05 },
      { lat: 31.23, lon: 121.47 },
      { lat: 35.68, lon: 139.69 },
    ]);
    expect(frame).not.toBeNull();
    expect(frame!.bounds[0][0]).toBeCloseTo(114.05);
    expect(frame!.bounds[1][0]).toBeCloseTo(139.69);
    expect(frame!.bounds[0][1]).toBeCloseTo(22.54);
    expect(frame!.bounds[1][1]).toBeCloseTo(35.68);
    expect(frame!.pointCount).toBe(3);
  });

  it("keeps antimeridian routes in a narrow unwrapped longitude interval", () => {
    const frame = getDetailedEarthRouteFrame([
      { lat: 10, lon: 179 },
      { lat: 12, lon: -179 },
    ]);
    expect(frame).not.toBeNull();
    expect(frame!.bounds[1][0] - frame!.bounds[0][0]).toBeCloseTo(2);
    expect(Math.abs(frame!.center[0])).toBeGreaterThan(179);
  });

  it("ignores invalid points and returns null when no route geometry remains", () => {
    expect(getDetailedEarthRouteFrame([{ lat: Number.NaN, lon: 20 }])).toBeNull();
  });
});


describe("getDetailedEarthFocusDuration", () => {
  it("keeps distance-aware playback pacing distinct in detail mode", () => {
    expect(getDetailedEarthFocusDuration("nearby")).toBeLessThan(
      getDetailedEarthFocusDuration("regional"),
    );
    expect(getDetailedEarthFocusDuration("long-haul")).toBeGreaterThan(
      getDetailedEarthFocusDuration("regional"),
    );
    expect(getDetailedEarthFocusDuration(undefined)).toBe(900);
  });
});

describe("getEarthDiveHandoffFrame", () => {
  const focusPoint = { lat: 22.3193, lon: 114.1694 };
  const at = (localProgress: number): SemanticZoomSnapshot => ({
    level: localProgress > 0 ? "local" : "regional",
    zoom: Number.NaN,
    localProgress,
  });

  it("frames the particle focus rather than a fixed mount position", () => {
    const frame = getEarthDiveHandoffFrame({
      stage: "prewarm",
      snapshot: at(0),
      focusPoint,
    });
    expect(frame?.center).toEqual([focusPoint.lon, focusPoint.lat]);
  });

  it("has no frame at all before the dive mounts a map", () => {
    expect(getEarthDiveHandoffFrame({
      stage: "particle",
      snapshot: at(1),
      focusPoint,
    })).toBeNull();
  });

  it("keeps the frame identical across the blending -> detail handoff", () => {
    // #252 section 2: nothing about the framing may change as the map becomes
    // visible and then takes ownership, because that is exactly what would move
    // the focused Route Point on screen.
    for (const localProgress of [0, 0.45, 0.8, 1]) {
      const snapshot = at(localProgress);
      const prewarm = getEarthDiveHandoffFrame({ stage: "prewarm", snapshot, focusPoint });
      const blending = getEarthDiveHandoffFrame({ stage: "blending", snapshot, focusPoint });
      const detail = getEarthDiveHandoffFrame({ stage: "detail", snapshot, focusPoint });
      expect(blending).toEqual(prewarm);
      expect(detail).toEqual(blending);
    }
  });

  it("seeds the calibration monotonically and never below the return threshold", () => {
    // The seed is not a promise about scale - the solver overrides it from a
    // measurement - but a seed that already leans the right way converges in
    // fewer measurements, and a seed at or under the return threshold would
    // make a freshly mounted map ask to go home before it was ever calibrated.
    let previous = -1;
    for (let localProgress = 0; localProgress <= 1.0001; localProgress += 0.05) {
      const frame = getEarthDiveHandoffFrame({
        stage: "blending",
        snapshot: at(localProgress),
        focusPoint,
      });
      expect(frame?.zoom).toBeGreaterThan(previous);
      expect(shouldReturnToParticleEarth(frame?.zoom ?? 0)).toBe(false);
      previous = frame?.zoom ?? Number.NaN;
    }
    expect(getEarthDiveHandoffFrame({ stage: "blending", snapshot: at(0), focusPoint })?.zoom)
      .toBe(DETAILED_EARTH_HANDOFF_SEED_ZOOM);
    expect(DETAILED_EARTH_HANDOFF_SEED_ZOOM).toBeGreaterThan(DETAILED_EARTH_RETURN_ZOOM);
    expect(DETAILED_EARTH_RETURN_ZOOM).toBeGreaterThan(DETAILED_EARTH_MIN_ZOOM);
  });

  it("takes the anchor from the particle frame when the particle side has published one", () => {
    const particleFrame: ParticleAnchorFrame = {
      anchor: { lat: 35.6812, lon: 139.7671 },
      screen: { x: 640, y: 430 },
      pxPerDegreeLat: 48.2,
    };
    const frame = getEarthDiveHandoffFrame({
      stage: "blending",
      snapshot: at(0.5),
      focusPoint,
      routePoints: [{ lat: 10, lon: 100 }, { lat: 20, lon: 110 }],
      particleFrame,
    });
    // The place the particle Earth is actually holding outranks both the route
    // frame and the focus prop: those are intents, this is what is on screen.
    expect(frame?.center).toEqual([particleFrame.anchor.lon, particleFrame.anchor.lat]);
    expect(frame?.screen).toEqual(particleFrame.screen);
    expect(getEarthDiveHandoffFrame({ stage: "blending", snapshot: at(0.5), focusPoint })?.screen)
      .toBeNull();
  });

  it("prefers the Journey route frame over a single focus point", () => {
    const frame = getEarthDiveHandoffFrame({
      stage: "blending",
      snapshot: at(0.5),
      focusPoint,
      routePoints: [{ lat: 10, lon: 100 }, { lat: 20, lon: 110 }],
    });
    expect(frame?.center).toEqual([105, 15]);
  });

  it("falls back to the product default when there is no focus at all", () => {
    expect(getEarthDiveHandoffFrame({ stage: "prewarm", snapshot: at(0) })?.center)
      .toEqual(DETAILED_EARTH_FALLBACK_CENTER);
    expect(getEarthDiveHandoffFrame({
      stage: "prewarm",
      snapshot: at(0),
      focusPoint: { lat: Number.NaN, lon: 114 },
    })?.center).toEqual(DETAILED_EARTH_FALLBACK_CENTER);
  });
});

describe("solveDetailedEarthHandoffZoom", () => {
  it("answers the zoom whose local scale equals the particle Earth's", () => {
    // MapLibre's scale is exponential in zoom, so a factor of two in pixels per
    // degree is exactly one zoom level, whichever level the measurement was
    // taken at.
    // The fixtures stay inside the map's own zoom range, so what is asserted
    // is the solve and not the clamp.
    expect(solveDetailedEarthHandoffZoom({
      measuredZoom: 7,
      measuredPxPerDegreeLat: 100,
      targetPxPerDegreeLat: 200,
    })).toBeCloseTo(8, 10);
    expect(solveDetailedEarthHandoffZoom({
      measuredZoom: 7,
      measuredPxPerDegreeLat: 100,
      targetPxPerDegreeLat: 50,
    })).toBeCloseTo(6, 10);
  });

  it("is a fixed point once the two renderers already agree", () => {
    // This is what makes the measure-correct-measure loop safe to bound: a
    // second pass over an exact answer moves nothing.
    const solved = solveDetailedEarthHandoffZoom({
      measuredZoom: 6.75,
      measuredPxPerDegreeLat: 111.4,
      targetPxPerDegreeLat: 111.4,
    });
    expect(solved).toBe(6.75);
  });

  it("stays inside the map's own zoom limits and survives a useless measurement", () => {
    expect(solveDetailedEarthHandoffZoom({
      measuredZoom: 7,
      measuredPxPerDegreeLat: 100,
      targetPxPerDegreeLat: 100_000_000,
    })).toBe(DETAILED_EARTH_MAX_ZOOM);
    expect(solveDetailedEarthHandoffZoom({
      measuredZoom: 7,
      measuredPxPerDegreeLat: 100,
      targetPxPerDegreeLat: 0.000_001,
    })).toBe(DETAILED_EARTH_MIN_ZOOM);
    for (const measuredPxPerDegreeLat of [0, -1, Number.NaN]) {
      expect(solveDetailedEarthHandoffZoom({
        measuredZoom: 7,
        measuredPxPerDegreeLat,
        targetPxPerDegreeLat: 111.4,
      })).toBe(7);
    }
    expect(clampDetailedEarthZoom(Number.NaN)).toBe(DETAILED_EARTH_HANDOFF_SEED_ZOOM);
  });

  it("corrects the map centre by the pixels the anchor is away from its target", () => {
    expect(detailedEarthAnchorCorrection({ x: 700, y: 500 }, { x: 640, y: 430 }))
      .toEqual({ x: 60, y: 70 });
    expect(detailedEarthAnchorCorrection({ x: 640, y: 430 }, { x: 640, y: 430 }))
      .toEqual({ x: 0, y: 0 });
  });
});
