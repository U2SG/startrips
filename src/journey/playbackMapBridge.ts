import { playbackMediaForPoint, routePointChapterDensity, type PlaybackStep, type RoutePointChapterDensity } from "./journeyPlayback";
import type { Journey } from "./types";

export type PlaybackMapBridgeBoundary = {
  direction: "map-to-media" | "media-to-map";
  pointIndex: number;
  density: RoutePointChapterDensity;
};
export type PlaybackBridgeRect = { left: number; top: number; width: number; height: number };
export type PlaybackMapBridge = PlaybackMapBridgeBoundary & {
  spatial: boolean;
  from: { transform: string; opacity: number };
  to: { transform: string; opacity: number };
};

/** Only the director's consecutive, natural chapter seams qualify. */
export function playbackMapBridgeBoundary(
  journey: Journey, previous: PlaybackStep | undefined, next: PlaybackStep | undefined,
): PlaybackMapBridgeBoundary | null {
  if (!previous || !next) return null;
  let direction: PlaybackMapBridgeBoundary["direction"];
  let pointIndex: number;
  if (previous.kind === "stop" && next.kind === "media"
    && previous.pointIndex === next.pointIndex && next.mediaIndex === 0) {
    direction = "map-to-media";
    pointIndex = next.pointIndex;
  } else if (previous.kind === "media" && (
    (next.kind === "travel" && next.to === previous.pointIndex + 1)
    || (next.kind === "stop" && next.pointIndex === previous.pointIndex + 1)
    || next.kind === "outro" || next.kind === "home-epilogue"
  )) {
    pointIndex = previous.pointIndex;
    if (previous.mediaIndex !== playbackMediaForPoint(journey, pointIndex).length - 1) return null;
    direction = "media-to-map";
  } else return null;
  const density = routePointChapterDensity(journey, pointIndex);
  // #492: a sequence is still one Route Point chapter, so it keeps the
  // existing place -> first media / last media -> place bridge at its chapter
  // edges. Only adjacent media stay quiet. The 10+ dense grammar is a later
  // slice and keeps the pre-#492 no-bridge fallback for now.
  if (density === "empty" || playbackMediaForPoint(journey, pointIndex).length > 9) return null;
  return { direction, pointIndex, density };
}

function usable(rect: PlaybackBridgeRect | null): rect is PlaybackBridgeRect {
  return !!rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

/** Pure place/media geometry policy. No clock, transport, DOM or ownership. */
export function resolvePlaybackMapBridge(input: {
  boundary: PlaybackMapBridgeBoundary;
  place: PlaybackBridgeRect | null;
  media: PlaybackBridgeRect | null;
  reduceMotion: boolean;
}): PlaybackMapBridge {
  const { boundary, place, media, reduceMotion } = input;
  const to = { transform: "translate3d(0px, 0px, 0px) scale(1)", opacity: 1 };
  if (reduceMotion || !usable(place) || !usable(media)) {
    return { ...boundary, spatial: false, from: to, to };
  }
  const sign = boundary.direction === "map-to-media" ? 1 : -1;
  // A restrained spatial hint between the actual place and media apertures.
  // Neither density adds a carousel, extra beat, or per-asset delay.
  const dx = Math.max(-48, Math.min(48, (place.left + place.width / 2 - media.left - media.width / 2) * 0.12)) * sign;
  const dy = Math.max(-48, Math.min(48, (place.top + place.height / 2 - media.top - media.height / 2) * 0.12)) * sign;
  return { ...boundary, spatial: true, from: {
    transform: `translate3d(${dx}px, ${dy}px, 0px) scale(0.96)`, opacity: 0.84,
  }, to };
}
