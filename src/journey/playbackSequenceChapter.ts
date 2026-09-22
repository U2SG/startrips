import { mediaStackNeighbors } from "./mediaStackMotion";
import { playbackMediaForPoint, routePointChapterDensity, type PlaybackStep } from "./journeyPlayback";
import type { Journey } from "./types";

export type PlaybackSequenceChapterPresentation = {
  pointIndex: number;
  mediaIndex: number;
  primaryAssetId: string;
  peekMediaIndexes: number[];
  peekAssetIds: string[];
};

/**
 * Declarative 4-9 media stack derived from the director-owned media beat.
 *
 * This helper deliberately owns no index, clock, seek, or animation lifecycle:
 * the PlaybackStep is the authority and the peeks are only a projection of the
 * canonical playback media order around that step. A newer step therefore
 * replaces the whole projection immediately, so a stale animation can never
 * select a different primary asset.
 */
export function playbackSequenceChapterPresentation(
  journey: Journey,
  step: PlaybackStep | undefined,
): PlaybackSequenceChapterPresentation | null {
  if (!step || step.kind !== "media") return null;
  if (routePointChapterDensity(journey, step.pointIndex) !== "sequence") return null;
  const media = playbackMediaForPoint(journey, step.pointIndex);
  const primary = media[step.mediaIndex];
  if (!primary) return null;
  const peekMediaIndexes = mediaStackNeighbors(step.mediaIndex, media.length, false);
  return {
    pointIndex: step.pointIndex,
    mediaIndex: step.mediaIndex,
    primaryAssetId: primary.id,
    peekMediaIndexes,
    peekAssetIds: peekMediaIndexes.map((index) => media[index]?.id).filter((id): id is string => Boolean(id)),
  };
}
