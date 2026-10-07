import {
  buildDeterministicQuickRecapPlan,
  type AutoEditPlanItemV1,
  type AutoEditPlanV1,
  type AutoEditTempo,
  type MediaDigestV1,
  type QuickRecapRouteGeometryV1,
} from "./autoEditPlan";
import {
  playbackMediaByChapter,
  playbackMediaForPoint,
  playbackNoteBeatRoutePointIds,
  playbackTravelAngularDistance,
  type PlaybackStep,
  type PlaybackJourney,
} from "./journeyPlayback";
import type { HomeNarrativeContext, HomeNarrativeBeatDecision } from "./homeBasePrelude";
import { isSoundtrackAsset, isVisualMediaAsset } from "./journeyModel";
import { UNMEASURED_VIDEO_DURATION_MS, resolveNarrativeTiming, resolveNoteBeatDwellMs } from "./narrativeTiming";
import type { VideoTrimWindow } from "./videoTrimPlayback";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

export const QUICK_RECAP_TARGET_MS = 45_000;

// #195 Phase 1: no video duration is persisted with a media asset and the
// browser cannot read one synchronously here, so a video digest declares this
// explicit analysis-pending duration instead of an empty `intrinsic`. The
// plan's video eligibility rule rejects an absent, non-finite, or non-positive
// duration, which would delete the route point's only chapter — the regression
// this replaces. The resolver owns the one number for "how long an unmeasured
// video is worth"; because it exceeds every per-tempo video dwell, the
// planner's own clamp still decides the real length.
export const QUICK_RECAP_PENDING_VIDEO_DURATION_MS = UNMEASURED_VIDEO_DURATION_MS;

export type PreparedQuickRecapPlayback = {
  journey: PlaybackJourney;
  plan: AutoEditPlanV1;
  homeNarrativeContext?: HomeNarrativeContext;
};

export type QuickRecapFallbackReason = "no-visual-media" | "over-budget";

function homeBeatCostMs(
  decision: HomeNarrativeBeatDecision,
  kind: "home-prelude" | "home-epilogue",
  tempo: AutoEditTempo,
) {
  return decision.eligible
    ? resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: kind })
    : 0;
}

/**
 * Actual Journey memories own the Quick Recap target. Home ceremony is admitted
 * only when every otherwise-eligible Home beat fits in the unused envelope; a
 * partial pair is not manufactured merely because one side happened to fit.
 */
export function fitHomeNarrativeContextToQuickRecapBudget(
  context: HomeNarrativeContext,
  remainingMs: number,
  tempo: AutoEditTempo,
): HomeNarrativeContext {
  const requiredMs = homeBeatCostMs(context.prelude, "home-prelude", tempo)
    + homeBeatCostMs(context.epilogue, "home-epilogue", tempo);
  if (requiredMs <= Math.max(0, remainingMs)) return context;
  const omit = (decision: HomeNarrativeBeatDecision): HomeNarrativeBeatDecision => (
    decision.eligible ? { eligible: false, reason: "quick-recap-budget" } : decision
  );
  return { prelude: omit(context.prelude), epilogue: omit(context.epilogue) };
}

export type QuickRecapPreparationResult =
  | { playback: PreparedQuickRecapPlayback; fallbackReason: null }
  | { playback: null; fallbackReason: QuickRecapFallbackReason };

function visualMediaType(asset: JourneyMediaAsset): "image" | "video" {
  return asset.mimeType.startsWith("video/") ? "video" : "image";
}

function firstPlaybackChapterId(journey: Journey): string | null {
  const byChapter = playbackMediaByChapter(journey);
  return journey.routePoints.find((point) => point.isStop || (byChapter.get(point.id)?.length ?? 0) > 0)?.id ?? null;
}

// The explicit Journey cover opens the recap as the first chapter hero, but
// only when moving it cannot empty the route point that owns it. When the cover
// is that point's only visual media, relocating it would leave the chapter
// without a single candidate and the route point would disappear from the recap
// — the same topology loss as #195 itself. Such a cover stays where it belongs
// and simply does not open the recap; it still carries the cover user signal,
// so it remains its own chapter's mandatory representative.
function openingCoverAsset(
  journey: Journey,
  visualMedia: readonly JourneyMediaAsset[],
): JourneyMediaAsset | null {
  const firstRoutePointId = firstPlaybackChapterId(journey);
  if (!firstRoutePointId || !journey.coverMediaAssetId) return null;
  const cover = visualMedia.find((asset) => asset.id === journey.coverMediaAssetId);
  if (!cover) return null;
  if (cover.routePointId === null || cover.routePointId === firstRoutePointId) return cover;
  const ownerKeepsVisualMedia = visualMedia.some((asset) => (
    asset.id !== cover.id && asset.routePointId === cover.routePointId
  ));
  return ownerKeepsVisualMedia ? cover : null;
}

