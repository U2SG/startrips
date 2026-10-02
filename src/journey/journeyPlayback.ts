// #19 Journey Playback — a deterministic playback director.
//
// The director is a pure state machine: it never touches the Three scene, the
// DOM, or the audio element. It computes *what phase* playback is in, and the
// UI layer turns those into semantic commands (focus camera, show route
// progress, mount media). How long a phase lasts is not decided here —
// `narrativeTiming.ts` is the single resolver every mode asks. Keeping the
// machine pure makes the chapter order and pause/resume behavior unit-testable.

import type { HomeNarrativeContext, HomeNarrativeCameraTarget } from "./homeBasePrelude";
import {
  factualRouteText,
  isVisualMediaAsset,
  resolveJourneyRouteSegmentProvenance,
} from "./journeyModel";
import type { Journey, JourneyMediaAsset, JourneyRoute, RoutePoint } from "./types";

export type JourneyPlaybackPhase =
  | { type: "home-prelude"; homeBaseId: string }
  | { type: "intro" }
  | { type: "travel"; from: number; to: number }
  | { type: "stop"; pointIndex: number }
  | { type: "media"; pointIndex: number; mediaIndex: number }
  | { type: "home-epilogue"; homeBaseId: string }
  | { type: "outro" }
  | { type: "completed" }
  | { type: "paused"; previous: JourneyPlaybackPhase };

