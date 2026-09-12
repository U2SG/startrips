import {
  HOME_BASE_CLUSTER_RADIUS_KM,
  inferHomeBaseCandidate,
  type HomeBaseDismissal,
  type HomeBaseEvidenceReasonCode,
  type HomeBaseInferenceInput,
  type HomeBaseInferenceJourney,
  type HomeBaseInferenceResult,
  type HomeBaseMetroAnchor,
} from "./homeBaseInference";
import type { HomeBasePeriod } from "./homeBase";
import { haversineDistanceKm } from "./mediaPlacement";

/**
 * #232: the surface layer above the frozen V1 inference core.
 *
 * `homeBaseInference.ts` deliberately returns a state, an anchor and reason
 * codes and no copy at all. This module is the other half of that split: it
 * decides whether a quiet card is shown, which two actions it offers and which
 * words explain the evidence. It holds no thresholds of its own, reads no
 * network and touches no React, so the whole decision is checkable in the
 * default node environment of the `core` lane.
 *
 * Two product rules from the issue are encoded here rather than in the shell:
 *
 * 1. The copy explains the evidence — 「最近几段旅程经常从…附近开始或结束」 —
 *    instead of announcing a conclusion about the member. The banned form is
 *    「我们检测到你居住在…」 and nothing here can produce it: every sentence is
 *    written about Journeys, not about the person.
 * 2. Only `suggested` and `move_suggested` are visible. `candidate` is the
 *    core's internal confidence and `dismissed` is an answer already given, so
 *    both resolve to no card — an internal state must never become a prompt.
 */

/**
 * The evidence explanation for every reason code the core can emit. A
 * `Record` over the exported union, so adding a code to the core without a
 * sentence here fails the typecheck rather than rendering a blank line.
 */
export const HOME_BASE_EVIDENCE_REASON_COPY: Record<HomeBaseEvidenceReasonCode, string> = {
  NO_ROUTE_ENDPOINT_EVIDENCE: "还没有足够的旅程起点和终点可以参考。",
  CANDIDATE_JOURNEY_THRESHOLD_MET: "有几段不同的旅程落在同一片区域。",
  CANDIDATE_SPAN_THRESHOLD_MET: "这些旅程分布在一段时间里，不是同一次出行。",
  SUGGESTED_JOURNEY_THRESHOLD_MET: "已经有四段以上不同的旅程落在这片区域。",
  SUGGESTED_SPAN_THRESHOLD_MET: "这些记录横跨了三个月以上。",
  START_SUPPORT_THRESHOLD_MET: "有多段旅程从这附近开始。",
  END_SUPPORT_THRESHOLD_MET: "有多段旅程回到这附近。",
  LEADER_MARGIN_THRESHOLD_MET: "这片区域比其它区域明显更常出现。",
  MATCHES_CONFIRMED_HOME: "和你已经确认的常住地是同一片区域。",
  DIFFERS_FROM_CONFIRMED_HOME: "和你已经确认的常住地不在同一片区域。",
  SOFT_DISMISSAL_ACTIVE: "你选择过暂时不用，这里先不再打扰。",
  REJECTED_DISMISSAL_ACTIVE: "你说过这里不是常住地，这里不再提示。",
};

export const HOME_BASE_EVIDENCE_REASON_CODES = Object.keys(
  HOME_BASE_EVIDENCE_REASON_COPY,
) as readonly HomeBaseEvidenceReasonCode[];

export type HomeBaseSuggestionActionKind =
  | "confirm"
  | "confirm_move"
  | "dismiss_soft"
  | "dismiss_rejected";

export type HomeBaseSuggestionAction = {
  kind: HomeBaseSuggestionActionKind;
  label: string;
};

export type HomeBaseSuggestionDecision = {
  visible: boolean;
  variant: "none" | "initial" | "move";
  headline: string | null;
  question: string | null;
  evidenceCopy: string | null;
  reasonCopy: readonly string[];
  primaryAction: HomeBaseSuggestionAction | null;
  secondaryAction: HomeBaseSuggestionAction | null;
  /** The issue's optional third affordance, 「不是深圳」. Never on a move card. */
  rejectAction: HomeBaseSuggestionAction | null;
  placeLabel: string | null;
  metroAnchor: HomeBaseMetroAnchor | null;
  evidenceDigest: string | null;
  proposedPeriodStart: string | null;
};