// #195: Startrips is photo-first, not photo-only. Every playable visual asset
// is a recap candidate so a route point whose only media is a video keeps its
// chapter; only the soundtrack is excluded, matching Full Playback's chapter
// stream (`playbackMediaForPoint`).
function runtimeVisualCandidates(journey: Journey): JourneyMediaAsset[] {
  const firstRoutePointId = firstPlaybackChapterId(journey);
  const visualMedia = journey.media.filter(isVisualMediaAsset);
  const openingCoverId = openingCoverAsset(journey, visualMedia)?.id ?? null;
  return visualMedia
    .flatMap((asset) => {
      if (asset.id === openingCoverId && firstRoutePointId) {
        // Playback projection only: synthetic ordering is scoped to the
        // projection; persisted ownership/sort order remain untouched.
        return [{ ...asset, routePointId: firstRoutePointId, sortOrder: Number.MIN_SAFE_INTEGER }];
      }
      if (asset.routePointId !== null) return [asset];
      if (firstRoutePointId) {
        // Journey-scoped visual media is a valid presentation scope, but the live
        // Playback step model only renders media inside route-point chapters.
        // Project them into the first playable chapter for Quick Recap only.
        return [{ ...asset, routePointId: firstRoutePointId }];
      }
      return [];
    })
    // Cover-first ordering applies only to a relocated cover. A cover left with
    // its own route point must keep its natural source order, so it cannot be
    // hoisted ahead of the chapters that precede it.
    .sort((left, right) => {
      if (left.id === openingCoverId && right.id !== openingCoverId) return -1;
      if (right.id === openingCoverId && left.id !== openingCoverId) return 1;
      return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
    });
}

export function quickRecapDigestsForJourney(journey: Journey): MediaDigestV1[] {
  const candidates = runtimeVisualCandidates(journey);
  const chapterByAssetId = new Map<string, string>();
  for (const [chapterId, media] of playbackMediaByChapter({ ...journey, media: candidates })) {
    for (const asset of media) chapterByAssetId.set(asset.id, chapterId);
  }
  return candidates.map<MediaDigestV1>((asset, sourceIndex) => {
    const mediaType = visualMediaType(asset);
    const duplicateClusterId = asset.contentHashVerified === true
      ? asset.contentHash || undefined
      : undefined;
    return {
      schemaVersion: 1,
      assetId: asset.id,
      journeyId: journey.id,
      routePointId: chapterByAssetId.get(asset.id) ?? asset.routePointId,
      sourceRevision: String(journey.revision),
      mediaType,
      mimeType: asset.mimeType,
      sourceIndex,
      intrinsic: mediaType === "video"
        ? { durationMs: QUICK_RECAP_PENDING_VIDEO_DURATION_MS }
        : {},
      ...(duplicateClusterId ? { similarity: { duplicateClusterId } } : {}),
      userSignals: {
        isJourneyCover: asset.id === journey.coverMediaAssetId,
        pinnedForRecap: false,
        excludedFromRecap: false,
      },
    };
  });
}

function noteLengthFor(point: RoutePoint) {
  return point.note?.trim().length ?? 0;
}

/**
 * Chapter travel keeps every canonical shaping segment between the previous
 * chapter and the next. Empty Stops remain chapters; shaping vias never own a
 * camera destination or arrival, and never replace the previous chapter here.
 */
export function quickRecapRouteGeometry(
  journey: Journey,
  candidateRoutePointIds: readonly string[],
): Record<string, QuickRecapRouteGeometryV1> {
  const byId = new Map(journey.routePoints.map((point, index) => [point.id, { point, index }]));
  const byChapter = playbackMediaByChapter(journey);
  const geometry: Record<string, QuickRecapRouteGeometryV1> = {};
  let previousIndex = 0;
  for (const routePointId of candidateRoutePointIds) {
    const current = byId.get(routePointId);
    if (!current) continue;
    const { point, index: pointIndex } = current;
    geometry[routePointId] = {
      // The first point has no leg in front of it, so it resolves to the floor.
      ...(pointIndex > 0 ? { angularDistanceFromPrevious: playbackTravelAngularDistance(journey, pointIndex, previousIndex) } : {}),
      noteLength: noteLengthFor(point),
      isStop: point.isStop,
    };
    if (point.isStop || (byChapter.get(point.id)?.length ?? 0) > 0) previousIndex = pointIndex;
  }
  return geometry;
}