export function routePointAngularDistance(
  from: RoutePoint,
  to: RoutePoint,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const dLat = lat2 - lat1;
  const dLon = toRadians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function playbackFactualRouteText(
  route: Pick<JourneyRoute, "points" | "segmentProvenance"> | null | undefined,
  toPointIndex: number,
  text: string,
  fromPointIndex = Math.max(0, toPointIndex - 1),
): string | null {
  if (!route || toPointIndex <= 0 || toPointIndex >= route.points.length) return null;
  for (let index = Math.max(0, fromPointIndex); index < toPointIndex; index += 1) {
    if (factualRouteText(resolveJourneyRouteSegmentProvenance(route, index), text) === null) return null;
  }
  return text;
}

export type PlaybackMediaAvailability = "waiting" | "ready" | "error";
export type PlaybackMediaWaitPolicy = "none" | "decode" | "video-ended";

export function playbackMediaWaitPolicy(
  asset: JourneyMediaAsset | null | undefined,
  availability: PlaybackMediaAvailability,
): PlaybackMediaWaitPolicy {
  if (!asset || availability === "error") return "none";
  if (asset.mimeType.startsWith("video/")) return "video-ended";
  if (asset.mimeType.startsWith("image/") && availability === "waiting") return "decode";
  return "none";
}

function comparePlaybackMedia(left: JourneyMediaAsset, right: JourneyMediaAsset): number {
  return left.sortOrder - right.sortOrder;
}

function orderedMediaForOwner(
  journey: Journey,
  routePointId: string | null,
): JourneyMediaAsset[] {
  return journey.media
    .filter((asset) => asset.routePointId === routePointId && isVisualMediaAsset(asset))
    .sort(comparePlaybackMedia);
}

/** Build once per projection, sorting only the owners it consumes. */
export function playbackMediaByOwner(
  journey: Journey,
  ownerIds: readonly (string | null)[],
): Map<string | null, JourneyMediaAsset[]> {
  const byOwner = new Map<string | null, JourneyMediaAsset[]>();
  for (const ownerId of ownerIds) byOwner.set(ownerId, []);
  for (const asset of journey.media) {
    const media = byOwner.get(asset.routePointId);
    if (media && isVisualMediaAsset(asset)) media.push(asset);
  }
  for (const media of byOwner.values()) media.sort(comparePlaybackMedia);
  return byOwner;
}

/**
 * Cinematic chapter projection for #514/ST-164. An explicitly-owned non-stop
 * keeps its canonical Route Point/media identity, while its visual media plays
 * inside the exact Stop selected by the user. Invalid/stale pointers fail
 * closed to the canonical child instead of silently rebinding to a neighbour.
 */
export type PlaybackJourney = Journey & {
  /** Runtime chapter placement; media objects keep their canonical owner/order. */
  chapterMedia?: ReadonlyMap<string | null, readonly JourneyMediaAsset[]>;
};

/**
 * Which Stop-backed chapter owns each Route Point's presentation.
 *
 * A Stop owns its own chapter; a non-stop Route Point joins the chapter of the
 * Stop it is anchored to, and otherwise forms its own lightweight chapter.
 * This is the single derivation of chapter membership: `playbackMediaByChapter`
 * and `storySequenceForJourney` both read it so a grouped Route Point cannot be
 * placed in one chapter by one surface and another by the other.
 */
function playbackChapterByOwner(journey: Journey): Map<string, string> {
  const pointsById = new Map(journey.routePoints.map((point) => [point.id, point]));
  const chapterByOwner = new Map<string, string>();
  for (const point of journey.routePoints) {
    const explicitAnchor = point.isStop ? null : point.stayAnchorRoutePointId;
    const anchor = explicitAnchor ? pointsById.get(explicitAnchor) : null;
    chapterByOwner.set(point.id, anchor?.isStop ? anchor.id : point.id);
  }
  return chapterByOwner;
}

/** The Route Points that present inside one chapter, in canonical route order. */
function playbackChapterMembers(
  journey: Journey,
  chapterId: string,
  chapterByOwner: ReadonlyMap<string, string>,
): RoutePoint[] {
  return journey.routePoints.filter((point) => chapterByOwner.get(point.id) === chapterId);
}

export function playbackMediaByChapter(journey: PlaybackJourney): Map<string, JourneyMediaAsset[]> {
  const chapterMedia = journey.chapterMedia;
  if (chapterMedia) {
    return new Map(journey.routePoints.map((point) => [point.id, [...(chapterMedia.get(point.id) ?? [])]]));
  }
  // Preserve the Stop-only projection's single owner scan and performance bound.
  if (journey.routePoints.every((point) => point.isStop)) {
    const byOwner = playbackMediaByOwner(journey, journey.routePoints.map((point) => point.id));
    return new Map(journey.routePoints.map((point) => [point.id, byOwner.get(point.id) ?? []]));
  }
  const chapterByOwner = playbackChapterByOwner(journey);
  const routeIndexById = new Map(journey.routePoints.map((point, index) => [point.id, index]));

  const byChapter = new Map(journey.routePoints.map((point) => [point.id, [] as JourneyMediaAsset[]]));
  for (const asset of journey.media) {
    const routePointId = asset.routePointId;
    if (routePointId === null || !isVisualMediaAsset(asset)) continue;
    const chapterId = chapterByOwner.get(routePointId);
    if (chapterId !== undefined) byChapter.get(chapterId)?.push(asset);
  }
  // #76: a folded chapter mixes several Route Points, and `sortOrder` is a
  // Journey-global upload counter rather than a per-chapter sequence. Sorting
  // the merged chapter by it alone let a group's child media outrun the Stop
  // that owns the chapter, so Story's canonical whole-Journey order
  // (`playbackStoryMedia`, route order per owner) and this chapter order
  // disagreed on real journeys. Canonical route position decides first;
  // `sortOrder` only orders media inside one Route Point. The all-Stop path
  // above is unaffected because a chapter there has exactly one owner.
  // Only point-owned media reaches this loop, so `routePointId` is always set.
  const routeIndexOf = (asset: JourneyMediaAsset) =>
    routeIndexById.get(asset.routePointId ?? "") ?? Number.MAX_SAFE_INTEGER;
  for (const media of byChapter.values()) {
    media.sort((left, right) => routeIndexOf(left) - routeIndexOf(right)
      || comparePlaybackMedia(left, right));
  }
  return byChapter;
}

/**
 * The visual media presented in one cinematic Route Point chapter. Story's
 * explicit Route Point scope remains canonical and does not use this folding.
 */
export function playbackMediaForPoint(
  journey: Journey,
  pointIndex: number,
): JourneyMediaAsset[] {
  const point = journey.routePoints[pointIndex];
  if (!point) return [];
  return playbackMediaByChapter(journey).get(point.id) ?? [];
}

/**
 * The journey-scoped visual media (routePointId null) shown in the intro.
 */
export function playbackIntroMedia(journey: Journey): JourneyMediaAsset[] {
  return orderedMediaForOwner(journey, null);
}

/**
 * One entry of the canonical Story presentation sequence.
 *
 * `presentationId` is the entry's identity and is deliberately NOT the media
 * asset id: the same asset can legitimately be presented twice under two
 * different narrative roles, and a cursor keyed only by `assetId` cannot tell
 * those appearances apart. `asset` is always the canonical stored row — a
 * presentation entry never duplicates or re-uploads media.
 *
 * `contextOwner` says whose note/place context the entry speaks with, which is
 * not always the asset's owner: a Journey-level opening may present an asset
 * that belongs to one Route Point without presenting that Route Point.
 */
export type StorySequenceEntry = {
  presentationId: string;
  role: "media" | "note";
  asset: JourneyMediaAsset | null;
  routePointId: string | null;
  contextOwner: "journey" | "route-point";
  note?: string;
};

function routePointNoteText(point: RoutePoint | undefined): string | null {
  const note = point?.note?.trim();
  return note ? note : null;
}

function storyMediaEntry(asset: JourneyMediaAsset, routePointId: string | null): StorySequenceEntry {
  return {
    presentationId: `media:${asset.id}`,
    role: "media",
    asset,
    routePointId,
    contextOwner: routePointId === null ? "journey" : "route-point",
  };
}

/**
 * The canonical Story sequence for a whole Journey: Journey-level intro media,
 * then every Route Point in canonical route order, each contributing its own
 * content in route order.
 *
 * A Route Point that has a note but no media of its own is a real beat here,
 * not an absence. "Empty is a valid chapter": the place and its note are the
 * content, so the sequence keeps it instead of stepping past it.
 *
 * The media order here is identical to `playbackStoryMedia`, which is this
 * sequence's media-only projection, so the two cannot drift apart.
 */
export function storySequenceForJourney(journey: Journey): StorySequenceEntry[] {
  const chapterByOwner = playbackChapterByOwner(journey);
  // One owner scan for the whole sequence. Each bucket is already in
  // sortOrder, and walking a chapter's members in canonical route order
  // concatenates those buckets into exactly the (route position, sortOrder)
  // order `playbackMediaByChapter` produces, so no second sort and no second
  // read of `routePointId` is needed. Keepsake measures owner reads against a
  // linear budget (`journeyKeepsake.test.ts`).
  const mediaByOwner = playbackMediaByOwner(
    journey,
    [null, ...journey.routePoints.map((point) => point.id)],
  );
  const entries: StorySequenceEntry[] = (mediaByOwner.get(null) ?? [])
    .map((asset) => storyMediaEntry(asset, null));
  for (const point of journey.routePoints) {
    // A Route Point grouped under a Stop presents inside that Stop's chapter,
    // so the chapter is walked once and its members in canonical route order.
    const chapterId = chapterByOwner.get(point.id);
    if (chapterId === undefined || chapterId !== point.id) continue;
    for (const member of playbackChapterMembers(journey, chapterId, chapterByOwner)) {
      const media = mediaByOwner.get(member.id) ?? [];
      const note = routePointNoteText(member);
      // A note rides with its own Route Point's media rather than becoming a
      // separate step. Only a Route Point with no media of its own presents the
      // note as the beat itself.
      if (note && media.length === 0) {
        entries.push({
          presentationId: `note:${member.id}`,
          role: "note",
          asset: null,
          routePointId: member.id,
          contextOwner: "route-point",
          note,
        });
      }
      for (const asset of media) entries.push(storyMediaEntry(asset, member.id));
    }
  }
  return entries;
}

/** The media-only projection of a presentation sequence. */
export function storySequenceMedia(entries: readonly StorySequenceEntry[]): JourneyMediaAsset[] {
  return entries.flatMap((entry) => entry.asset === null ? [] : [entry.asset]);
}

/** Canonical Story media order for the whole Journey: intro media first, then
 * each route point's visual media in the same order used by Journey Playback. */
export function playbackStoryMedia(journey: Journey): JourneyMediaAsset[] {
  return storySequenceMedia(storySequenceForJourney(journey));
}

/** Story browse scope: null means the aggregate Journey narrative, while a
 * route-point id keeps the existing chapter-only browsing mode. */
export function storyMediaForScope(
  journey: Journey,
  routePointId: string | null,
): JourneyMediaAsset[] {
  if (routePointId === null) return playbackStoryMedia(journey);
  const pointIndex = journey.routePoints.findIndex((point) => point.id === routePointId);
  return pointIndex >= 0 ? orderedMediaForOwner(journey, routePointId) : [];
}

export function isPlaybackTransitRoutePoint(
  point: Pick<RoutePoint, "isStop" | "placeRole">,
): boolean {
  // isStop is the canonical route-role bit. Descriptive placeRole metadata
  // cannot override an explicit Stop choice made in Composer.
  return point.isStop === false;
}

export type PlaybackStep =
  | { kind: "home-prelude"; cameraTarget: HomeNarrativeCameraTarget }
  | { kind: "intro" }
  | { kind: "travel"; to: number; from?: number }
  | { kind: "stop"; pointIndex: number; media: JourneyMediaAsset[] }
  | { kind: "media"; pointIndex: number; mediaIndex: number }
  | { kind: "home-epilogue"; cameraTarget: HomeNarrativeCameraTarget }
  | { kind: "outro"; cameraTarget?: HomeNarrativeCameraTarget };

/**
 * How much media one Route Point chapter carries.
 *
 * Sparse 0 / 1 / 2-3 chapters keep their existing grammar. The 4-9 band is
 * `sequence`; 10+ is `dense`, while still preserving every canonical asset in
 * the director-owned playback order.
 */
export type RoutePointChapterDensity = "empty" | "single" | "few" | "sequence" | "dense";

/**
 * The density of one already-resolved chapter media list.
 *
 * Internal so there is exactly ONE media-order authority: every caller either
 * holds a list in canonical playback order (the `stop` step carries it)
 * or goes through `routePointChapterDensity` to resolve one chapter.
 */
function chapterDensityForMedia(
  media: readonly JourneyMediaAsset[],
): RoutePointChapterDensity {
  if (media.length === 0) return "empty";
  if (media.length === 1) return "single";
  if (media.length <= 3) return "few";
  if (media.length <= 9) return "sequence";
  return "dense";
}

/** The sparse chapter density of one Route Point, derived only from
 * `playbackMediaForPoint` — no second media order is introduced. */
export function routePointChapterDensity(
  journey: Journey,
  pointIndex: number,
): RoutePointChapterDensity {
  return chapterDensityForMedia(playbackMediaForPoint(journey, pointIndex));
}

/**
 * The density of one Route Point as it presents inside a Story sequence.
 *
 * Density counts media, never entries. A note-only Route Point presents as one
 * entry but is still an `empty` chapter, because the place and its note are the
 * memory rather than a thin stack: adding a note entry must not quietly promote
 * an empty chapter into a stack-shaped one.
 */
export function storyEntryDensity(
  entries: readonly StorySequenceEntry[],
): RoutePointChapterDensity {
  return chapterDensityForMedia(storySequenceMedia(entries));
}

export type PlaybackTravelChoreography = "nearby" | "regional" | "long-haul";

export type PlaybackCameraTarget =
  | { kind: "route" }
  | { kind: "point"; pointIndex: number; choreography?: PlaybackTravelChoreography }
  | HomeNarrativeCameraTarget;

/**
 * Camera ownership follows the playback chapter, not the entry click:
 * intro/outro frame the whole Journey, while travel/stop/media stay spatially
 * anchored to the relevant route point. Media therefore inherits the stop's
 * point target instead of causing a second camera command.
 */
export function playbackTravelChoreography(
  journey: Journey,
  toPointIndex: number,
  fromPointIndex = Math.max(0, toPointIndex - 1),
): PlaybackTravelChoreography {
  const to = journey.routePoints[toPointIndex];
  const from = journey.routePoints[fromPointIndex];
  if (!from || !to) return "regional";
  const degrees = playbackTravelAngularDistance(journey, toPointIndex, fromPointIndex) * 180 / Math.PI;
  if (degrees < 6) return "nearby";
  if (degrees >= 55) return "long-haul";
  return "regional";
}

/** Every shaping point contributes to the leg, without owning an arrival. */
export function playbackTravelAngularDistance(
  journey: Journey,
  toPointIndex: number,
  fromPointIndex = Math.max(0, toPointIndex - 1),
): number {
  let distance = 0;
  for (let index = Math.max(0, fromPointIndex); index < toPointIndex; index += 1) {
    const from = journey.routePoints[index];
    const to = journey.routePoints[index + 1];
    if (from && to) distance += routePointAngularDistance(from, to);
  }
  return distance;
}

export function playbackCameraTargetForStep(
  step: PlaybackStep | undefined,
  journey?: Journey | null,
): PlaybackCameraTarget | null {
  if (!step) return null;
  switch (step.kind) {
    case "home-prelude":
    case "home-epilogue":
      // Home remains camera-only narrative context. The target is carried by the
      // beat itself rather than reinterpreted as a Journey Route Point.
      return step.cameraTarget;
    case "intro":
      return { kind: "route" };
    case "outro":
      // An eligible Home epilogue owns the final life context through the
      // title/date fade and completion. Without Home, preserve route framing.
      return step.cameraTarget ?? { kind: "route" };
    case "travel":
      return {
        kind: "point",
        pointIndex: step.to,
        choreography: journey ? playbackTravelChoreography(journey, step.to, step.from) : undefined,
      };
    case "stop":
    case "media":
      return { kind: "point", pointIndex: step.pointIndex };
  }
}

export function playbackCameraTargetKey(target: PlaybackCameraTarget) {
  if (target.kind === "route") return "route";
  if (target.kind === "home") return `home:${target.homeBaseId}`;
  return `point:${target.pointIndex}`;
}

/**
 * Stops always own chapters. Ungrouped media-bearing vias own lightweight
 * chapters; pure shaping points stay in travel geometry without an arrival.
 */
export function buildPlaybackSteps(
  journey: Journey,
  homeContext?: HomeNarrativeContext | null,
): PlaybackStep[] {
  const byChapter = playbackMediaByChapter(journey);
  const steps: PlaybackStep[] = [];
  if (homeContext?.prelude.eligible) {
    steps.push({ kind: "home-prelude", cameraTarget: homeContext.prelude.cameraTarget });
  }
  steps.push({ kind: "intro" });
  let previousChapterIndex = 0;
  for (let pointIndex = 0; pointIndex < journey.routePoints.length; pointIndex += 1) {
    const routePoint = journey.routePoints[pointIndex];
    const media = byChapter.get(routePoint.id) ?? [];
    if (!routePoint.isStop && media.length === 0) continue;
    if (pointIndex > 0) steps.push(previousChapterIndex === pointIndex - 1
      ? { kind: "travel", to: pointIndex }
      : { kind: "travel", from: previousChapterIndex, to: pointIndex });
    previousChapterIndex = pointIndex;
    // An ungrouped media-bearing via has content beats without a Stop arrival.
    // Grouped via media already belongs to its Stop-backed chapter above.
    if (isPlaybackTransitRoutePoint(routePoint)) {
      for (let mediaIndex = 0; mediaIndex < media.length; mediaIndex += 1) {
        steps.push({ kind: "media", pointIndex, mediaIndex });
      }
      continue;
    }
    steps.push({ kind: "stop", pointIndex, media });
    for (let mediaIndex = 0; mediaIndex < media.length; mediaIndex += 1) {
      steps.push({ kind: "media", pointIndex, mediaIndex });
    }
  }
  const epilogueCameraTarget = homeContext?.epilogue.eligible
    ? homeContext.epilogue.cameraTarget
    : null;
  if (epilogueCameraTarget) {
    steps.push({ kind: "home-epilogue", cameraTarget: epilogueCameraTarget });
  }
  steps.push(epilogueCameraTarget
    ? { kind: "outro", cameraTarget: epilogueCameraTarget }
    : { kind: "outro" });
  return steps;
}

/**
 * A step's narrative identity, stable across a plan rebuild.
 *
 * A step index alone is meaningless once the plan changes: a rebuild at another
 * tempo can select more or fewer assets, so index 7 may be a different beat.
 * Identity is the route point id (travel / stop) or the asset id (media), which
 * survive the rebuild whenever the beat itself does.
 */
export function playbackStepIdentity(journey: Journey, step: PlaybackStep): string {
  switch (step.kind) {
    case "home-prelude":
      return `home-prelude:${step.cameraTarget.homeBaseId}`;
    case "intro":
      return "intro";
    case "home-epilogue":
      return `home-epilogue:${step.cameraTarget.homeBaseId}`;
    case "outro":
      return "outro";
    case "travel":
      return `travel:${journey.routePoints[step.to]?.id ?? step.to}`;
    case "stop":
      return `stop:${journey.routePoints[step.pointIndex]?.id ?? step.pointIndex}`;
    case "media": {
      const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
      return `media:${asset?.id ?? `${step.pointIndex}:${step.mediaIndex}`}`;
    }
  }
}

export type CommittedPlaybackPosition = {
  journeyId: string;
  routePointId: string | null;
  assetId: string | null;
};

/**
 * Resolve return identity from the step React has already committed. Pending
 * seek targets and camera commands never enter this helper, so they cannot
 * masquerade as something the viewer has actually reached.
 */
export function committedPlaybackPosition(
  journey: Journey,
  committedStep: PlaybackStep | undefined,
): CommittedPlaybackPosition {
  if (!committedStep) {
    return { journeyId: journey.id, routePointId: null, assetId: null };
  }
  switch (committedStep.kind) {
    case "home-prelude":
    case "home-epilogue":
    case "intro":
    case "outro":
      return { journeyId: journey.id, routePointId: null, assetId: null };
    case "travel":
      return {
        journeyId: journey.id,
        routePointId: journey.routePoints[committedStep.to]?.id ?? null,
        assetId: null,
      };
    case "stop":
      return {
        journeyId: journey.id,
        routePointId: journey.routePoints[committedStep.pointIndex]?.id ?? null,
        assetId: null,
      };
    case "media": {
      const asset = playbackMediaForPoint(journey, committedStep.pointIndex)[committedStep.mediaIndex];
      const routePointId = asset ? asset.routePointId : journey.routePoints[committedStep.pointIndex]?.id ?? null;
      return { journeyId: journey.id, routePointId, assetId: asset?.id ?? null };
    }
  }
}

/**
 * Advance the return commit log only when the presentation owner confirms that
 * the current media asset actually owns the visible slot. A failed or stale
 * request therefore leaves the last successfully committed position intact.
 */
export function commitPresentedPlaybackPosition(
  previous: CommittedPlaybackPosition | null,
  journey: Journey,
  committedStep: PlaybackStep | undefined,
  presentedAssetId: string,
): CommittedPlaybackPosition | null {
  if (!committedStep || committedStep.kind !== "media") return previous;
  const next = committedPlaybackPosition(journey, committedStep);
  return next.assetId === presentedAssetId ? next : previous;
}

export type PlaybackControl =
  | { type: "advance" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "back" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "replay" }
  | { type: "seek"; stepIndex: number }
  | { type: "exit" };

export type PlaybackState = {
  stepIndex: number;
  phase: JourneyPlaybackPhase;
  paused: boolean;
};

export function initialPlaybackState(homeContext?: HomeNarrativeContext | null): PlaybackState {
  if (homeContext?.prelude.eligible) {
    return {
      stepIndex: 0,
      phase: { type: "home-prelude", homeBaseId: homeContext.prelude.cameraTarget.homeBaseId },
      paused: false,
    };
  }
  return { stepIndex: 0, phase: { type: "intro" }, paused: false };
}

/** Terminal is a transport state, not an alias for "paused" or "not started". */
export function isPlaybackTerminalState(state: PlaybackState): boolean {
  return state.phase.type === "completed";
}

/**
 * Whether manual next / previous may land on this beat.
 *
 * Travel is internal bookkeeping (#126). From #456 the arrival `stop` of a
 * populated chapter is too: the place caption and its media are one chapter, so
 * exposing the arrival as its own destination made the viewer click twice to
 * reach the memory. The stop beat still plays in the automatic stream, and an
 * `empty` chapter keeps it as its sole destination — there the place IS the
 * memory. The density comes from the step's own `media`, which
 * `buildPlaybackSteps` filled in canonical playback order.
 */
export function isMeaningfulPlaybackStep(step: PlaybackStep | undefined): boolean {
  if (!step) return false;
  if (step.kind === "travel") return false;
  if (step.kind === "stop") return chapterDensityForMedia(step.media) === "empty";
  return true;
}

/** The indexes of the beats next / back may land on. */
export function meaningfulPlaybackStepIndexes(steps: readonly PlaybackStep[]): number[] {
  return steps.flatMap((step, index) => (isMeaningfulPlaybackStep(step) ? [index] : []));
}

/**
 * The one implementation of "the next meaningful moment in this direction".
 *
 * It takes the meaningful indexes rather than the steps so the elapsed-time
 * plan (`journeyPlaybackPlan.ts`, which already carries
 * `meaningfulStepIndexes`) and `playbackReducer` share this scan instead of
 * keeping a second copy that can drift from it. Landing on nothing keeps the
 * current beat: reaching the end of the Journey is not a reason to jump.
 */
export function meaningfulPlaybackStepIndex(
  meaningfulStepIndexes: readonly number[],
  currentStepIndex: number,
  direction: 1 | -1,
): number {
  const found = direction > 0
    ? meaningfulStepIndexes.find((index) => index > currentStepIndex)
    : [...meaningfulStepIndexes].reverse().find((index) => index < currentStepIndex);
  if (found !== undefined) return found;
  return Math.min(Math.max(0, currentStepIndex), Math.max(0, meaningfulStepIndexes.at(-1) ?? 0));
}

/**
 * Reduce a playback control against the current step index. Pure: returns the
 * next step index (and pause flag) without touching timers or DOM.
 */
export function playbackReducer(
  journey: Journey,
  state: PlaybackState,
  control: PlaybackControl,
  homeContext?: HomeNarrativeContext | null,
): PlaybackState {
  const steps = buildPlaybackSteps(journey, homeContext);
  const lastIndex = steps.length - 1;

  const stateForStep = (stepIndex: number): PlaybackState => {
    const phase = phaseForStep(steps[stepIndex]);
    return state.paused
      ? { stepIndex, phase: { type: "paused", previous: phase }, paused: true }
      : { stepIndex, phase, paused: false };
  };

  switch (control.type) {
    case "pause":
      return state.paused || isPlaybackTerminalState(state)
        ? state
        : { ...state, paused: true, phase: { type: "paused", previous: state.phase } };
    case "resume":
      return state.paused && state.phase.type === "paused"
        ? { ...state, paused: false, phase: state.phase.previous }
        : state;
    case "advance": {
      if (isPlaybackTerminalState(state)) return state;
      if (state.paused) {
        const next = meaningfulPlaybackStepIndex(
          meaningfulPlaybackStepIndexes(steps),
          state.stepIndex,
          1,
        );
        return stateForStep(next);
      }
      if (state.stepIndex >= lastIndex) {
        return { stepIndex: lastIndex, phase: { type: "completed" }, paused: false };
      }
      return stateForStep(state.stepIndex + 1);
    }
    case "next": {
      if (isPlaybackTerminalState(state)) return state;
      const next = meaningfulPlaybackStepIndex(meaningfulPlaybackStepIndexes(steps), state.stepIndex, 1);
      return stateForStep(next);
    }
    case "previous": {
      const previous = meaningfulPlaybackStepIndex(
        meaningfulPlaybackStepIndexes(steps),
        state.stepIndex,
        -1,
      );
      return stateForStep(previous);
    }
    case "back": {
      const previous = state.paused
        ? meaningfulPlaybackStepIndex(
          meaningfulPlaybackStepIndexes(steps),
          state.stepIndex,
          -1,
        )
        : Math.max(0, state.stepIndex - 1);
      return stateForStep(previous);
    }
    case "replay":
      return initialPlaybackState(homeContext);
    case "seek": {
      const stepIndex = Math.min(lastIndex, Math.max(0, Math.trunc(control.stepIndex)));
      return stateForStep(stepIndex);
    }
    case "exit":
      return state;
  }
}

export function phaseForStep(step: PlaybackStep): JourneyPlaybackPhase {
  switch (step.kind) {
    case "home-prelude":
      return { type: "home-prelude", homeBaseId: step.cameraTarget.homeBaseId };
    case "intro":
      return { type: "intro" };
    case "travel":
      return { type: "travel", from: step.from ?? Math.max(0, step.to - 1), to: step.to };
    case "stop":
      return { type: "stop", pointIndex: step.pointIndex };
    case "media":
      return { type: "media", pointIndex: step.pointIndex, mediaIndex: step.mediaIndex };
    case "home-epilogue":
      return { type: "home-epilogue", homeBaseId: step.cameraTarget.homeBaseId };
    case "outro":
      return { type: "outro" };
  }
}

/**
 * The asset the director may hold on for a step: a media step's own asset, and
 * a stop step's first image — the frame the stop phase waits to decode.
 */
export function playbackHoldTargetMedia(
  journey: Journey,
  step: PlaybackStep | undefined,
): JourneyMediaAsset | null {
  if (step?.kind === "stop") {
    return playbackMediaForPoint(journey, step.pointIndex)
      .find((asset) => asset.mimeType.startsWith("image/")) ?? null;
  }
  return playbackMediaForStep(journey, step);
}

export function playbackMediaForStep(
  journey: Journey,
  step: PlaybackStep | undefined,
): JourneyMediaAsset | null {
  if (step?.kind !== "media") return null;
  return playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex] ?? null;
}