export type HomeBaseSuggestionInput = {
  result: HomeBaseInferenceResult;
  /**
   * The Place Label the card names, supplied by the caller from the member's
   * own Route Points. Never reverse-geocoded and never invented: without one
   * there is no truthful way to name the region, so there is no card.
   */
  placeLabel: string | null;
  /** The label of the currently confirmed period, for the move card's 「保持…」. */
  confirmedPlaceLabel?: string | null;
  /**
   * Story and Playback own the screen while they are open. The issue's
   * anti-nag rule is explicit that Home Base setup never interrupts either,
   * so the suppression lives in the decision rather than in a JSX condition
   * that a second call site could forget.
   */
  narrativeSurfaceActive?: boolean;
};

const HIDDEN: HomeBaseSuggestionDecision = {
  visible: false,
  variant: "none",
  headline: null,
  question: null,
  evidenceCopy: null,
  reasonCopy: [],
  primaryAction: null,
  secondaryAction: null,
  rejectAction: null,
  placeLabel: null,
  metroAnchor: null,
  evidenceDigest: null,
  proposedPeriodStart: null,
};

function hidden(): HomeBaseSuggestionDecision {
  return HIDDEN;
}

/**
 * When every recorded Home period is closed, a new confirmation can only start
 * at or after the end of the latest recorded period: the V1 confirmation draft
 * is open-ended and #231 will reject an earlier start as an overlap. Historical
 * Journeys therefore cannot lend support to the next open Home hypothesis.
 *
 * Keep this conservative at the Journey boundary instead of rewriting endpoint
 * kinds. A Journey that started before the boundary may have ended after it, but
 * turning that lone return point into a synthetic "start" would distort the
 * frozen start/end-support contract. Later Journeys can establish the next Home
 * on their own; if they cannot, the quiet card stays hidden.
 */
export function homeBaseInferenceJourneysAfterRecordedHistory(
  journeys: readonly HomeBaseInferenceJourney[],
  periods: readonly HomeBasePeriod[],
): HomeBaseInferenceJourney[] {
  if (periods.some((period) => period.endedOn === null)) return [...journeys];
  const latestRecordedEnd = periods.reduce<string | null>((latest, period) => {
    if (period.endedOn === null) return latest;
    return latest === null || period.endedOn > latest ? period.endedOn : latest;
  }, null);
  if (latestRecordedEnd === null) return [...journeys];
  return journeys.filter((journey) => journey.startedOn >= latestRecordedEnd);
}

/**
 * Run the frozen inference core against every persisted answer and keep the
 * answer that the core itself says applies to the current evidence region.
 *
 * The persistence layer can now retain answers for several regions. We do not
 * duplicate the core's 25 km / 90 day / two-new-Journeys matching policy here:
 * each saved answer is offered back to `inferHomeBaseCandidate`, and only a
 * result that becomes `dismissed` is considered a match. An explicit rejection
 * wins over a soft dismissal when multiple historical revisions of the same
 * region still match.
 */
export function inferHomeBaseCandidateWithDismissals(
  input: Omit<HomeBaseInferenceInput, "dismissal">,
  dismissals: readonly HomeBaseDismissal[],
): HomeBaseInferenceResult {
  const baseline = inferHomeBaseCandidate(input);
  let selected: { dismissal: HomeBaseDismissal; result: HomeBaseInferenceResult } | null = null;
  for (const dismissal of dismissals) {
    const result = inferHomeBaseCandidate({ ...input, dismissal });
    if (result.state !== "dismissed") continue;
    if (
      !selected
      || (dismissal.kind === "rejected" && selected.dismissal.kind !== "rejected")
      || (dismissal.kind === selected.dismissal.kind && dismissal.dismissedAt > selected.dismissal.dismissedAt)
      || (
        dismissal.kind === selected.dismissal.kind
        && dismissal.dismissedAt === selected.dismissal.dismissedAt
        && dismissal.digest < selected.dismissal.digest
      )
    ) {
      selected = { dismissal, result };
    }
  }
  return selected?.result ?? baseline;
}

