import { describe, expect, it } from "vitest";
import { EARTH_DIVE_BLEND_ENTER_PROGRESS } from "./earthDive";
import { latLonToVector3 } from "./geo";
import {
  GLOBE_SEMANTIC_ZOOM_CEILING,
  GLOBE_SEMANTIC_ZOOM_FLOOR,
  LOCAL_BAND_ENTRY_ZOOM,
  resolveGlobeSemanticZoom,
} from "./semanticZoom";
import { GLOBE_WHEEL_NOTCH_DELTA_Y, GLOBE_WHEEL_ZOOM_SPEED } from "./globePointerIntent";
import {
  DAY_NIGHT_DIVE_HARD_RELEASE_PROGRESS,
  DAY_NIGHT_DIVE_RELEASE_PROGRESS,
  DAY_NIGHT_FADE_END_ZOOM,
  DAY_NIGHT_FADE_START_ZOOM,
  DAY_NIGHT_NIGHT_BRIGHTNESS,
  dayNightBrightness,
  dayNightDiveCap,
  dayNightModeWeight,
  dayNightZoomFade,
  parseSunTimeOverride,
  subsolarPoint,
  sunDirectionAt,
} from "./sunPosition";

const at = (iso: string) => subsolarPoint(new Date(iso));

describe("subsolar point", () => {
  it("sits on the equator near Greenwich at the March equinox noon", () => {
    // 2026-03-20 14:46 UTC equinox. Noon UTC is 0.11 days earlier, and the
    // equation of time (about -7.5 min) puts the sun ~1.9° east of Greenwich.
    const point = at("2026-03-20T12:00:00Z");
    expect(Math.abs(point.lat)).toBeLessThan(1);
    expect(point.lon).toBeGreaterThan(1);
    expect(point.lon).toBeLessThan(3);
  });

  it.each([
    "2026-04-15T12:00:00Z",
    "2026-06-13T12:00:00Z",
    "2026-09-01T12:00:00Z",
    "2026-12-25T12:00:00Z",
  ])("is over Greenwich at noon UTC when the equation of time is near zero (%s)", (iso) => {
    expect(Math.abs(at(iso).lon)).toBeLessThan(1);
  });

  it("reaches the tropics at the solstices", () => {
    expect(at("2026-06-21T08:24:00Z").lat).toBeCloseTo(23.44, 1);
    expect(at("2026-12-21T20:50:00Z").lat).toBeCloseTo(-23.44, 1);
  });

  it("moves west 15° per hour", () => {
    const noon = at("2026-06-21T12:00:00Z").lon;
    const later = at("2026-06-21T18:00:00Z").lon;
    expect(noon - later).toBeCloseTo(90, 0);
  });

  it("returns a unit direction through the canonical projection", () => {
    const date = new Date("2026-06-21T12:00:00Z");
    const { lat, lon } = subsolarPoint(date);
    const direction = sunDirectionAt(date);
    expect(direction.length()).toBeCloseTo(1, 10);
    expect(direction.distanceTo(latLonToVector3(lat, lon, 1))).toBeLessThan(1e-12);
  });
});

