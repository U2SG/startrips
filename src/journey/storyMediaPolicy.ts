import { journeyCover, isVisualMediaAsset } from "./journeyModel";
import {
  playbackMediaWaitPolicy,
  playbackStoryMedia,
  storyMediaForScope,
  storySequenceForJourney,
  storySequenceMedia,
  type PlaybackMediaAvailability,
} from "./journeyPlayback";
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
): number | null {
  if (mediaLength < 2) return null;
  if (currentIndex < mediaLength - 1) return currentIndex + 1;
  // #76 P1: one Journey-wide sequence, so autoplay returns to the first
  // playable media at the Journey boundary. It must never loop inside a single
  // Route Point, and it must never stop short of the end of the Journey.
  return 0;
}

export function storyAutoplayVideoCandidate(
  media: readonly JourneyMediaAsset[],
  currentIndex: number,
) {
  if (media.length === 0 || currentIndex < 0 || currentIndex >= media.length) return null;
  // #76 P1: the lookahead wraps the whole Journey, so the next video across a
  // Route Point boundary is warmed rather than the first video of the current
  // Route Point being treated as the wrap target.
  for (let offset = 0; offset < media.length; offset += 1) {
    const candidate = media[(currentIndex + offset) % media.length];
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
  | { kind: "advance"; nextIndex: number };

// What ends the current autoplay step: leave playback because there is nothing
// left to present, or move to a specific next index.
//
// #76 P1: the "hold the terminal frame" state is gone. With one Journey-wide
// cursor the run returns to the first playable media, so a journey always has
// somewhere to continue rather than a dead end the viewer has to notice.
export function storyAutoplayAdvance(
  currentIndex: number,
  mediaLength: number,
): StoryAutoplayAdvance {
  const nextIndex = storyAutoplayNextIndex(currentIndex, mediaLength);
  return nextIndex === null ? { kind: "stop" } : { kind: "advance", nextIndex };
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

// #76 P1: `shouldHoldWholeJourneyTerminalFrame` was removed. Holding the last
// frame was the old "stop at the end of the whole Journey" behaviour; with one
// Journey-wide cursor that continues to the first playable media, there is no
// terminal frame to hold.

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

// #76 P1: `assetIndex` is assigned to Story's Journey-wide cursor, so it is
  // resolved against the Journey sequence. Resolving it inside a Route
  // Point-scoped list would land the cursor on unrelated media whenever the
  // Journey has anything ahead of that Route Point.
export function groupedPlacementRefreshSelection(
  target: Journey | null,
  targetRoutePointId: string | null,
  uploadedAssetIds: readonly string[],
) {
  if (!target) return null;
  const media = playbackStoryMedia(target);
  const assetIndex = storyUploadedAssetIndex(media, uploadedAssetIds);
  if (assetIndex === null) return null;
  return { media, assetIndex, assetId: media[assetIndex].id };
}

// #76 P1 + #595: which Route Point Story opens on as a media-free note beat.
//
// Entering on a Route Point that has no media of its own presents that Route
// Point's own note instead of borrowing a neighbour's media, which is what
// "Empty is a valid chapter" asks for. An explicitly requested asset always
// wins, because newest explicit intent beats the Route Point that opened Story.
/**
 * #76 P1 + #595: whether a Route Point presents itself as a note chapter.
 *
 * A Route Point is a chapter in its own right only when it has no media of its
 * own AND something to say. One with neither must not blank the media stage:
 * `hasStoryMedia` drives that stage, and blanking it also strands a deferred
 * fullscreen already scheduled over the media the viewer was looking at.
 */
export function routePointPresentsNote(
  journey: Journey | null | undefined,
  media: readonly JourneyMediaAsset[],
  routePointId: string | null,
): boolean {
  if (!journey || routePointId === null) return false;
  if (media.some((asset) => asset.routePointId === routePointId)) return false;
  const routePoint = journey.routePoints.find((point) => point.id === routePointId);
  return routePoint !== undefined && Boolean(routePoint.note?.trim());
}

/**
 * #76 P1: the Route Point the chapter rail names as current.
 *
 * It follows the media on screen, so Journey-level intro media names no Route
 * Point even while one stays selected as the management target. A Journey with
 * no visual media has nothing on screen to follow, so the selected Route Point
 * is the chapter, exactly as before the cursor became Journey-wide.
 */
export function storyActiveChapterRoutePointId(
  noteBeatRoutePointId: string | null,
  activeAsset: JourneyMediaAsset | null | undefined,
  hasVisualMedia: boolean,
  selectedRoutePointId: string | null,
): string | null {
  if (noteBeatRoutePointId !== null) return noteBeatRoutePointId;
  if (!hasVisualMedia) return selectedRoutePointId;
  return activeAsset?.routePointId ?? null;
}

export function storyInitialNoteBeatRoutePointId(
  journey: Journey | undefined,
  requestedRoutePointId: string | null,
  requestedAssetId: string | null = null,
): string | null {
  if (!journey || requestedRoutePointId === null) return null;
  if (requestedAssetId !== null) return null;
  // A Route Point that is not part of this Journey cannot be presented as a
  // chapter. A stale id would otherwise resolve as a media-free point, hide the
  // media stage behind `hasStoryMedia === false`, and show nothing at all.
  const routePoint = journey.routePoints.find((point) => point.id === requestedRoutePointId);
  if (!routePoint) return null;
  const ownsMedia = journey.media.some(
    (asset) => asset.routePointId === requestedRoutePointId && isVisualMediaAsset(asset),
  );
  // A Route Point with neither media of its own nor a note has nothing to
  // present. Presenting it as a chapter would blank the media stage and strand
  // any deferred fullscreen already scheduled over it, so it stays out of the
  // beat and the Journey keeps showing.
  if (ownsMedia || !routePoint.note?.trim()) return null;
  return requestedRoutePointId;
}

// #76 P1 + #595: the media either side of a media-free Route Point's note beat.
//
// The note beat is a stop in the canonical sequence, not a hidden cursor parked
// on the nearest media. Stepping back from it must land on the media BEFORE the
// Route Point, which a neighbour search anchored on that nearest media would
// skip by one. These are resolved from the sequence itself.
export function storyNoteBeatNeighbourMediaIndexes(
  journey: Journey,
  noteBeatRoutePointId: string,
): { previousIndex: number | null; nextIndex: number | null } {
  const entries = storySequenceForJourney(journey);
  const beatIndex = entries.findIndex(
    (entry) => entry.role === "note" && entry.routePointId === noteBeatRoutePointId,
  );
  if (beatIndex < 0) return { previousIndex: null, nextIndex: null };
  const mediaIndexNear = (from: number, step: -1 | 1): number | null => {
    for (let cursor = from; cursor >= 0 && cursor < entries.length; cursor += step) {
      if (entries[cursor].role === "media") return storySequenceMedia(entries.slice(0, cursor + 1)).length - 1;
    }
    return null;
  };
  return {
    previousIndex: mediaIndexNear(beatIndex - 1, -1),
    nextIndex: mediaIndexNear(beatIndex + 1, 1),
  };
}

// #76 P1: where a Route Point begins inside the Journey-wide sequence. Choosing
// a Route Point is a jump, not a filter: the Journey continues past it in both
// directions, and a Route Point with no media of its own lands on the nearest
// playable media rather than stranding the cursor or being skipped silently.
//
// `routePointIds` is the canonical route order, used only to measure distance
// from an empty Route Point. Passing it keeps this pure instead of caching
// journey state in module scope.
export function storyRoutePointEntryIndex(
  media: readonly JourneyMediaAsset[],
  routePointId: string | null,
  routePointIds: readonly string[] = [],
): number {
  if (media.length === 0) return 0;
  if (routePointId === null) return 0;
  const own = media.findIndex((asset) => asset.routePointId === routePointId);
  if (own >= 0) return own;
  const position = routePointIds.indexOf(routePointId);
  if (position < 0) return 0;
  // Empty-media Route Points are stepped over without breaking route order, so
  // look outward along the route in both directions for the closest media.
  for (let distance = 1; distance <= routePointIds.length; distance += 1) {
    for (const candidate of [position - distance, position + distance]) {
      const index = candidate < 0 || candidate >= routePointIds.length ? -1 : candidate;
      if (index < 0) continue;
      const mediaIndex = media.findIndex((asset) => asset.routePointId === routePointIds[index]);
      if (mediaIndex >= 0) return mediaIndex;
    }
  }
  return 0;
}

// #76 P1: opening Story on a Route Point selects a position in the Journey-wide
// sequence. It never returns a Route Point-scoped list, because a truncated
// list is what made each Route Point an island that could only loop on itself.
export function storyInitialMediaSelection(
  journey: Journey | undefined,
  requestedRoutePointId: string | null,
  requestedAssetId: string | null = null,
) {
  if (!journey) {
    return { routePointId: requestedRoutePointId, assetIndex: 0, assetId: null };
  }

  const sequence = storySequenceForJourney(journey);
  const media = storySequenceMedia(sequence);
  const requestedAssetIndex = requestedAssetId === null
    ? -1
    : media.findIndex((asset) => asset.id === requestedAssetId);
  if (requestedAssetIndex >= 0) {
    return {
      routePointId: media[requestedAssetIndex].routePointId,
      assetIndex: requestedAssetIndex,
      assetId: media[requestedAssetIndex].id,
    };
  }
  if (requestedRoutePointId !== null) {
    // Start on that Route Point's own media inside the Journey sequence, so the
    // previous step reaches the Route Point before it and the next step reaches
    // the Route Point after it. Media keeps canonical ownership, so a Route Point
    // grouped into a Stop still resolves to its own media here.
    //
    // A Route Point with no media of its own lands on the nearest playable
    // media by the SAME rule as clicking that Route Point after Story opens.
    // Returning media[0] here instead would make a direct entry on an empty
    // Route Point jump to the start of the Journey, which is the skipped-point
    // behaviour this change exists to remove.
    const routePointIds = journey.routePoints.map((point) => point.id);
    const startIndex = storyRoutePointEntryIndex(media, requestedRoutePointId, routePointIds);
    return {
      routePointId: requestedRoutePointId,
      assetIndex: startIndex,
      assetId: media[startIndex]?.id ?? null,
    };
  }

  // A fresh Journey entry starts on the cover inside the canonical narrative
  // sequence, even when the cover belongs to a Route Point.
  const cover = journeyCover(journey);
  const coverIndex = cover ? media.findIndex((asset) => asset.id === cover.id) : -1;
  return {
    routePointId: null,
    assetIndex: coverIndex >= 0 ? coverIndex : 0,
    assetId: coverIndex >= 0 ? cover!.id : media[0]?.id ?? null,
  };
}
