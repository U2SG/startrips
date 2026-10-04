import { journeyCover } from "./journeyModel";
import { resolveNoteBeatDwellMs } from "./narrativeTiming";
import {
  playbackMediaWaitPolicy,
  playbackStoryMedia,
  storyMediaForScope,
  storySequenceForJourney,
  storySequenceMedia,
  type PlaybackMediaAvailability,
  type StorySequenceEntry,
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

/**
 * The neighbour of a cursor position.
 *
 * #555: `firstCanonicalIndex` is where the canonical sequence starts. Anything
 * ahead of it is the one-way Journey cover opening: Previous from there goes
 * nowhere, Next enters the canonical sequence at its first entry, and neither
 * the Journey-boundary wrap nor any other step ever lands back on it. With the
 * default 0 there is no opening and this is the plain Journey-wide wrap.
 */
export function storyMediaNeighborIndex(
  currentIndex: number,
  mediaLength: number,
  direction: -1 | 1,
  wrap: boolean,
  firstCanonicalIndex = 0,
): number | null {
  if (currentIndex < firstCanonicalIndex) {
    return direction > 0 && firstCanonicalIndex < mediaLength ? firstCanonicalIndex : null;
  }
  if (mediaLength - firstCanonicalIndex < 2) return null;
  const next = currentIndex + direction;
  if (next >= firstCanonicalIndex && next < mediaLength) return next;
  if (!wrap) return null;
  return direction > 0 ? firstCanonicalIndex : mediaLength - 1;
}

/**
 * #555: whether there is content strictly before/after the requested cursor
 * position, which is what the picture's activation uses to choose a direction.
 * The Journey cover opening has nothing before it, and nothing in the canonical
 * sequence has the opening before it.
 */
export function storyStepAvailability(
  requestedIndex: number,
  length: number,
  firstCanonicalIndex = 0,
): { previous: boolean; next: boolean } {
  if (requestedIndex < firstCanonicalIndex) {
    return { previous: false, next: firstCanonicalIndex < length };
  }
  const canonicalLength = length - firstCanonicalIndex;
  return {
    previous: canonicalLength > 1 && requestedIndex > firstCanonicalIndex,
    next: canonicalLength > 1 && requestedIndex < length - 1,
  };
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
  // #595: which Route Points own any of this media.
  const ownerIds = new Set<string | null>();
  media.forEach((asset, index) => {
    ownerIds.add(asset.routePointId);
    // Match find/findIndex if a malformed list repeats an id.
    if (byId.has(asset.id)) return;
    byId.set(asset.id, asset);
    indexById.set(asset.id, index);
  });
  return { byId, indexById, ownerIds };
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
  firstCanonicalIndex = 0,
): number | null {
  // #76 P1: one Journey-wide sequence, so autoplay returns to the first
  // playable media at the Journey boundary. It must never loop inside a single
  // Route Point, and it must never stop short of the end of the Journey.
  // #555: that first media is canonical entry 0, never the cover opening.
  return storyMediaNeighborIndex(currentIndex, mediaLength, 1, true, firstCanonicalIndex);
}

export function storyAutoplayVideoCandidate(
  media: readonly (JourneyMediaAsset | null)[],
  currentIndex: number,
  firstCanonicalIndex = 0,
) {
  const index = storyAutoplayVideoCandidateIndex(media, currentIndex, firstCanonicalIndex);
  return index === null ? null : media[index] ?? null;
}

/** #555: the position of the autoplay video candidate, so its page is known. */
export function storyAutoplayVideoCandidateIndex(
  media: readonly (JourneyMediaAsset | null)[],
  currentIndex: number,
  firstCanonicalIndex = 0,
): number | null {
  if (media.length === 0 || currentIndex < 0 || currentIndex >= media.length) return null;
  // #76 P1: the lookahead wraps the whole Journey, so the next video across a
  // Route Point boundary is warmed rather than the first video of the current
  // Route Point being treated as the wrap target.
  // #555: it wraps the way the cursor does, to canonical entry 0, so the cover
  // opening is only ever looked at while the cursor is still on it.
  const wrapStart = Math.min(firstCanonicalIndex, currentIndex);
  const order = [
    ...Array.from({ length: media.length - currentIndex }, (_, offset) => currentIndex + offset),
    ...Array.from({ length: Math.max(0, currentIndex - firstCanonicalIndex) }, (_, offset) => wrapStart + offset),
  ];
  for (const index of order) {
    if (media[index]?.mimeType.startsWith("video/")) return index;
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

/**
 * #595: how long Story autoplay holds one cursor entry when nothing else owns
 * its end (a video owns its own). A note entry reads for the shared note-beat
 * dwell, the same number Journey Playback gives the same note; everything else
 * keeps the slide timer.
 */
export function storyAutoplayStepMs(
  entry: Pick<StoryCursorEntry, "role"> & { note?: string } | null | undefined,
): number {
  if (entry?.role === "note") return resolveNoteBeatDwellMs(entry.note?.trim().length ?? 0);
  return STORY_AUTOPLAY_STEP_MS;
}
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
  firstCanonicalIndex = 0,
): StoryAutoplayAdvance {
  const nextIndex = storyAutoplayNextIndex(currentIndex, mediaLength, firstCanonicalIndex);
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

/**
 * #76 P1 + #595: the Route Point the chapter rail names as current.
 *
 * It follows the cursor entry on screen: a media entry names the Route Point
 * that owns the media, a #595 note entry names the Route Point that owns the
 * note, and Journey-level intro media names no Route Point even while one stays
 * selected as the management target. When no stage is presented - a Journey
 * with neither media nor notes, or #616's chip on a Route Point that has no
 * entry of its own in a Journey without media - there is no cursor to follow,
 * so the selected Route Point is the chapter.
 */
export function storyActiveChapterRoutePointId(
  activeEntry: Pick<StoryCursorEntry, "routePointId"> | null | undefined,
  stagePresented: boolean,
  selectedRoutePointId: string | null,
  onJourneyCoverOpening = false,
): string | null {
  // #555: the cover opening speaks for the whole Journey. The asset it shows
  // is owned by some Route Point, but that Route Point is not the chapter until
  // the cursor reaches the cover's own canonical entry.
  if (onJourneyCoverOpening) return null;
  if (!stagePresented) return selectedRoutePointId;
  return activeEntry?.routePointId ?? null;
}

// #76 P1: where a Route Point begins inside the Journey-wide sequence. Choosing
// a Route Point is a jump, not a filter: the Journey continues past it in both
// directions, and a Route Point with no media of its own lands on the nearest
// playable media rather than stranding the cursor or being skipped silently.
// #595: a Route Point that has a note entry of its own lands on that entry
// instead; see `storyRoutePointCursorEntry`.
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
    // behaviour this change exists to remove. #595: a Route Point with a note
    // entry of its own lands on that entry instead (`storyInitialCursorSelection`).
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

/**
 * #555 + #595: one Story cursor position.
 *
 * Story's cursor is an index into these entries, not into media. The entries
 * are the presentation sequence: the optional Journey cover opening followed by
 * the canonical sequence, which holds media entries and, from #595, the note
 * entry of every Route Point that has a note but no media of its own. A note
 * entry is a real stop of the one cursor: buttons, swipe, keyboard and autoplay
 * all land on it in canonical order, and it has no asset (`asset === null`).
 *
 * The asset is only what a media entry paints, signs and prefetches; the same
 * asset can appear at two positions (the opening and the cover's own canonical
 * entry), so an asset id alone never identifies a position.
 */
export type StoryCursorEntry = Omit<StorySequenceEntry, "asset" | "role"> & (
  | { role: "journey-cover" | "media"; asset: JourneyMediaAsset }
  | { role: "note"; asset: null; note: string }
);

/** #595: the MIME type of a note page's stand-in asset on the stage. */
export const STORY_NOTE_PAGE_MIME_TYPE = "text/x-startrips-note";

export type StoryCursor = {
  entries: readonly StoryCursorEntry[];
  /** What each entry paints, in entry order; null for a note entry. */
  assets: readonly (JourneyMediaAsset | null)[];
  /** The canonical media index each entry paints; -1 for a note entry. */
  mediaIndexByEntry: readonly number[];
  /** The canonical entry of each canonical media index. */
  entryIndexByMediaIndex: readonly number[];
  /** The canonical entry of each asset; the opening never appears here. */
  canonicalEntryByAssetId: ReadonlyMap<string, number>;
  /** Where the canonical sequence starts. Anything ahead is the opening. */
  firstCanonicalEntry: number;
  /** Each entry's stage page id; see `storyCursorPageId`. */
  pageIds: readonly string[];
  /** The entry of each page id. Unambiguous, unlike an asset id. */
  entryByPageId: ReadonlyMap<string, number>;
  /** Page id -> asset id, for the media pages whose id is not their asset id. */
  pageAssetIds: ReadonlyMap<string, string>;
  /** #595: the page ids of note entries; they have no asset and no read. */
  notePageIds: ReadonlySet<string>;
  /** Each entry as the stage page it paints; see `storyStagePages`. */
  pages: readonly JourneyMediaAsset[];
};

/**
 * #555: the stage page id of a cursor entry - its presentation identity.
 *
 * A canonical media entry is the one canonical presentation of its asset, so
 * its page id is the asset id: everything that already names a canonical page
 * by asset (signed reads, the DOM's `data-media-page-id`, shared-element
 * morphs, QA) keeps working. Any other presentation, today the Journey cover
 * opening and the #595 note entries (`note:<routePointId>`), uses its sequence
 * `presentationId`, so the stage can tell every page apart.
 */
export function storyCursorPageId(entry: StoryCursorEntry): string {
  return entry.role === "media" ? entry.asset.id : entry.presentationId;
}

/**
 * #595: the stand-in a note entry is painted from on the stage. The stage
 * keys and orders pages as media; this one carries no storage and is never
 * signed, decoded or prefetched, which `notePageIds` lets every caller check.
 */
function storyNotePage(pageId: string, entry: StoryCursorEntry): JourneyMediaAsset {
  return {
    id: pageId,
    journeyId: "",
    routePointId: entry.routePointId,
    storageDriver: "",
    storageKey: "",
    fileName: "",
    mimeType: STORY_NOTE_PAGE_MIME_TYPE,
    bytes: 0,
    sortOrder: 0,
    uploadedByUserId: "",
    createdAt: "",
  };
}

/**
 * The cursor for a Journey. `withJourneyCoverOpening` is decided once per open
 * (see `storyInitialCursorSelection`), never re-derived from the current
 * position, so the opening is part of exactly the open that presented it.
 *
 * #595: note entries are always part of the cursor, also in a Journey with no
 * visual media at all: its note-only Route Points are then the whole Story, as
 * text pages. Only a Journey with neither media nor notes has no entries.
 */
export function storyCursorForJourney(
  journey: Journey | undefined,
  withJourneyCoverOpening: boolean,
): StoryCursor {
  const entries: StoryCursorEntry[] = [];
  const mediaIndexByEntry: number[] = [];
  const entryIndexByMediaIndex: number[] = [];
  const canonicalEntryByAssetId = new Map<string, number>();
  const canonicalMediaIndexByAssetId = new Map<string, number>();
  let opening: StoryCursorEntry | null = null;
  const sequence = journey
    ? storySequenceForJourney(journey, { withJourneyCoverOpening })
    : [];
  for (const entry of sequence) {
    if (entry.role === "note") {
      if (!entry.note) continue;
      mediaIndexByEntry.push(-1);
      entries.push({ ...entry, role: "note", asset: null, note: entry.note });
      continue;
    }
    if (entry.asset === null) continue;
    if (entry.role === "journey-cover") {
      opening = { ...entry, role: "journey-cover", asset: entry.asset };
      continue;
    }
    const mediaIndex = entryIndexByMediaIndex.length;
    if (!canonicalMediaIndexByAssetId.has(entry.asset.id)) {
      canonicalMediaIndexByAssetId.set(entry.asset.id, mediaIndex);
    }
    entryIndexByMediaIndex.push(entries.length);
    mediaIndexByEntry.push(mediaIndex);
    entries.push({ ...entry, role: "media", asset: entry.asset });
  }
  // The opening is a second presentation of a canonical row. One whose asset
  // is not canonical media has nothing to point at and is not presented.
  const openingMediaIndex = opening?.asset
    ? canonicalMediaIndexByAssetId.get(opening.asset.id)
    : undefined;
  const openingPresented = Boolean(opening && openingMediaIndex !== undefined);
  if (opening && openingMediaIndex !== undefined) {
    entries.unshift(opening);
    mediaIndexByEntry.unshift(openingMediaIndex);
    for (let index = 0; index < entryIndexByMediaIndex.length; index += 1) {
      entryIndexByMediaIndex[index] += 1;
    }
  }
  entryIndexByMediaIndex.forEach((entryIndex) => {
    const assetId = entries[entryIndex].asset?.id;
    // Match find/findIndex if a malformed list repeats an id.
    if (assetId !== undefined && !canonicalEntryByAssetId.has(assetId)) {
      canonicalEntryByAssetId.set(assetId, entryIndex);
    }
  });
  const pageIds = entries.map(storyCursorPageId);
  const entryByPageId = new Map<string, number>();
  const pageAssetIds = new Map<string, string>();
  const notePageIds = new Set<string>();
  const pages = entries.map((entry, entryIndex) => {
    const pageId = pageIds[entryIndex];
    if (!entryByPageId.has(pageId)) entryByPageId.set(pageId, entryIndex);
    if (entry.asset === null) {
      notePageIds.add(pageId);
      return storyNotePage(pageId, entry);
    }
    if (pageId === entry.asset.id) return entry.asset;
    pageAssetIds.set(pageId, entry.asset.id);
    return { ...entry.asset, id: pageId };
  });
  return {
    entries,
    assets: entries.map((entry) => entry.asset),
    mediaIndexByEntry,
    entryIndexByMediaIndex,
    canonicalEntryByAssetId,
    // #595: the canonical sequence starts right after the opening, and its
    // first entry may be a note entry rather than media.
    firstCanonicalEntry: openingPresented ? 1 : 0,
    pageIds,
    entryByPageId,
    pageAssetIds,
    notePageIds,
    pages,
  };
}

/**
 * The asset a stage page paints. An unknown page id is taken as an asset id.
 * #595: a note page paints no asset, so it has none to sign, decode or warm.
 */
export function storyCursorAssetIdForPage(cursor: StoryCursor, pageId: string): string | null {
  if (cursor.notePageIds.has(pageId)) return null;
  return cursor.pageAssetIds.get(pageId) ?? pageId;
}

export function storyCursorOnJourneyCover(cursor: StoryCursor, entryIndex: number): boolean {
  return cursor.entries[entryIndex]?.role === "journey-cover";
}

/** #595: whether an entry is a Route Point's note entry. */
export function storyCursorOnNote(cursor: StoryCursor, entryIndex: number): boolean {
  return cursor.entries[entryIndex]?.role === "note";
}

/**
 * The canonical media index an entry paints; counts and "i of n" use this.
 * #595: a note entry paints no media and answers -1, so "i / n" keeps counting
 * media only.
 */
export function storyCursorMediaIndex(cursor: StoryCursor, entryIndex: number): number {
  return cursor.mediaIndexByEntry[entryIndex] ?? -1;
}

/**
 * Keep an entry index inside the cursor. An index that has to move is clamped
 * into the canonical sequence: only a cursor already on the opening stays there.
 */
export function storyCursorClampEntry(cursor: StoryCursor, entryIndex: number): number {
  const length = cursor.entries.length;
  if (length === 0) return 0;
  const clamped = Math.min(Math.max(0, entryIndex), length - 1);
  if (clamped === entryIndex || clamped >= cursor.firstCanonicalEntry) return clamped;
  return Math.min(cursor.firstCanonicalEntry, length - 1);
}

/** The canonical entry of a canonical media index (a tile, a Route Point jump). */
export function storyCursorEntryForMediaIndex(cursor: StoryCursor, mediaIndex: number): number {
  const count = cursor.entryIndexByMediaIndex.length;
  if (count === 0) return 0;
  return cursor.entryIndexByMediaIndex[Math.min(Math.max(0, mediaIndex), count - 1)];
}

/**
 * #595: where choosing a Route Point lands the cursor - a chip, a direct open,
 * a Playback return. A Route Point with a note entry of its own lands on that
 * entry; any other one on its own first media, or the nearest media for a
 * Route Point with neither (`storyRoutePointEntryIndex`).
 */
/**
 * #595 + #616: in a Journey without visual media, a Route Point that has no
 * cursor entry of its own (no note) has nothing to present. Choosing it keeps
 * the truthful empty chapter instead of borrowing a neighbour's note page, so
 * this answers the Route Point the empty chapter names, or null.
 */
export function storyEmptyChapterRoutePointId(
  cursor: StoryCursor,
  journey: Pick<Journey, "routePoints"> | undefined,
  routePointId: string | null,
): string | null {
  if (!journey || routePointId === null) return null;
  if (cursor.entryIndexByMediaIndex.length > 0) return null;
  if (!journey.routePoints.some((point) => point.id === routePointId)) return null;
  const ownsEntry = cursor.entries.some((entry) => entry.routePointId === routePointId);
  return ownsEntry ? null : routePointId;
}

export function storyRoutePointCursorEntry(
  cursor: StoryCursor,
  media: readonly JourneyMediaAsset[],
  routePointId: string | null,
  routePointIds: readonly string[],
): number {
  if (routePointId !== null) {
    const noteEntry = cursor.entries.findIndex(
      (entry) => entry.role === "note" && entry.routePointId === routePointId,
    );
    if (noteEntry >= 0) return noteEntry;
  }
  return storyCursorEntryForMediaIndex(
    cursor,
    storyRoutePointEntryIndex(media, routePointId, routePointIds),
  );
}

/**
 * Turn a stage page id (shown, incoming, requested, a gesture target) back into
 * a cursor position. Page ids are presentation identities, so the opening and
 * the canonical cover resolve to their own entries. An unknown id keeps the
 * current position (clamped), which never moves anyone onto the opening.
 */
export function storyCursorEntryForPageId(
  cursor: StoryCursor,
  pageId: string | null,
  currentEntryIndex: number,
): number {
  if (pageId !== null) {
    const entryIndex = cursor.entryByPageId.get(pageId);
    if (entryIndex !== undefined) return entryIndex;
  }
  return storyCursorClampEntry(cursor, currentEntryIndex);
}

/** The entry an upload refresh lands on: always a canonical one. */
export function storyUploadedEntryIndex(
  cursor: StoryCursor,
  uploadedAssetIds: readonly string[],
): number | null {
  for (const assetId of uploadedAssetIds) {
    const entryIndex = cursor.canonicalEntryByAssetId.get(assetId);
    if (entryIndex !== undefined) return entryIndex;
  }
  return null;
}

export function storyCursorNeighbourEntry(
  cursor: StoryCursor,
  currentEntryIndex: number,
  direction: -1 | 1,
  wrap: boolean,
): number | null {
  return storyMediaNeighborIndex(
    currentEntryIndex,
    cursor.entries.length,
    direction,
    wrap,
    cursor.firstCanonicalEntry,
  );
}

/**
 * The pages the stage paints and swipes from the settled position, as media
 * whose `id` is the PAGE id (see `storyCursorPageId`).
 *
 * On the opening the stage holds every entry, so its next page is canonical
 * entry 0 - a real page even when that entry is the cover itself. Everywhere
 * else it holds only the canonical entries, so nothing (a swipe, the painted
 * previous page) can reach back to the one-way opening. #595: a note entry is
 * a page too, painted from a stand-in whose MIME type is
 * `STORY_NOTE_PAGE_MIME_TYPE`; `notePageIds` names those pages.
 */
export function storyStagePages(
  cursor: StoryCursor,
  entryIndex: number,
): readonly JourneyMediaAsset[] {
  const from = storyCursorOnJourneyCover(cursor, entryIndex) ? 0 : cursor.firstCanonicalEntry;
  return from === 0 ? cursor.pages : cursor.pages.slice(from);
}

/**
 * #595: the stage pages Story's warm window may spend its budget on.
 *
 * The warm window (signed reads, decoded pictures, the live transport) counts
 * media only: a note page has nothing to read or decode, so it must neither
 * take a slot nor push a real neighbour out of the window. `indexOfPage` maps a
 * stage page to its position in `media`; a note page anchors on the nearest
 * media page in `direction` (the other way when there is none), so warming
 * keeps preparing what comes after the note.
 */
export function storyWarmMediaPages(
  stagePages: readonly JourneyMediaAsset[],
  notePageIds: ReadonlySet<string>,
) {
  const media: JourneyMediaAsset[] = [];
  const mediaIndexByStageIndex: number[] = [];
  const stageIndexById = new Map<string, number>();
  stagePages.forEach((page, stageIndex) => {
    if (!stageIndexById.has(page.id)) stageIndexById.set(page.id, stageIndex);
    if (notePageIds.has(page.id)) {
      mediaIndexByStageIndex.push(-1);
      return;
    }
    mediaIndexByStageIndex.push(media.length);
    media.push(page);
  });
  const indexOfStageIndex = (stageIndex: number, direction: -1 | 1): number => {
    if (stageIndex < 0 || stageIndex >= stagePages.length) return -1;
    const own = mediaIndexByStageIndex[stageIndex];
    if (own >= 0) return own;
    for (const step of [direction, -direction as -1 | 1]) {
      for (let index = stageIndex + step; index >= 0 && index < stagePages.length; index += step) {
        if (mediaIndexByStageIndex[index] >= 0) return mediaIndexByStageIndex[index];
      }
    }
    return -1;
  };
  return {
    media,
    indexOfStageIndex,
    indexOfPage: (pageId: string | null | undefined, direction: -1 | 1): number => (
      pageId ? indexOfStageIndex(stageIndexById.get(pageId) ?? -1, direction) : -1
    ),
  };
}

/**
 * What a Story observation may publish for a stage page.
 *
 * A media page publishes its asset, so closing Story returns to the Route Point
 * that owns it. The Journey cover opening speaks for the whole Journey, so its
 * asset must not move the map to the cover's Route Point: it publishes nothing.
 * #595: a note page publishes no asset and names the Route Point that owns the
 * note, never a neighbouring media's owner.
 */
export function storyObservedTarget(
  cursor: StoryCursor,
  pageId: string | null,
): { assetId: string | null; noteRoutePointId: string | null } {
  if (pageId === null) return { assetId: null, noteRoutePointId: null };
  const entryIndex = cursor.entryByPageId.get(pageId);
  const entry = entryIndex === undefined ? undefined : cursor.entries[entryIndex];
  if (entry?.role === "note") return { assetId: null, noteRoutePointId: entry.routePointId };
  if (entry?.role === "journey-cover") return { assetId: null, noteRoutePointId: null };
  return { assetId: storyCursorAssetIdForPage(cursor, pageId), noteRoutePointId: null };
}

/**
 * Where an open starts on the cursor.
 *
 * The opening is presented only when the open explicitly asks for it AND names
 * no Route Point or asset AND the Journey has a cover. The null/null shape on
 * its own is not enough: a Playback return can resolve to it and must land on
 * the canonical cover, not replay the opening. Every other open starts on the
 * canonical entry of the media selection, except that #595 an open on a Route
 * Point with a note entry of its own (and no explicit asset) lands on that note.
 */
export function storyInitialCursorSelection(
  journey: Journey | undefined,
  mediaSelection: { assetIndex: number; assetId: string | null },
  request: {
    routePointId: string | null;
    assetId: string | null;
    presentJourneyCoverOpening: boolean;
  },
): { withJourneyCoverOpening: boolean; entryIndex: number; assetId: string | null; pageId: string | null } {
  const wantsOpening = request.presentJourneyCoverOpening
    && request.routePointId === null
    && request.assetId === null;
  const cursor = storyCursorForJourney(journey, wantsOpening);
  const openingIndex = cursor.entries.findIndex((entry) => entry.role === "journey-cover");
  if (openingIndex >= 0) {
    return {
      withJourneyCoverOpening: true,
      entryIndex: openingIndex,
      assetId: cursor.entries[openingIndex].asset?.id ?? null,
      pageId: cursor.pageIds[openingIndex],
    };
  }
  if (request.routePointId !== null
    && (request.assetId === null || mediaSelection.assetId !== request.assetId)) {
    const noteEntry = cursor.entries.findIndex(
      (entry) => entry.role === "note" && entry.routePointId === request.routePointId,
    );
    if (noteEntry >= 0) {
      return {
        withJourneyCoverOpening: false,
        entryIndex: noteEntry,
        assetId: null,
        pageId: cursor.pageIds[noteEntry],
      };
    }
  }
  const entryIndex = storyCursorEntryForMediaIndex(cursor, mediaSelection.assetIndex);
  return {
    withJourneyCoverOpening: false,
    entryIndex,
    assetId: mediaSelection.assetId,
    pageId: cursor.pageIds[entryIndex] ?? null,
  };
}