/**
 * #595: the note beats a recap plays and what they cost.
 *
 * Decided on the canonical Journey and carried on the prepared projection, so
 * a Route Point whose media the plan leaves out does not become an extra,
 * unbudgeted note beat. Every one of them is paid for before media is chosen,
 * exactly like the intro and outro, so a note is never dropped to make room:
 * a recap that cannot fit them falls back to the over-budget choice instead.
 */
export function quickRecapNoteBeats(journey: Journey): { routePointIds: Set<string>; durationMs: number } {
  const routePointIds = playbackNoteBeatRoutePointIds(journey);
  let durationMs = 0;
  for (const point of journey.routePoints) {
    if (routePointIds.has(point.id)) durationMs += resolveNoteBeatDwellMs(noteLengthFor(point));
  }
  return { routePointIds, durationMs };
}

export type QuickRecapPreparationOptions = {
  generatedAt: string;
  targetDurationMs?: number;
  tempo?: AutoEditTempo;
  homeNarrativeContext?: HomeNarrativeContext | null;
  /**
   * A faster tempo to re-plan at when the requested tempo either cannot fit
   * the Stops alone or fits them with no room for a single media-bearing
   * transit via. A long Journey's Stops can spend the whole 45 s at standard
   * tempo, which answers "quick recap" with the Stops' photos only; at a
   * faster tempo the same budget carries the vias too. The returned plan's
   * `tempo` says which tempo was used, and the director starts at it.
   */
  tempoFallback?: AutoEditTempo | null;
};

/** Whether the plan carries at least one transit via (a non-Stop route point) chapter. */
function planRepresentsTransitVia(
  plan: AutoEditPlanV1,
  geometry: Record<string, QuickRecapRouteGeometryV1>,
): boolean {
  return plan.chapters.some((chapter) =>
    chapter.routePointId !== null && geometry[chapter.routePointId]?.isStop === false && chapter.items.length > 0);
}

export function prepareQuickRecapPlaybackResult(
  journey: Journey,
  options: QuickRecapPreparationOptions,
): QuickRecapPreparationResult {
  const { tempoFallback = null, ...requested } = options;
  const first = prepareQuickRecapPlaybackAtTempo(journey, requested);
  if (!tempoFallback || tempoFallback === (requested.tempo ?? "standard")) return first;
  const geometry = quickRecapRouteGeometry(journey, quickRecapCandidateRoutePointIds(journey));
  const viaCandidatesExist = Object.values(geometry).some((entry) => entry.isStop === false);
  const needsFallback = first.playback
    ? viaCandidatesExist && !planRepresentsTransitVia(first.playback.plan, geometry)
    : first.fallbackReason === "over-budget";
  if (!needsFallback) return first;
  const faster = prepareQuickRecapPlaybackAtTempo(journey, { ...requested, tempo: tempoFallback });
  if (!faster.playback) return first;
  // A faster plan is only an improvement when it brings a via in; otherwise the
  // slower, calmer plan that already fits is the better recap.
  if (first.playback && !planRepresentsTransitVia(faster.playback.plan, geometry)) return first;
  return faster;
}

function quickRecapCandidateRoutePointIds(journey: Journey): string[] {
  const digests = quickRecapDigestsForJourney(journey);
  return journey.routePoints
    .filter((point) => point.isStop || digests.some((digest) => digest.routePointId === point.id))
    .map((point) => point.id);
}

