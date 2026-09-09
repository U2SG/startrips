import { MOTION_REDUCED_QUERY } from "../motion/preferences";
import { motionTokens } from "../motion/tokens";
import { GEOGRAPHIC_SURFACE_RADIUS, routePointAnchor } from "../scene/geo";
import type { GlobeSemanticZoom } from "../scene/semanticZoom";
import { homeBasePeriodCoversDate, resolveHomeBaseForDate, type HomeBasePeriod } from "./homeBase";

export type HomeBasePresenceLevel = "current" | "period-context" | "trace" | "absent";

/**
 * V1 product decision from #233. These values compare Home periods with one
 * another inside the Home layer; they are deliberately not shader opacity.
 */
export const HOME_BASE_PRESENCE_WEIGHTS: Readonly<Record<HomeBasePresenceLevel, number>> = Object.freeze({
  current: 1,
  "period-context": 0.65,
  trace: 0.15,
  absent: 0,
});

/**
 * Home remains quieter than selected Journey focus by composing its relative
 * weight under the existing glow authority instead of inventing another
 * opacity scale. The active Journey uses the existing core emphasis; Home is
 * capped at the existing halo emphasis.
 */
export const SELECTED_JOURNEY_EMPHASIS_WEIGHT = motionTokens.glow.coreOpacity;
export const HOME_BASE_LAYER_EMPHASIS_CEILING = motionTokens.glow.haloOpacity;

export type HomeBaseTimelineContext =
  | { kind: "ordinary"; date: string }
  | { kind: "date"; date: string }
  | { kind: "all-time"; date: string };

export type ResolvedHomeBasePresence = {
  periodId: string;
  presence: HomeBasePresenceLevel;
  relativeWeight: number;
  emphasisWeight: number;
  latitude: number;
  longitude: number;
  anchor: ReturnType<typeof routePointAnchor>;
  labelVisible: boolean;
};

function labelVisibleAtZoom(semanticZoom: GlobeSemanticZoom): boolean {
  return semanticZoom !== "planet";
}

export function resolveEffectiveCurrentHomeBase(
  periods: readonly HomeBasePeriod[],
  date: string,
): HomeBasePeriod | null {
  return resolveHomeBaseForDate(periods, date);
}

function presenceForPeriod(
  period: HomeBasePeriod,
  timeline: HomeBaseTimelineContext,
  effectiveCurrentId: string | null,
): HomeBasePresenceLevel {
  if (timeline.kind === "ordinary") return period.id === effectiveCurrentId ? "current" : "absent";
  if (timeline.kind === "all-time") {
    if (period.id === effectiveCurrentId) return "current";
    return period.startedOn < timeline.date ? "trace" : "absent";
  }
  return homeBasePeriodCoversDate(period, timeline.date) ? "period-context" : "absent";
}

export function resolvedHomeBaseEmphasisWeight(presence: HomeBasePresenceLevel): number {
  return HOME_BASE_PRESENCE_WEIGHTS[presence] * HOME_BASE_LAYER_EMPHASIS_CEILING;
}

/**
 * Pure Atlas-side temporal presence resolver. Semantic zoom only decides label
 * disclosure; it never changes the geographic anchor or presence identity.
 */
export function resolveHomeBasePresence(input: {
  periods: readonly HomeBasePeriod[];
  semanticZoom: GlobeSemanticZoom;
  timeline: HomeBaseTimelineContext;
}): ResolvedHomeBasePresence[] {
  const effectiveCurrentId = input.timeline.kind === "date"
    ? null
    : resolveEffectiveCurrentHomeBase(input.periods, input.timeline.date)?.id ?? null;
  return input.periods.map((period) => {
    const presence = presenceForPeriod(period, input.timeline, effectiveCurrentId);
    const labelVisible = (presence === "current" || presence === "period-context")
      && labelVisibleAtZoom(input.semanticZoom);
    return {
      periodId: period.id,
      presence,
      relativeWeight: HOME_BASE_PRESENCE_WEIGHTS[presence],
      emphasisWeight: resolvedHomeBaseEmphasisWeight(presence),
      latitude: period.latitude,
      longitude: period.longitude,
      anchor: routePointAnchor(period.latitude, period.longitude, GEOGRAPHIC_SURFACE_RADIUS),
      labelVisible,
    };
  });
}

export function homeBaseLabel(period: Pick<HomeBasePeriod, "label">): string {
  return `常住地 · ${period.label}`;
}

export function homeBaseAccessibleName(
  period: Pick<HomeBasePeriod, "id" | "label" | "startedOn" | "endedOn">,
  context: { periods: readonly HomeBasePeriod[]; effectiveDate: string },
): string {
  const isEffectiveCurrent = resolveEffectiveCurrentHomeBase(context.periods, context.effectiveDate)?.id === period.id;
  if (isEffectiveCurrent) return `当前常住地：${period.label}，${period.startedOn} 起`;
  return period.endedOn === null
    ? `常住地：${period.label}，${period.startedOn} 起`
    : `常住地：${period.label}，${period.startedOn}–${period.endedOn}`;
}

export type HomeBaseMotionDescriptor = {
  presence: HomeBasePresenceLevel;
  ambientAnimation: "none";
  reducedMotion: boolean;
  reducedMotionQuery: typeof MOTION_REDUCED_QUERY;
};

/** V1 is intentionally static; reduced motion preserves the same Home identity. */
export function homeBaseMotionDescriptor(
  presence: HomeBasePresenceLevel,
  reducedMotion: boolean,
): HomeBaseMotionDescriptor {
  return {
    presence,
    ambientAnimation: "none",
    reducedMotion,
    reducedMotionQuery: MOTION_REDUCED_QUERY,
  };
}
