import { mediaStackNeighbors } from "./mediaStackMotion";
import {
  playbackMediaForPoint,
  routePointChapterDensity,
  type PlaybackStep,
  type RoutePointChapterDensity,
} from "./journeyPlayback";
import type { Journey } from "./types";

export type PlaybackSequenceChapterPresentation = {
  density: Extract<RoutePointChapterDensity, "sequence" | "dense">;
  pointIndex: number;
  mediaIndex: number;
  position: number;
  total: number;
  canPrevious: boolean;
  canNext: boolean;
  primaryAssetId: string;
  peekMediaIndexes: number[];
  peekAssetIds: string[];
};

/**
 * Declarative bounded sequence/dense stack derived from the director-owned
 * media beat.
 *
 * This helper deliberately owns no index, clock, seek, or animation lifecycle:
 * the PlaybackStep is the authority and the peeks are only a projection of the
 * canonical playback media order around that step. Dense chapters therefore
 * keep the same constant two-neighbour DOM budget even when the chapter has
 * dozens of assets. A newer step replaces the projection immediately, so a
 * stale animation can never select a different primary asset.
 */
export function playbackSequenceChapterPresentation(
  journey: Journey,
  step: PlaybackStep | undefined,
): PlaybackSequenceChapterPresentation | null {
  if (!step || step.kind !== "media") return null;
  const density = routePointChapterDensity(journey, step.pointIndex);
  if (density !== "sequence" && density !== "dense") return null;
  const media = playbackMediaForPoint(journey, step.pointIndex);
  const primary = media[step.mediaIndex];
  if (!primary) return null;
  const peekMediaIndexes = mediaStackNeighbors(step.mediaIndex, media.length, false);
  return {
    density,
    pointIndex: step.pointIndex,
    mediaIndex: step.mediaIndex,
    position: step.mediaIndex + 1,
    total: media.length,
    canPrevious: step.mediaIndex > 0,
    canNext: step.mediaIndex + 1 < media.length,
    primaryAssetId: primary.id,
    peekMediaIndexes,
    peekAssetIds: peekMediaIndexes.map((index) => media[index]?.id).filter((id): id is string => Boolean(id)),
  };
}
