import type { Vector3 } from "three";
import { EARTH_DIVE_BLEND_ENTER_PROGRESS } from "./earthDive";
import { latLonToVector3 } from "./geo";
import type { GlobeMode } from "./globeMode";

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
/** Local-band progress at which day/night has fully released the Dive. */
export const DAY_NIGHT_DIVE_RELEASE_PROGRESS = EARTH_DIVE_BLEND_ENTER_PROGRESS * 0.8;

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
 * Mode target, eased by the caller. Surface Earth never shows day/night, and
 * an Earth Dive overlap (including the keyboard Dive, which has no local-band
 * progress) fades it out under the full-frame crossfade.
 */
export function dayNightModeWeight(mode: GlobeMode, earthDiveOverlapActive: boolean) {
  return mode === "surfaceEarth" || earthDiveOverlapActive ? 0 : 1;
}

/**
 * Applied without easing: local-band progress is already smoothed zoom, so the
 * strength is exactly 0 on every frame past the release point and no
 * terminator can sweep across the reveal anchor into the detail map.
 */
export function dayNightDiveFactor(localProgress: number) {
  return 1 - clamp01(localProgress / DAY_NIGHT_DIVE_RELEASE_PROGRESS);
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
