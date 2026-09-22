import { journeyCover } from "./journeyModel";
import { playbackMediaWaitPolicy, storyMediaForScope, type PlaybackMediaAvailability } from "./journeyPlayback";
import type { Journey, JourneyMediaAsset } from "./types";

export type StoryLogicalObservation = {
  journeyId: string;
  routePointId: string | null;
  assetId: string | null;
  storySnapState: "in-context" | "expanded";
};

export function storyLogicalObservation(
  journey: Pick<Journey, "id" | "media">,
  selectedRoutePointId: string | null,
  assetId: string | null,
  mobileLayout: boolean,
  expanded: boolean,
): StoryLogicalObservation {
  const observedAsset = assetId === null
    ? null
    : journey.media.find((asset) => asset.id === assetId) ?? null;
  return {
    journeyId: journey.id,
    // Logical media identity owns its current Route Point association. This is
    // deliberately not the Story's DOM/page index: a moved asset follows its
    // current Journey model ownership, while an unavailable asset falls back
    // to the currently selected Story scope.
    routePointId: observedAsset?.routePointId ?? selectedRoutePointId,
    assetId: observedAsset?.id ?? null,
    storySnapState: mobileLayout && !expanded ? "in-context" : "expanded",
  };
}

export function mediaForRoutePoint(
  journey: Journey,
  routePointId: string | null,
) {
  return journey.media.filter((asset) => asset.routePointId === routePointId);
}

export function storyMediaNeighborIndex(
  currentIndex: number,
  mediaLength: number,
  direction: -1 | 1,
  wrap: boolean,
): number | null {
  if (mediaLength < 2) return null;
  const next = currentIndex + direction;
  if (next >= 0 && next < mediaLength) return next;
  if (!wrap) return null;
  return direction > 0 ? 0 : mediaLength - 1;
}

export function storyAssetIndexForId(
  media: readonly JourneyMediaAsset[],
  assetId: string | null,
  fallbackIndex: number,
  indexById?: ReadonlyMap<string, number>,
) {
  if (assetId) {
    const index = indexById
      ? indexById.get(assetId) ?? -1
      : media.findIndex((asset) => asset.id === assetId);
    if (index >= 0) return index;
  }
  return Math.min(Math.max(0, fallbackIndex), Math.max(0, media.length - 1));
}

export function indexStoryMedia(media: readonly JourneyMediaAsset[]) {
  const byId = new Map<string, JourneyMediaAsset>();
  const indexById = new Map<string, number>();
  media.forEach((asset, index) => {
    // Match find/findIndex if a malformed list repeats an id.
    if (byId.has(asset.id)) return;
    byId.set(asset.id, asset);
    indexById.set(asset.id, index);
  });
  return { byId, indexById };
}

export function storyMediaInOptimisticOrder(
  media: JourneyMediaAsset[],
  localOrder: readonly string[] | null,
) {
  if (!localOrder) return media;
  const byId = new Map(media.map((asset) => [asset.id, asset]));
  const ordered = localOrder.map((id) => byId.get(id)).filter(
    (asset): asset is JourneyMediaAsset => asset !== undefined,
  );
  const orderedIds = new Set(localOrder);
  // Missing/deleted ids cannot revive media; newly received assets append in
  // canonical scope order while the optimistic request is still in flight.
  for (const asset of media) {
    if (!orderedIds.has(asset.id)) ordered.push(asset);
  }
  return ordered;
}

export function storyAutoplayNextIndex(
  currentIndex: number,
  mediaLength: number,
  wholeJourney: boolean,
): number | null {
  if (mediaLength < 2) return null;
  if (currentIndex < mediaLength - 1) return currentIndex + 1;
  return wholeJourney ? null : 0;
}

export function storyAutoplayVideoCandidate(
  media: readonly JourneyMediaAsset[],
  currentIndex: number,
  wholeJourney: boolean,
) {
  if (media.length === 0 || currentIndex < 0 || currentIndex >= media.length) return null;
  for (let offset = 0; offset < media.length; offset += 1) {
    const rawIndex = currentIndex + offset;
    if (wholeJourney && rawIndex >= media.length) break;
    const candidate = media[rawIndex % media.length];
    if (candidate?.mimeType.startsWith("video/")) return candidate;
  }
  return null;
}

export function storyNavigationTargetDisposition(
  target: JourneyMediaAsset,
  availability: PlaybackMediaAvailability,
  imageDecoded: boolean,
): "ready" | "failed" | "waiting" {
  if (availability === "error") return "failed";
  if (availability !== "ready") return "waiting";
  return target.mimeType.startsWith("video/") || imageDecoded ? "ready" : "waiting";
}

export function storyAutoplayCanStart(
  videoCandidate: JourneyMediaAsset | null,
  candidateAvailability: PlaybackMediaAvailability,
) {
  // Only an unresolved candidate source must hold the initiating gesture. A
  // failed read is already terminal for this attempt and the existing playback
  // policy intentionally degrades that step through its timer/fallback path.
  return !videoCandidate || candidateAvailability !== "waiting";
}

// #199 follow-up review P2: the Viewer immersive entry may only carry the
// sequence into fullscreen when the initiating gesture can authorize the
// fullscreen video node. While the next video candidate's signed read is still
// resolving, `setPlayingFromGesture` returns early, so claiming the handoff
// would leave the sequence marked as playing behind an unauthorized element.
// Immersive viewing itself is never blocked for that — the entry stops the
// sequence, and both play controls immediately say so.
export function storyImmersiveEntryKeepsPlaying(
  playing: boolean,
  videoCandidate: JourneyMediaAsset | null,
  candidateAvailability: PlaybackMediaAvailability,
) {
  return playing && storyAutoplayCanStart(videoCandidate, candidateAvailability);
}

