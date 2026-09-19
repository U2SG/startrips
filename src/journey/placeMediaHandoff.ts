export type PlaceMediaRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PlaceMediaViewport = { width: number; height: number };

function finiteRect(rect: PlaceMediaRect) {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 1
    && rect.height > 1;
}

/**
 * Presentation-only geography -> media aperture. The Route Point remains the
 * semantic object; this small frame merely gives the same media asset a spatial
 * place to depart from / return to. It is measured from live viewport geometry
 * on every intent, never stored as an x/y business state.
 */
export function resolvePlaceMediaObservationRect(
  marker: PlaceMediaRect,
  media: PlaceMediaRect,
  viewport: PlaceMediaViewport,
  compact: boolean,
): PlaceMediaRect | null {
  if (!finiteRect(marker) || !finiteRect(media) || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const markerRight = marker.left + marker.width;
  const markerBottom = marker.top + marker.height;
  if (markerRight <= 0 || markerBottom <= 0 || marker.left >= viewport.width || marker.top >= viewport.height) {
    return null;
  }

  const margin = compact ? 10 : 12;
  const gap = compact ? 10 : 16;
  const maxWidth = compact ? 92 : 112;
  const width = Math.min(maxWidth, Math.max(72, media.width * 1.35));
  const aspect = media.width / media.height;
  const maxHeight = compact ? 78 : 90;
  const height = Math.min(maxHeight, width / Math.max(0.45, Math.min(2.4, aspect)));
  const centerX = marker.left + marker.width / 2;
  const centerY = marker.top + marker.height / 2;
  const preferRight = centerX < viewport.width * 0.58;
  const unclampedLeft = preferRight ? centerX + gap : centerX - gap - width;
  const left = Math.max(margin, Math.min(viewport.width - margin - width, unclampedLeft));
  const top = Math.max(margin, Math.min(viewport.height - margin - height, centerY - height / 2));
  return { left, top, width, height };
}

export type PlaceMediaLogicalObservation = {
  journeyId: string;
  routePointId: string | null;
} | null;

/**
 * The Story's latest logical observation owns the return place. The opening
 * Route Point is only a fallback for a Story that never emitted a newer
 * observation. Current Journey/model truth still gates the result; live marker
 * visibility is checked separately when the presentation target is measured.
 */
export function resolvePlaceMediaReturnRoutePointId(input: {
  storyJourneyId: string | null;
  activeJourneyId: string | null;
  observation: PlaceMediaLogicalObservation;
  openingRoutePointId: string | null;
  currentRoutePointIds: readonly string[];
}): string | null {
  if (!input.storyJourneyId || input.activeJourneyId !== input.storyJourneyId) return null;
  const observed = input.observation?.journeyId === input.storyJourneyId
    ? input.observation.routePointId
    : null;
  const candidate = observed ?? input.openingRoutePointId;
  if (!candidate || !input.currentRoutePointIds.includes(candidate)) return null;
  return candidate;
}

export type PlaceMediaMarkerCandidate<T> = {
  element: T;
  /** The marker has fully settled: painted, opaque and inside the viewport. */
  settled: boolean;
  rect: PlaceMediaRect;
};

/**
 * Pick the geographic anchor for one handoff aperture. A settled marker is
 * always preferred, but a marker that is merely mid-transition at the click
 * instant is still the same projected Route Point, so it anchors the aperture
 * rather than cancelling it. Viewport containment is NOT decided here:
 * resolvePlaceMediaObservationRect owns that predicate, so a relaxed anchor
 * never widens the published geometry contract. A degenerate rect carries no
 * usable geography and is refused.
 */
export function selectPlaceMediaMarkerAnchor<T>(
  candidates: readonly PlaceMediaMarkerCandidate<T>[],
): T | null {
  const usable = candidates.filter((candidate) => finiteRect(candidate.rect));
  return usable.find((candidate) => candidate.settled)?.element ?? usable[0]?.element ?? null;
}

export type PlaceMediaRepresentativeCandidate<T> = {
  element: T;
  assetId: string;
  /** The element already has a resolved source to paint from. */
  painted: boolean;
};

/**
 * Pick the representative visual for one asset. A painted element is preferred
 * because it can also supply the aperture's fill, but an element for the same
 * asset whose decode has not landed yet still carries the correct identity and
 * layout box, so it opens the aperture unpainted instead of suppressing it.
 */
export function selectPlaceMediaRepresentative<T>(
  candidates: readonly PlaceMediaRepresentativeCandidate<T>[],
  assetId: string,
): T | null {
  const matching = candidates.filter((candidate) => candidate.assetId === assetId);
  return matching.find((candidate) => candidate.painted)?.element ?? matching[0]?.element ?? null;
}