export function resolveHomeBaseSuggestion(
  input: HomeBaseSuggestionInput,
): HomeBaseSuggestionDecision {
  const { result, placeLabel } = input;
  if (input.narrativeSurfaceActive) return hidden();
  if (result.state !== "suggested" && result.state !== "move_suggested") return hidden();
  if (!placeLabel || !result.metroAnchor || !result.evidenceDigest) return hidden();

  const reasonCopy = result.reasonCodes.map(
    (code) => HOME_BASE_EVIDENCE_REASON_COPY[code],
  );
  const shared = {
    visible: true,
    evidenceCopy: `最近几段旅程经常从${placeLabel}附近开始或结束。`,
    reasonCopy,
    placeLabel,
    metroAnchor: result.metroAnchor,
    evidenceDigest: result.evidenceDigest,
  };

  if (result.state === "move_suggested") {
    const confirmed = input.confirmedPlaceLabel?.trim();
    return {
      ...shared,
      variant: "move",
      headline: `最近你的记录更多从${placeLabel}附近开始和结束。`,
      question: `要把${placeLabel}作为新的常住地吗？`,
      primaryAction: { kind: "confirm_move", label: "设为新的常住地" },
      secondaryAction: {
        kind: "dismiss_soft",
        label: confirmed ? `保持${confirmed}` : "暂时不用",
      },
      rejectAction: null,
      proposedPeriodStart: result.proposedPeriodStart,
    };
  }

  return {
    ...shared,
    variant: "initial",
    headline: `看起来${placeLabel}是你这一阶段经常出发和回来的地方。`,
    question: "设为常住地？",
    primaryAction: { kind: "confirm", label: "设为常住地" },
    secondaryAction: { kind: "dismiss_soft", label: "暂时不用" },
    rejectAction: { kind: "dismiss_rejected", label: `不是${placeLabel}` },
    proposedPeriodStart: null,
  };
}

export type HomeBasePlaceLabelRoutePoint = {
  id: string;
  sortOrder: number;
  latitude: number;
  longitude: number;
  label: string | null;
};

export type HomeBasePlaceLabelJourney = {
  id: string;
  routePoints: readonly HomeBasePlaceLabelRoutePoint[];
};

type HomeBasePlaceLabelEvidenceSupport = {
  supportsStart: boolean;
  supportsEnd: boolean;
};

function placeLabelEvidenceSupport(
  digest: string | null,
): ReadonlyMap<string, HomeBasePlaceLabelEvidenceSupport> | null {
  if (!digest) return null;
  const parts = digest.split(":");
  if (parts.length !== 8) return null;
  const expectedCount = Number(parts[3]);
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return null;

  const supports = new Map<string, HomeBasePlaceLabelEvidenceSupport>();
  if (parts[6].length > 0) {
    for (const encodedSupport of parts[6].split(",")) {
      const separator = encodedSupport.lastIndexOf("=");
      const flags = encodedSupport.slice(separator + 1);
      if (separator <= 0 || !/^[01][01]$/.test(flags)) return null;
      let journeyId: string;
      try {
        journeyId = decodeURIComponent(encodedSupport.slice(0, separator));
      } catch {
        return null;
      }
      if (!journeyId || supports.has(journeyId)) return null;
      supports.set(journeyId, {
        supportsStart: flags[0] === "1",
        supportsEnd: flags[1] === "1",
      });
    }
  }
  return supports.size === expectedCount ? supports : null;
}

function sortedPlaceLabelRoutePoints(
  routePoints: readonly HomeBasePlaceLabelRoutePoint[],
): HomeBasePlaceLabelRoutePoint[] {
  return [...routePoints].sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id)
    || left.latitude - right.latitude
    || left.longitude - right.longitude
  ));
}