export function storyStageVideoOwner(
  shown: JourneyMediaAsset | null,
  incoming: JourneyMediaAsset | null,
  autoplayCandidate: JourneyMediaAsset | null,
) {
  if (incoming?.mimeType.startsWith("video/")) return incoming;
  if (shown?.mimeType.startsWith("video/")) return shown;
  return autoplayCandidate;
}

export const STORY_AUTOPLAY_STEP_MS = 5200;
export const STORY_VIDEO_STALL_WATCHDOG_MS = 4_000;

export type StoryAutoplayAdvance =
  | { kind: "stop" }
  | { kind: "hold-terminal" }
  | { kind: "advance"; nextIndex: number };

// What ends the current autoplay step: leave playback, hold the last frame of
// a whole-journey run, or move to a specific next index.
export function storyAutoplayAdvance(
  currentIndex: number,
  mediaLength: number,
  wholeJourney: boolean,
): StoryAutoplayAdvance {
  const nextIndex = storyAutoplayNextIndex(currentIndex, mediaLength, wholeJourney);
  if (nextIndex !== null) return { kind: "advance", nextIndex };
  return shouldHoldWholeJourneyTerminalFrame(currentIndex, mediaLength, wholeJourney)
    ? { kind: "hold-terminal" }
    : { kind: "stop" };
}

// Signed-read status in the shared playback vocabulary, so the Story stage and
// Journey playback classify a step's media the same way.
export function storyMediaAvailability(
  status: "loading" | "ready" | "error" | undefined,
): PlaybackMediaAvailability {
  if (status === "ready") return "ready";
  if (status === "error") return "error";
  return "waiting";
}

// #199 review: a video step owns its own completion, so the sequence waits for
// `ended` instead of the fixed slide timer. Anything that cannot deliver
// `ended` — an image, a failed read, or a video element that is not mounted
// for this exact asset yet — keeps the timer so the sequence never stalls.
export function storyAutoplayWaitsForVideoEnd(
  asset: JourneyMediaAsset | null,
  availability: PlaybackMediaAvailability,
  videoAttached: boolean,
): boolean {
  return videoAttached
    && playbackMediaWaitPolicy(asset, availability) === "video-ended";
}

export function shouldHoldWholeJourneyTerminalFrame(
  currentIndex: number,
  mediaLength: number,
  wholeJourney: boolean,
): boolean {
  return wholeJourney && mediaLength > 0 && currentIndex >= mediaLength - 1;
}

export function storyUploadedAssetIndex(
  media: readonly JourneyMediaAsset[],
  uploadedAssetIds: readonly string[],
): number | null {
  for (const assetId of uploadedAssetIds) {
    const index = media.findIndex((asset) => asset.id === assetId);
    if (index >= 0) return index;
  }
  return null;
}

export function storyChapterMedia(
  media: readonly JourneyMediaAsset[],
  asset: JourneyMediaAsset | null,
): JourneyMediaAsset[] {
  if (!asset) return [];
  return media.filter((candidate) => candidate.routePointId === asset.routePointId);
}

export function storySelectionContainsRoutePointMedia(
  media: readonly JourneyMediaAsset[],
  selectedIds: ReadonlySet<string>,
): boolean {
  return media.some((asset) => selectedIds.has(asset.id) && asset.routePointId !== null);
}

export function groupedPlacementRefreshSelection(
  target: Journey | null,
  targetRoutePointId: string | null,
  uploadedAssetIds: readonly string[],
) {
  if (!target) return null;
  const media = storyMediaForScope(target, targetRoutePointId);
  const assetIndex = storyUploadedAssetIndex(media, uploadedAssetIds);
  if (assetIndex === null) return null;
  return { media, assetIndex, assetId: media[assetIndex].id };
}

export function storyInitialMediaSelection(
  journey: Journey | undefined,
  requestedRoutePointId: string | null,
  requestedAssetId: string | null = null,
) {
  if (!journey) {
    return { routePointId: requestedRoutePointId, assetIndex: 0, assetId: null };
  }

  const scoped = storyMediaForScope(journey, requestedRoutePointId);
  const requestedAssetIndex = requestedAssetId === null
    ? -1
    : scoped.findIndex((asset) => asset.id === requestedAssetId);
  if (requestedAssetIndex >= 0) {
    return {
      routePointId: requestedRoutePointId,
      assetIndex: requestedAssetIndex,
      assetId: scoped[requestedAssetIndex].id,
    };
  }
  if (requestedRoutePointId !== null) {
    return {
      routePointId: requestedRoutePointId,
      assetIndex: 0,
      assetId: scoped[0]?.id ?? null,
    };
  }

  // Whole-Journey mode stays aggregate even when the card cover belongs to a
  // route point. Start on that cover inside the canonical narrative sequence.
  const cover = journeyCover(journey);
  const coverIndex = cover ? scoped.findIndex((asset) => asset.id === cover.id) : -1;
  return {
    routePointId: null,
    assetIndex: coverIndex >= 0 ? coverIndex : 0,
    assetId: coverIndex >= 0 ? cover!.id : scoped[0]?.id ?? null,
  };
}