function prepareQuickRecapPlaybackAtTempo(
  journey: Journey,
  options: Omit<QuickRecapPreparationOptions, "tempoFallback">,
): QuickRecapPreparationResult {
  if (journey.routePoints.length === 0) return { playback: null, fallbackReason: "no-visual-media" };
  const digests = quickRecapDigestsForJourney(journey);
  if (digests.length === 0) return { playback: null, fallbackReason: "no-visual-media" };

  const candidateRoutePointIds = journey.routePoints
    .filter((point) => point.isStop || digests.some((digest) => digest.routePointId === point.id))
    .map((point) => point.id);
  if (candidateRoutePointIds.length === 0) return { playback: null, fallbackReason: "no-visual-media" };

  const requestedTargetMs = options.targetDurationMs ?? QUICK_RECAP_TARGET_MS;
  const tempo = options.tempo ?? "standard";
  // The recap's chapter budget is what is left of the target once the intro and
  // outro beats are paid for. Those two are the only beats the director still
  // times itself (`quickRecapStepDurationMs` returns undefined for them), so the
  // budget must subtract the numbers that actually play — the resolver's
  // per-tempo intro/outro — instead of the flat 1200 + 1800 the deleted legacy
  // pacing table carried, which no mode has spent since the tempo profiles
  // landed.
  const noteBeats = quickRecapNoteBeats(journey);
  const chapterBudgetMs = Math.max(
    1,
    requestedTargetMs
      - resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "intro" })
      - resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "outro" })
      - noteBeats.durationMs,
  );
  const plan = buildDeterministicQuickRecapPlan({
    journeyId: journey.id,
    journeyRevision: String(journey.revision),
    routePointIds: candidateRoutePointIds,
    digests,
    targetDurationMs: chapterBudgetMs,
    tempo,
    generatedAt: options.generatedAt,
    routePointGeometry: quickRecapRouteGeometry(journey, candidateRoutePointIds),
  });
  if (plan.plannedDurationMs > chapterBudgetMs) return { playback: null, fallbackReason: "over-budget" };
  const selectedIds = new Set(plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId)));
  if (selectedIds.size === 0) return { playback: null, fallbackReason: "no-visual-media" };

  // The plan controls presentation placement. Keep selected canonical assets
  // untouched so Close/return and Story still resolve the original child owner.
  const selectedMedia = journey.media.filter((asset) => isSoundtrackAsset(asset) || selectedIds.has(asset.id));
  const selectedAssets = new Map(selectedMedia.map((asset) => [asset.id, asset]));
  const chapterMedia = new Map(plan.chapters.map((chapter) => [
    chapter.routePointId,
    chapter.items.flatMap((item) => {
      const asset = selectedAssets.get(item.assetId);
      return asset ? [asset] : [];
    }),
  ]));
  const introMs = resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "intro" });
  const outroMs = resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: "outro" });
  const homeNarrativeContext = options.homeNarrativeContext
    ? fitHomeNarrativeContextToQuickRecapBudget(
      options.homeNarrativeContext,
      requestedTargetMs - (plan.plannedDurationMs + introMs + outroMs + noteBeats.durationMs),
      tempo,
    )
    : undefined;

  return {
    fallbackReason: null,
    playback: {
      plan,
      journey: {
        ...journey,
        media: selectedMedia,
        chapterMedia,
        noteBeatRoutePointIds: noteBeats.routePointIds,
      },
      ...(homeNarrativeContext ? { homeNarrativeContext } : {}),
    },
  };
}

export function prepareQuickRecapPlayback(
  journey: Journey,
  options: {
    generatedAt: string;
    targetDurationMs?: number;
    tempo?: AutoEditTempo;
    homeNarrativeContext?: HomeNarrativeContext | null;
  },
): PreparedQuickRecapPlayback | null {
  return prepareQuickRecapPlaybackResult(journey, options).playback;
}

/**
 * The plan item a media step plays, together with the asset it renders.
 *
 * Both the beat's length and its trim window are read from the same item, so
 * they resolve through one lookup: a step whose route point has no chapter, or
 * whose asset the plan did not select, belongs to Full Playback and answers
 * `null` here.
 */
function quickRecapItemForStep(
  journey: Journey,
  step: PlaybackStep,
  plan: AutoEditPlanV1,
): { asset: JourneyMediaAsset; item: AutoEditPlanItemV1 } | null {
  if (step.kind !== "media") return null;
  const point = journey.routePoints[step.pointIndex];
  if (!point) return null;
  const chapter = plan.chapters.find((candidate) => candidate.routePointId === point.id);
  if (!chapter) return null;
  const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
  if (!asset) return null;
  const item = chapter.items.find((candidate) => candidate.assetId === asset.id);
  return item ? { asset, item } : null;
}

/**
 * #195 Phase 2: the trim window the runtime must honour for one media beat.
 *
 * This is the plan half of the trim-aware playback contract — the declared
 * `[inMs, outMs)` of the source that the step plays. `videoTrimPlayback.ts`
 * owns what to do with it against a real media element, including every way it
 * can degrade. Full Playback has no Edit Plan, so it never reaches this
 * resolver and keeps ending its video chapters on the real `ended` event.
 */