/**
 * The name the card uses, taken from the member's own Place Labels.
 *
 * The core returns a metro anchor and no name, and V1 has no reverse geocoder
 * it is allowed to call — `LOCATION_SEARCH_DRIVER=disabled` must degrade
 * truthfully. So the label is the most frequent Place Label the member already
 * wrote on a supporting Journey endpoint inside the region, and `null` when
 * they never wrote one. A card with no honest evidence-backed name is simply
 * not shown.
 *
 * When `evidenceDigest` is supplied, its readable support token is the authority
 * for exactly which Journey starts/ends produced the inference. This keeps a
 * future plan or an unfinished Journey end from naming a suggestion it did not
 * support. Invalid evidence fails closed instead of widening back to every
 * endpoint. Omitting the digest preserves the generic helper behavior for
 * callers that are not rendering an inference result.
 *
 * Ties break lexicographically so the same Atlas always produces the same
 * name, whatever order the Journeys arrive in.
 */
export function resolveHomeBasePlaceLabel(
  journeys: readonly HomeBasePlaceLabelJourney[],
  anchor: HomeBaseMetroAnchor | null,
  evidenceDigest?: string | null,
): string | null {
  if (!anchor) return null;
  const evidenceSupport = evidenceDigest === undefined
    ? undefined
    : placeLabelEvidenceSupport(evidenceDigest);
  if (evidenceDigest !== undefined && evidenceSupport === null) return null;

  const counts = new Map<string, number>();
  for (const journey of journeys) {
    const support = evidenceSupport?.get(journey.id);
    if (evidenceSupport && !support) continue;
    const points = sortedPlaceLabelRoutePoints(journey.routePoints);
    if (points.length === 0) continue;
    const endpoints = points.length === 1
      ? [{ kind: "start" as const, point: points[0] }]
      : [
          { kind: "start" as const, point: points[0] },
          { kind: "end" as const, point: points[points.length - 1] },
        ];
    // One Journey contributes each distinct label once, mirroring the core's
    // one-Journey-one-support rule: a return trip must not count the same label
    // twice even when both supported endpoints carry it.
    const seen = new Set<string>();
    for (const endpoint of endpoints) {
      if (support && (
        (endpoint.kind === "start" && !support.supportsStart)
        || (endpoint.kind === "end" && !support.supportsEnd)
      )) continue;
      const { point } = endpoint;
      const label = point.label?.trim();
      if (!label || seen.has(label)) continue;
      if (
        haversineDistanceKm(anchor.latitude, anchor.longitude, point.latitude, point.longitude)
        > HOME_BASE_CLUSTER_RADIUS_KM
      ) continue;
      seen.add(label);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && label < best)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

export type HomeBasePeriodDraft = {
  label: string;
  latitude: number;
  longitude: number;
  startedOn: string;
  endedOn: null;
  source: "suggested-confirmed";
};

/**
 * The body a confirmation posts to `POST /api/home-bases`.
 *
 * A move sends `proposedPeriodStart`, which is what makes #231 close the
 * previous period on that day inside one transaction instead of overwriting
 * it — the earlier period survives with its own bounded dates and the Journeys
 * that fall inside it keep resolving to it. A first confirmation has no
 * previous period to close and starts at the earliest supporting evidence, the
 * "reasonable inferred period" the issue asks to show and let the member adjust
 * later.
 */
export function homeBaseConfirmationDraft(
  decision: HomeBaseSuggestionDecision,
  result: HomeBaseInferenceResult,
): HomeBasePeriodDraft | null {
  if (!decision.visible || !decision.placeLabel || !decision.metroAnchor) return null;
  const startedOn = decision.variant === "move"
    ? decision.proposedPeriodStart
    : result.support.evidenceStartedOn;
  if (!startedOn) return null;
  return {
    label: decision.placeLabel,
    latitude: decision.metroAnchor.latitude,
    longitude: decision.metroAnchor.longitude,
    startedOn,
    endedOn: null,
    source: "suggested-confirmed",
  };
}
