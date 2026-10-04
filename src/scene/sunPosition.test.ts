import { describe, expect, it } from "vitest";
import { EARTH_DIVE_BLEND_ENTER_PROGRESS } from "./earthDive";
import { latLonToVector3 } from "./geo";
import {
  DAY_NIGHT_DIVE_RELEASE_PROGRESS,
  DAY_NIGHT_NIGHT_BRIGHTNESS,
  dayNightBrightness,
  dayNightDiveFactor,
  dayNightModeWeight,
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

  it("is active on the particle globe modes and off on Surface Earth or a Dive overlap", () => {
    expect(dayNightModeWeight("particleSphere", false)).toBe(1);
    expect(dayNightModeWeight("focusPoint", false)).toBe(1);
    expect(dayNightModeWeight("archiveBurst", false)).toBe(1);
    expect(dayNightModeWeight("surfaceEarth", false)).toBe(0);
    expect(dayNightModeWeight("particleSphere", true)).toBe(0);
  });

  it("releases the Dive before the blend starts", () => {
    expect(dayNightDiveFactor(0)).toBe(1);
    expect(dayNightDiveFactor(DAY_NIGHT_DIVE_RELEASE_PROGRESS)).toBe(0);
    expect(DAY_NIGHT_DIVE_RELEASE_PROGRESS).toBeLessThan(EARTH_DIVE_BLEND_ENTER_PROGRESS);
    expect(dayNightDiveFactor(EARTH_DIVE_BLEND_ENTER_PROGRESS)).toBe(0);
    expect(dayNightDiveFactor(1)).toBe(0);
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