export function quickRecapStepTrim(
  journey: Journey,
  step: PlaybackStep,
  plan: AutoEditPlanV1,
): VideoTrimWindow | null {
  const found = quickRecapItemForStep(journey, step, plan);
  if (!found || !found.asset.mimeType.startsWith("video/")) return null;
  return found.item.trim ?? null;
}

/**
 * How long one Quick Recap beat lasts.
 *
 * The Edit Plan is the source of *what* plays, in what order, and for how long:
 * a step whose route point has no chapter, or whose asset the plan did not
 * select, resolves to `undefined` and falls through to Full Playback's timing;
 * every step the plan does own spends exactly the milliseconds the plan booked.
 * Camera, arrival and dwell are all read from the frozen plan rather than
 * re-resolved here, because the plan's greedy budget was measured against those
 * numbers — resolving independently is how the recap came to play 45.2 s
 * against a 45 s plan. The plan is now booked with real route geometry and note
 * length, so reading it back is still distance- and note-aware (decision D2),
 * and a tempo change rebuilds the plan rather than reinterpreting it (D1). The
 * resolver is left with one job here: a dwell the plan did not pin.
 *
 * `intro` / `outro` return `undefined` on purpose: the director spends the live
 * tempo profile for those two beats, and `prepareQuickRecapPlaybackResult`
 * budgets against the same numbers.
 */
export function quickRecapStepDurationMs(
  journey: Journey,
  step: PlaybackStep,
  plan: AutoEditPlanV1,
  tempo: AutoEditTempo = "standard",
): number | undefined {
  if (step.kind === "home-prelude" || step.kind === "home-epilogue") {
    return resolveNarrativeTiming({ mode: "quick-recap", tempo, segmentKind: step.kind });
  }
  if (step.kind === "intro" || step.kind === "outro") return undefined;
  // #595: a note beat reads for the shared note dwell; the recap budget
  // reserved exactly that before it chose media (`quickRecapNoteBeatsMs`).
  if (step.kind === "note") {
    return resolveNoteBeatDwellMs(journey.routePoints[step.pointIndex]?.note?.trim().length ?? 0);
  }
  const pointIndex = step.kind === "travel" ? step.to : step.pointIndex;
  const point = journey.routePoints[pointIndex];
  if (!point) return undefined;
  const chapter = plan.chapters.find((candidate) => candidate.routePointId === point.id);
  if (!chapter) return undefined;

  if (step.kind === "travel") return chapter.camera.durationMs;
  if (step.kind === "stop") {
    // Point 0 has no travel step in front of it, so its chapter camera is paid
    // for inside the stop. Every later chapter's camera belongs to the travel
    // step that flies into it, so folding it in again here would double-book.
    const firstPointCameraMs = step.pointIndex === 0 ? chapter.camera.durationMs : 0;
    return firstPointCameraMs + (chapter.arrival?.durationMs ?? 0);
  }

  const found = quickRecapItemForStep(journey, step, plan);
  if (!found) return undefined;
  const { asset, item } = found;
  if (item.dwellMs !== undefined) return item.dwellMs;
  if (item.trim) return item.trim.outMs - item.trim.inMs;
  return resolveNarrativeTiming({
    mode: "quick-recap",
    tempo,
    segmentKind: "media",
    mediaKind: visualMediaType(asset),
    mediaRole: item.photoRole,
  });
}

/**
 * Where playback lands after a Quick Recap plan rebuild.
 *
 * The rule: keep the same step when it survives the rebuild; otherwise land on
 * the nearest surviving step, searching backwards before forwards so a dropped
 * beat rewinds slightly instead of skipping content the viewer has not seen. If
 * nothing survives, clamp the old index into the new range.
 */
export function remapPlaybackStepIndex(
  previousIdentities: readonly string[],
  nextIdentities: readonly string[],
  stepIndex: number,
): number {
  if (nextIdentities.length === 0) return 0;
  const clampedNext = Math.min(Math.max(0, stepIndex), nextIdentities.length - 1);
  if (previousIdentities.length === 0) return clampedNext;
  const from = Math.min(Math.max(0, stepIndex), previousIdentities.length - 1);
  for (let offset = 0; offset < previousIdentities.length; offset += 1) {
    const candidates = offset === 0 ? [from] : [from - offset, from + offset];
    for (const candidate of candidates) {
      if (candidate < 0 || candidate >= previousIdentities.length) continue;
      const found = nextIdentities.indexOf(previousIdentities[candidate]);
      if (found >= 0) return found;
    }
  }
  return clampedNext;
}