describe("day/night controls", () => {
  it("pins the clock only for a valid sunTime", () => {
    expect(parseSunTimeOverride("?dayNight=1&sunTime=2026-06-21T12:00:00Z")?.toISOString())
      .toBe("2026-06-21T12:00:00.000Z");
    expect(parseSunTimeOverride("?dayNight=1&sunTime=not-a-date")).toBeNull();
    expect(parseSunTimeOverride("?dayNight=1")).toBeNull();
  });

  it("is active on the particle globe modes and off on Surface Earth", () => {
    expect(dayNightModeWeight("particleSphere")).toBe(1);
    expect(dayNightModeWeight("focusPoint")).toBe(1);
    expect(dayNightModeWeight("archiveBurst")).toBe(1);
    expect(dayNightModeWeight("surfaceEarth")).toBe(0);
  });

  const wheelNotch = Math.exp(GLOBE_WHEEL_NOTCH_DELTA_Y * GLOBE_WHEEL_ZOOM_SPEED);

  it("fades continuously in zoom, including across the local band entry", () => {
    // Linear in log zoom: the steepest slope is at the fade start, and any
    // jump across an edge must shrink with the step (slope * 2ε), never a
    // fixed amount.
    const maxSlope = 1 / (
      DAY_NIGHT_FADE_START_ZOOM * Math.log(DAY_NIGHT_FADE_END_ZOOM / DAY_NIGHT_FADE_START_ZOOM)
    );
    const edges = [
      DAY_NIGHT_FADE_START_ZOOM,
      LOCAL_BAND_ENTRY_ZOOM,
      LOCAL_BAND_ENTRY_ZOOM + 0.08, // where `local` actually opens (hysteresis)
      DAY_NIGHT_FADE_END_ZOOM,
    ];
    for (const edge of edges) {
      for (const epsilon of [1e-2, 1e-4, 1e-6]) {
        const jump = Math.abs(dayNightZoomFade(edge - epsilon) - dayNightZoomFade(edge + epsilon));
        expect(jump).toBeLessThanOrEqual(maxSlope * 2 * epsilon + 1e-12);
      }
    }
    expect(dayNightZoomFade(GLOBE_SEMANTIC_ZOOM_FLOOR)).toBe(1);
    expect(dayNightZoomFade(DAY_NIGHT_FADE_START_ZOOM)).toBe(1);
    expect(dayNightZoomFade(DAY_NIGHT_FADE_END_ZOOM)).toBe(0);
    // Regression: the first `local` frame (zoom 2.63, localProgress ~0.178)
    // used to drop the strength from 1 to ~0.51 in one frame. Both sides of
    // that opening now read the same value.
    const opened = resolveGlobeSemanticZoom({ zoom: 2.63, previous: "regional" }).snapshot;
    expect(opened.level).toBe("local");
    expect(opened.localProgress).toBeGreaterThan(0.17);
    const justBefore = resolveGlobeSemanticZoom({ zoom: 2.6299, previous: "regional" }).snapshot;
    expect(justBefore.level).toBe("regional");
    expect(Math.abs(dayNightZoomFade(justBefore.zoom) - dayNightZoomFade(opened.zoom)))
      .toBeLessThanOrEqual(maxSlope * 2e-4);
  });

  it("spans at least three standard wheel notches, each removing at most a third", () => {
    let zoom = DAY_NIGHT_FADE_START_ZOOM;
    let notches = 0;
    let previous = dayNightZoomFade(zoom);
    while (dayNightZoomFade(zoom) > 0 && notches < 20) {
      zoom *= wheelNotch;
      notches += 1;
      const next = dayNightZoomFade(zoom);
      expect(previous - next).toBeLessThanOrEqual(1 / 3 + 1e-9);
      previous = next;
    }
    expect(notches).toBeGreaterThanOrEqual(3);
  });

  it("caps the strength at 0 before the Dive blend without binding during the fade", () => {
    expect(DAY_NIGHT_DIVE_RELEASE_PROGRESS).toBeLessThan(DAY_NIGHT_DIVE_HARD_RELEASE_PROGRESS);
    expect(DAY_NIGHT_DIVE_HARD_RELEASE_PROGRESS).toBeLessThan(EARTH_DIVE_BLEND_ENTER_PROGRESS);
    for (let zoom = GLOBE_SEMANTIC_ZOOM_FLOOR; zoom <= GLOBE_SEMANTIC_ZOOM_CEILING; zoom += 0.005) {
      // While the eased fade still has a non-zero target, the cap stays out of the way.
      if (dayNightZoomFade(zoom) > 0) expect(dayNightDiveCap(zoom)).toBe(1);
      const snapshot = resolveGlobeSemanticZoom({ zoom, previous: "local" }).snapshot;
      if (snapshot.localProgress >= DAY_NIGHT_DIVE_HARD_RELEASE_PROGRESS) {
        expect(dayNightDiveCap(snapshot.zoom)).toBe(0);
      }
    }
    const blendZoom = LOCAL_BAND_ENTRY_ZOOM
      + EARTH_DIVE_BLEND_ENTER_PROGRESS * (GLOBE_SEMANTIC_ZOOM_CEILING - LOCAL_BAND_ENTRY_ZOOM);
    expect(dayNightDiveCap(blendZoom)).toBe(0);
    expect(dayNightDiveCap(GLOBE_SEMANTIC_ZOOM_CEILING)).toBe(0);
  });


  it("only darkens: day is exactly 1 and night never falls below the floor", () => {
    expect(dayNightBrightness(1, 1)).toBe(1);
    expect(dayNightBrightness(0.2, 1)).toBe(1);
    expect(dayNightBrightness(-1, 1)).toBeCloseTo(DAY_NIGHT_NIGHT_BRIGHTNESS, 10);
    expect(dayNightBrightness(-1, 0)).toBe(1);
    for (let dot = -1; dot <= 1; dot += 0.05) {
      const value = dayNightBrightness(dot, 1);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(DAY_NIGHT_NIGHT_BRIGHTNESS);
    }
  });
});
