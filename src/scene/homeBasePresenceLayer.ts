import type { HomeBasePeriod } from "../journey/homeBase";
import {
  HOME_BASE_LAYER_EMPHASIS_CEILING,
  SELECTED_JOURNEY_EMPHASIS_WEIGHT,
  homeBaseAccessibleName,
  homeBaseLabel,
  type ResolvedHomeBasePresence,
} from "../journey/homeBasePresence";

export const HOME_BASE_TOUCH_TARGET_PX = 44;

export type HomeBasePresenceDrawable = {
  periodId: string;
  presence: Exclude<ResolvedHomeBasePresence["presence"], "absent">;
  anchor: ResolvedHomeBasePresence["anchor"];
  emphasisWeight: number;
  label: string | null;
  accessibleName: string;
  touchTargetPx: number;
};

export type ProjectedHomeBasePresence = {
  periodId: string;
  x: number;
  y: number;
  visible: boolean;
};

export function buildHomeBasePresenceLayer({
  presence,
  periods,
  effectiveDate,
}: {
  presence: readonly ResolvedHomeBasePresence[];
  periods: readonly HomeBasePeriod[];
  effectiveDate: string;
}): HomeBasePresenceDrawable[] {
  const periodsById = new Map(periods.map((period) => [period.id, period]));
  return presence.flatMap((resolved) => {
    if (resolved.presence === "absent") return [];
    const period = periodsById.get(resolved.periodId);
    if (!period) return [];
    const emphasisWeight = Math.min(
      resolved.emphasisWeight,
      HOME_BASE_LAYER_EMPHASIS_CEILING,
      Math.max(0, SELECTED_JOURNEY_EMPHASIS_WEIGHT - Number.EPSILON),
    );
    return [{
      periodId: resolved.periodId,
      presence: resolved.presence,
      anchor: resolved.anchor,
      emphasisWeight,
      label: resolved.labelVisible ? homeBaseLabel(period) : null,
      accessibleName: homeBaseAccessibleName(period, { periods, effectiveDate }),
      touchTargetPx: HOME_BASE_TOUCH_TARGET_PX,
    }];
  });
}
