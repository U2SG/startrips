import type { RoutingCoordinate } from "./route-candidate-provider";

export const MAX_SELECTED_POINT_METERS = 25_000;

export function validRoutingCoordinate(value: unknown): value is RoutingCoordinate {
  if (!value || typeof value !== "object") return false;
  const point = value as RoutingCoordinate;
  return typeof point.lat === "number" && typeof point.lon === "number"
    && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

export function routingDistanceMeters(a: RoutingCoordinate, b: RoutingCoordinate): number {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 12_742_000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function compatibleRoutingStep(mode: unknown, profile: "driving" | "walking" | "cycling", allowFerries = false) {
  return mode === profile || (profile === "cycling" && mode === "pushing bike")
    || (allowFerries && mode === "ferry");
}
