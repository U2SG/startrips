import type { Vector3 } from "three";
import { EARTH_DIVE_BLEND_ENTER_PROGRESS } from "./earthDive";
import { latLonToVector3 } from "./geo";
import type { GlobeMode } from "./globeMode";
import { GLOBE_WHEEL_NOTCH_DELTA_Y, GLOBE_WHEEL_ZOOM_SPEED } from "./globePointerIntent";
import {
  GLOBE_SEMANTIC_ZOOM_CEILING,
  LOCAL_BAND_ENTRY_ZOOM,
  localBandProgress,
} from "./semanticZoom";

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
const J2000_UNIX_DAYS = 10_957.5; // 2000-01-01T12:00:00Z in days since the Unix epoch.

/** Night-side particle brightness. Day side stays exactly 1 (darken only). */
export const DAY_NIGHT_NIGHT_BRIGHTNESS = 0.6;
/** Night-side share of the atmosphere rim; the day-side peak stays unchanged. */
export const DAY_NIGHT_ATMOSPHERE_NIGHT_WEIGHT = 0.55;
/** Terminator band in dot(surfaceNormal, sunDirection), shared with the shader. */
export const DAY_NIGHT_TERMINATOR_START = -0.12;
export const DAY_NIGHT_TERMINATOR_END = 0.1;
/** Real time only: the terminator moves 0.25° per minute, so no interpolation. */
export const DAY_NIGHT_REFRESH_MS = 60_000;
/** Local-band progress at which the eased zoom fade targets 0. */
export const DAY_NIGHT_DIVE_RELEASE_PROGRESS = EARTH_DIVE_BLEND_ENTER_PROGRESS * 0.8;
/** Local-band progress at which the un-eased cap is 0, still before the blend. */
export const DAY_NIGHT_DIVE_HARD_RELEASE_PROGRESS = EARTH_DIVE_BLEND_ENTER_PROGRESS - 0.01;
/**
 * Wheel zoom is multiplicative and unsmoothed, so the fade is measured in log
 * zoom and spans this many standard wheel notches; easing then smooths each one.
 */
export const DAY_NIGHT_FADE_WHEEL_NOTCHES = 3;
const LOCAL_BAND_SPAN = GLOBE_SEMANTIC_ZOOM_CEILING - LOCAL_BAND_ENTRY_ZOOM;
export const DAY_NIGHT_FADE_END_ZOOM = LOCAL_BAND_ENTRY_ZOOM
  + DAY_NIGHT_DIVE_RELEASE_PROGRESS * LOCAL_BAND_SPAN;
export const DAY_NIGHT_FADE_START_ZOOM = DAY_NIGHT_FADE_END_ZOOM / Math.exp(
  DAY_NIGHT_FADE_WHEEL_NOTCHES * GLOBE_WHEEL_NOTCH_DELTA_Y * GLOBE_WHEEL_ZOOM_SPEED,
);

export type SubsolarPoint = { lat: number; lon: number };

function wrapDegrees180(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Standard low-precision solar position (Astronomical Almanac, ~0.01° in
 * declination for 1950-2050): declination from the apparent ecliptic
 * longitude, longitude from UTC plus the equation of time.
 */
export function subsolarPoint(date: Date): SubsolarPoint {
  const ms = date.getTime();
  const days = ms / MS_PER_DAY - J2000_UNIX_DAYS;
  const meanLongitude = 280.46 + 0.9856474 * days;
  const meanAnomaly = (357.528 + 0.9856003 * days) * DEG;
  const eclipticLongitude = (meanLongitude
    + 1.915 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.0000004 * days) * DEG;
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  ) / DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude)) / DEG;
  // Apparent minus mean solar time, in degrees of Earth rotation.
  const equationOfTime = wrapDegrees180(meanLongitude - rightAscension);
  const utcHours = (((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 3_600_000;
  return {
    lat: declination,
    lon: wrapDegrees180(15 * (12 - utcHours) - equationOfTime),
  };
}

/** Unit sun direction in globe-local space, via the canonical projection. */
export function sunDirectionAt(date: Date, target?: Vector3): Vector3 {
  const { lat, lon } = subsolarPoint(date);
  const direction = latLonToVector3(lat, lon, 1);
  return target ? target.copy(direction) : direction;
}

/** `?sunTime=<ISO>` pins the clock for reproducible captures; invalid input is ignored. */
export function parseSunTimeOverride(search: string): Date | null {
  const raw = new URLSearchParams(search).get("sunTime");
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Mode target, eased by the caller. Surface Earth never shows day/night. The
 * Dive overlap hint is deliberately not used: it is already true during the
 * regional prewarm, and the keyboard Dive is a full-frame crossfade with no
 * reveal anchor for a (static) terminator to sweep across.
 */
export function dayNightModeWeight(mode: GlobeMode) {
  return mode === "surfaceEarth" ? 0 : 1;
}

/**
 * Zoom fade target, eased by the caller. It reads the continuous canonical
 * zoom (the published `localProgress` opens with hysteresis at ~0.18 and would
 * pop) and is linear in log zoom, so every wheel notch removes the same share
 * and the 1 -> 0 fade spans DAY_NIGHT_FADE_WHEEL_NOTCHES notches.
 */
export function dayNightZoomFade(zoom: number) {
  if (!(zoom > DAY_NIGHT_FADE_START_ZOOM)) return 1;
  return 1 - clamp01(
    Math.log(zoom / DAY_NIGHT_FADE_START_ZOOM)
      / Math.log(DAY_NIGHT_FADE_END_ZOOM / DAY_NIGHT_FADE_START_ZOOM),
  );
}

/**
 * Un-eased ceiling for the eased strength. It is 1 until the fade target is
 * already 0, so it binds only when input outruns the easing, and it is exactly
 * 0 before the Dive blend can start: no terminator sweeps the reveal anchor.
 */
export function dayNightDiveCap(zoom: number) {
  return 1 - clamp01(
    (localBandProgress(zoom) - DAY_NIGHT_DIVE_RELEASE_PROGRESS)
      / (DAY_NIGHT_DIVE_HARD_RELEASE_PROGRESS - DAY_NIGHT_DIVE_RELEASE_PROGRESS),
  );
}

/** CPU mirror of the shader term: 0 on the day side, 1 deep on the night side. */
export function dayNightNightAmount(surfaceDotSun: number) {
  return 1 - smoothstep(DAY_NIGHT_TERMINATOR_START, DAY_NIGHT_TERMINATOR_END, surfaceDotSun);
}

/** Brightness multiplier for a point (or a view center) facing `surfaceDotSun`. */
export function dayNightBrightness(surfaceDotSun: number, strength: number) {
  const night = dayNightNightAmount(surfaceDotSun) * clamp01(strength);
  return 1 + (DAY_NIGHT_NIGHT_BRIGHTNESS - 1) * night;
}
