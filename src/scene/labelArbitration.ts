import type { RoutePointPresentation } from "./routePresentation";

/**
 * #374: one attention-aware collision policy for the two label families that
 * share the globe - Route Point labels and Place Labels.
 *
 * This module is a pure CONSUMER. The presentation roles it reads are produced
 * by `./routePresentation` (#373) and the screen coordinates it compares come
 * from the caller's current projection frame. It owns no clock, no selection,
 * no camera and no geography: it never converts, rounds or invents a
 * latitude/longitude, and it never removes a city from the dataset - it only
 * decides which already-projected labels are drawn this frame.
 */

export type RouteLabelPositionRole = "origin" | "intermediate" | "destination";

export type RouteLabelCandidate = {
  /** The Route Point's index inside its Journey; the deterministic tiebreak. */
  pointIndex: number;
  positionRole: RouteLabelPositionRole;
  presentation: RoutePointPresentation;
};

export function routeLabelPositionRole(
  pointIndex: number,
  pointCount: number,
): RouteLabelPositionRole {
  if (pointIndex <= 0) return "origin";
  return pointIndex >= pointCount - 1 ? "destination" : "intermediate";
}

/**
 * Attention outranks route position. The previous ladder gave origin and
 * destination a fixed bonus, so an optional endpoint label could consume the
 * budget the current narrative point needed - exactly what #374 forbids.
 */
export function routeLabelAttentionPriority(candidate: RouteLabelCandidate): number {
  if (candidate.presentation.attentionRole === "narrative-current") return 4;
  if (candidate.presentation.attentionRole === "selected") return 3;
  if (candidate.positionRole !== "intermediate") return 2;
  return candidate.presentation.semanticRole === "stop" ? 1 : 0;
}

/**
 * Temporal visibility is a separate input from selection: a Rewind that has not
 * reached a Route Point hides its label even when that point is the chosen
 * record, so no future place name is revealed ahead of the narrative.
 */
export function isRouteLabelEligible(
  candidate: RouteLabelCandidate,
  { compactMobileLayout }: { compactMobileLayout: boolean },
): boolean {
  if (!candidate.presentation.temporalVisible) return false;
  if (routeLabelAttentionPriority(candidate) >= 3) return true;
  if (candidate.positionRole !== "intermediate") return true;
  // Intermediate context is optional: a compact posture keeps only the attended
  // Route Point and the route's own endpoints, and a pass-through point never
  // earns a label on its own.
  return !compactMobileLayout && candidate.presentation.semanticRole === "stop";
}

export function compareRouteLabelCandidates(
  left: RouteLabelCandidate,
  right: RouteLabelCandidate,
): number {
  return routeLabelAttentionPriority(right) - routeLabelAttentionPriority(left)
    || left.pointIndex - right.pointIndex;
}

/**
 * The eligible Route Point labels in the order they may claim screen space.
 * Identical input yields an identical order, so a still globe cannot flicker
 * between two equally ranked labels.
 */
export function arbitrateRouteLabels(
  candidates: readonly RouteLabelCandidate[],
  options: { compactMobileLayout: boolean },
): number[] {
  return candidates
    .filter((candidate) => isRouteLabelEligible(candidate, options))
    .sort(compareRouteLabelCandidates)
    .map((candidate) => candidate.pointIndex);
}

export type LabelAnchor = { x: number; y: number };

/**
 * Two Route Points at the same coordinates project onto one anchor. They stay
 * two records with their own identity - only the visual label is arbitrated, so
 * the lower-priority one is not drawn on top of the focused one and no endpoint
 * is nudged to manufacture a second place.
 */
export const COINCIDENT_LABEL_ANCHOR_EPSILON_PX = 0.75;

export function isCoincidentLabelAnchor(
  left: LabelAnchor,
  right: LabelAnchor,
  epsilonPx = COINCIDENT_LABEL_ANCHOR_EPSILON_PX,
): boolean {
  return Math.abs(left.x - right.x) <= epsilonPx && Math.abs(left.y - right.y) <= epsilonPx;
}

/**
 * Compare label texts by identity rather than by bytes: case, diacritics,
 * punctuation and spacing differ between the Route Point's own label and the
 * place dataset's name for the same place.
 */
export function normalizeLabelIdentity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export type PlacedRouteLabel = {
  /** Normalized identity of the Route Point's own label text. */
  identity: string;
  /** Projected Route Point anchor in CSS pixels. */
  anchor: LabelAnchor;
};

/**
 * A Place Label whose box does not overlap a Route Point label can still repeat
 * it a few pixels away. Suppress that repetition only when BOTH hold: the names
 * are equivalent AND the two anchors are in the same vicinity on screen. Name
 * equivalence alone would be geographic deduplication by string - two different
 * places that share a name must both keep their label.
 */
export const PLACE_LABEL_VICINITY_PX = 44;

export function isPlaceLabelRedundant(
  {
    names,
    anchor,
    placedRouteLabels,
    vicinityPx = PLACE_LABEL_VICINITY_PX,
  }: {
    names: readonly (string | null | undefined)[];
    anchor: LabelAnchor;
    placedRouteLabels: readonly PlacedRouteLabel[];
    vicinityPx?: number;
  },
): boolean {
  const identities = names
    .map((name) => (name ? normalizeLabelIdentity(name) : ""))
    .filter((identity) => identity.length > 0);
  if (identities.length === 0) return false;
  return placedRouteLabels.some((placed) => (
    placed.identity.length > 0
    && identities.includes(placed.identity)
    && Math.hypot(anchor.x - placed.anchor.x, anchor.y - placed.anchor.y) <= vicinityPx
  ));
}
